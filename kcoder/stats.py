"""Usage history, commit tracking and the numbers behind the stats view.

Sources of truth, all local files under the data dir so history survives
daemon restarts and app updates:

    usage.jsonl     one row per model call (written by the daemon as calls
                    finish; backfilled from session events.jsonl on start)
    commits.jsonl   one row per git commit made from a kcoder session
                    (detected at turn boundaries; backfilled from each
                    project's git log against the session's activity windows)
    sessions/*/     meta.json + events.jsonl: active agent time (turn
                    durations) and which session belongs to which project

Days roll over at local midnight: every row carries a local `date`.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import subprocess
import threading
import time

from . import paths, repos

log = logging.getLogger("kcoder.stats")

COMMITS_LOG_PATH = os.path.join(paths.DATA_DIR, "commits.jsonl")

_lock = threading.Lock()
_cache: dict = {"usage": None, "usage_sig": None, "commits": None, "commits_sig": None,
                "turns": {}, "turns_sig": {}, "pushed": {}, "pushed_at": {}}


def local_date(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def today() -> str:
    return dt.date.today().strftime("%Y-%m-%d")


def _sig(path: str):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _read_jsonl(path: str) -> list:
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return rows


def _append_jsonl(path: str, rows: list) -> None:
    if not rows:
        return
    paths.ensure_data_dir()
    with open(path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


# ----------------------------------------------------------------------
# usage rows
# ----------------------------------------------------------------------

def usage_rows() -> list:
    sig = _sig(paths.USAGE_LOG_PATH)
    with _lock:
        if _cache["usage"] is None or _cache["usage_sig"] != sig:
            rows = _read_jsonl(paths.USAGE_LOG_PATH)
            for r in rows:
                if "date" not in r and r.get("ts"):
                    r["date"] = local_date(r["ts"])
                if "plan" not in r:
                    r["plan"] = r.get("provider") == "claude"
            _cache["usage"], _cache["usage_sig"] = rows, sig
        return _cache["usage"]


def invalidate() -> None:
    with _lock:
        _cache["usage"] = None
        _cache["commits"] = None


# ----------------------------------------------------------------------
# sessions: meta + turn windows
# ----------------------------------------------------------------------

def session_metas() -> dict:
    """sid -> meta.json for every session on disk."""
    out = {}
    try:
        names = os.listdir(paths.SESSIONS_DIR)
    except OSError:
        return out
    for sid in names:
        try:
            with open(os.path.join(paths.SESSIONS_DIR, sid, "meta.json"), "r", encoding="utf-8") as f:
                meta = json.load(f)
            if isinstance(meta, dict) and not meta.get("deleted"):
                out[sid] = meta
        except (OSError, json.JSONDecodeError):
            continue
    return out


def turn_windows(sid: str) -> list:
    """[(start_ts, end_ts, elapsed)] for every finished turn of a session."""
    path = os.path.join(paths.SESSIONS_DIR, sid, "events.jsonl")
    sig = _sig(path)
    if sig is None:
        return []
    with _lock:
        if _cache["turns_sig"].get(sid) == sig:
            return _cache["turns"][sid]
    windows, start = [], None
    for ev in _read_jsonl(path):
        t = ev.get("t")
        if t == "turn_start":
            start = ev.get("ts")
        elif t == "turn_end":
            end = ev.get("ts") or 0
            elapsed = float(ev.get("elapsed") or 0)
            if start is None and elapsed:
                start = end - elapsed
            if start is not None:
                windows.append((start, end, elapsed or max(0.0, end - start)))
            start = None
    with _lock:
        _cache["turns"][sid] = windows
        _cache["turns_sig"][sid] = sig
    return windows


# ----------------------------------------------------------------------
# backfill usage from session event logs
# ----------------------------------------------------------------------

def backfill_usage() -> int:
    """Add usage rows for calls that are in a session's events.jsonl but not
    in usage.jsonl (older daemons, crashes mid-write). Returns rows added."""
    existing = {(r.get("sid"), round(float(r.get("ts") or 0), 2)) for r in usage_rows()}
    added = []
    for sid, meta in session_metas().items():
        path = os.path.join(paths.SESSIONS_DIR, sid, "events.jsonl")
        for ev in _read_jsonl(path):
            if ev.get("t") != "usage" or not ev.get("ts"):
                continue
            key = (sid, round(float(ev["ts"]), 2))
            if key in existing:
                continue
            existing.add(key)
            added.append({
                "ts": ev["ts"], "date": local_date(ev["ts"]), "sid": sid,
                "provider": meta.get("provider"), "model": ev.get("model") or meta.get("model"),
                "input": int(ev.get("input") or 0), "output": int(ev.get("output") or 0),
                "cache_read": int(ev.get("cache_read") or 0), "cache_write": int(ev.get("cache_write") or 0),
                "cost": float(ev.get("cost") or 0.0), "api_equivalent": float(ev.get("api_equivalent") or 0.0),
                "plan": bool(ev.get("plan")) or meta.get("provider") == "claude",
            })
    if added:
        added.sort(key=lambda r: r["ts"])
        _append_jsonl(paths.USAGE_LOG_PATH, added)
        invalidate()
    return len(added)


# ----------------------------------------------------------------------
# commits
# ----------------------------------------------------------------------

def _git(cwd: str, *args: str, timeout: int = 30) -> str | None:
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def head(cwd: str) -> str | None:
    out = _git(cwd, "rev-parse", "HEAD")
    return out.strip() if out else None


def repo_root(cwd: str) -> str | None:
    out = _git(cwd, "rev-parse", "--show-toplevel")
    return os.path.realpath(out.strip()) if out else None


def _main_root(cwd: str) -> str | None:
    """The main checkout for a worktree (commits belong to the project, not the worktree)."""
    out = _git(cwd, "rev-parse", "--git-common-dir")
    if not out:
        return repo_root(cwd)
    common = out.strip()
    if not os.path.isabs(common):
        common = os.path.join(cwd, common)
    common = os.path.realpath(common)
    return os.path.dirname(common) if os.path.basename(common) == ".git" else repo_root(cwd)


def _parse_log(text: str) -> list:
    """Parse `git log --format=%H%x1f%ct%x1f%an%x1f%s --numstat` output."""
    commits, cur = [], None
    for line in text.splitlines():
        if "\x1f" in line:
            if cur:
                commits.append(cur)
            sha, ct, author, subject = (line.split("\x1f") + ["", "", "", ""])[:4]
            cur = {"sha": sha, "ts": float(ct or 0), "author": author, "subject": subject[:200],
                   "insertions": 0, "deletions": 0, "files": 0}
        elif cur and line.strip():
            m = re.match(r"^(\d+|-)\t(\d+|-)\t", line)
            if m:
                cur["files"] += 1
                if m.group(1) != "-":
                    cur["insertions"] += int(m.group(1))
                if m.group(2) != "-":
                    cur["deletions"] += int(m.group(2))
    if cur:
        commits.append(cur)
    return commits


def commit_rows() -> list:
    sig = _sig(COMMITS_LOG_PATH)
    with _lock:
        if _cache["commits"] is None or _cache["commits_sig"] != sig:
            _cache["commits"], _cache["commits_sig"] = _read_jsonl(COMMITS_LOG_PATH), sig
        return _cache["commits"]


def _known_shas() -> set:
    return {r.get("sha") for r in commit_rows()}


def _row_for(c: dict, sid: str, root: str, branch: str | None, meta: dict | None) -> dict:
    return {
        "ts": c["ts"], "date": local_date(c["ts"]), "sha": c["sha"], "sid": sid,
        "session": (meta or {}).get("name"), "repo": root, "project": os.path.basename(root),
        "github": repos.github_spec(root), "branch": branch, "subject": c["subject"], "author": c["author"],
        "insertions": c["insertions"], "deletions": c["deletions"], "files": c["files"],
    }


def record_new_commits(sid: str, cwd: str, since_head: str | None, meta: dict | None = None) -> list:
    """Commits that appeared in `cwd` since `since_head` (the HEAD noted at
    turn start). Attributed to session `sid`. Returns the rows added."""
    now_head = head(cwd)
    if not now_head or not since_head or now_head == since_head:
        return []   # no baseline yet (no turn has run): only the caller's baseline moves
    root = _main_root(cwd) or repo_root(cwd)
    if not root:
        return []
    rng = f"{since_head}..HEAD" if since_head else "-n 20"
    out = _git(cwd, "log", f"--format=%H%x1f%ct%x1f%an%x1f%s", "--numstat", *rng.split())
    if not out:
        return []
    branch = (_git(cwd, "rev-parse", "--abbrev-ref", "HEAD") or "").strip() or None
    known = _known_shas()
    rows = [_row_for(c, sid, root, branch, meta) for c in _parse_log(out) if c["sha"] not in known]
    if rows:
        rows.sort(key=lambda r: r["ts"])
        _append_jsonl(COMMITS_LOG_PATH, rows)
        invalidate()
    return rows


def backfill_commits() -> int:
    """Attribute existing commits to the sessions that made them, using each
    session's turn windows (a commit inside a turn belongs to that session;
    one between turns of a single session in that repo belongs to it too)."""
    metas = session_metas()
    by_root: dict[str, list] = {}
    for sid, meta in metas.items():
        proj = meta.get("project") or {}
        cwd = meta.get("cwd") or proj.get("path")
        if not cwd or not os.path.isdir(cwd):
            continue
        root = _main_root(cwd) if proj.get("git") or os.path.isdir(os.path.join(cwd, ".git")) else None
        if not root:
            continue
        by_root.setdefault(root, []).append((sid, meta))
    known = _known_shas()
    added = []
    for root, sessions in by_root.items():
        earliest = min(float(m.get("created") or time.time()) for _, m in sessions)
        out = _git(root, "log", "--all", f"--since={int(earliest) - 60}", f"--format=%H%x1f%ct%x1f%an%x1f%s",
                   "--numstat", "-n", "2000", timeout=120)
        if not out:
            continue
        windows = []
        for sid, meta in sessions:
            spans = turn_windows(sid)
            created = float(meta.get("created") or 0)
            # a session can only own commits up to shortly after its last finished turn
            last = max([e for _, e, _ in spans] + [created])
            windows.append((sid, meta, spans, created, last))
        for c in _parse_log(out):
            if c["sha"] in known:
                continue
            ts = c["ts"]
            owner = None
            for sid, meta, spans, created, last in windows:
                if any(s - 5 <= ts <= e + 5 for s, e, _ in spans):
                    owner = (sid, meta)
                    break
            if owner is None:
                cands = [(sid, meta) for sid, meta, spans, created, last in windows if created - 60 <= ts <= last + 600]
                if len(cands) == 1:
                    owner = cands[0]
            if owner is None:
                continue
            known.add(c["sha"])
            added.append(_row_for(c, owner[0], root, None, owner[1]))
    if added:
        added.sort(key=lambda r: r["ts"])
        _append_jsonl(COMMITS_LOG_PATH, added)
        invalidate()
    return len(added)


def pushed_shas(root: str, max_age: float = 20.0) -> set:
    """Every commit reachable from a remote-tracking ref (local git only)."""
    now = time.time()
    with _lock:
        if now - _cache["pushed_at"].get(root, 0) < max_age:
            return _cache["pushed"][root]
    out = _git(root, "rev-list", "--remotes", "--max-count=20000", timeout=60) or ""
    shas = set(out.split())
    with _lock:
        _cache["pushed"][root] = shas
        _cache["pushed_at"][root] = now
    return shas


def commits_with_state(limit: int | None = None, since_date: str | None = None) -> list:
    rows = [r for r in commit_rows() if not since_date or r.get("date", "") >= since_date]
    rows.sort(key=lambda r: -float(r.get("ts") or 0))
    if limit:
        rows = rows[:limit]
    pushed_cache: dict[str, set] = {}
    out = []
    for r in rows:
        root = r.get("repo") or ""
        if root not in pushed_cache:
            pushed_cache[root] = pushed_shas(root) if os.path.isdir(root) else set()
        gh = r.get("github")
        out.append({**r, "pushed": r["sha"] in pushed_cache[root],
                    "url": f"https://github.com/{gh}/commit/{r['sha']}" if gh else None})
    return out


def backfill_all() -> dict:
    u = backfill_usage()
    c = backfill_commits()
    if u or c:
        log.info("stats backfill: %d usage rows, %d commits", u, c)
    return {"usage": u, "commits": c}


# ----------------------------------------------------------------------
# aggregates
# ----------------------------------------------------------------------

def _dates_back(n: int) -> list:
    d0 = dt.date.today()
    return [(d0 - dt.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n)]


def header_stats() -> dict:
    """The cheap numbers for the header strip: commits today and 7-day tokens."""
    week = _dates_back(7)
    tokens = {d: 0 for d in week}
    for r in usage_rows():
        d = r.get("date")
        if d in tokens:
            tokens[d] += int(r.get("input") or 0) + int(r.get("output") or 0)
    t = today()
    return {
        "commits_today": sum(1 for r in commit_rows() if r.get("date") == t),
        "week_tokens": [tokens[d] for d in reversed(week)],
        "week_dates": list(reversed(week)),
    }


def full(days: int = 30) -> dict:
    """Everything the stats view shows."""
    days = max(7, min(int(days or 30), 365))
    usage = usage_rows()
    commits = commits_with_state()
    metas = session_metas()
    t = today()

    def day_row(d: str) -> dict:
        return {"date": d, "input": 0, "output": 0, "total": 0, "cache_read": 0, "calls": 0, "sessions": 0,
                "commits": 0, "insertions": 0, "deletions": 0, "lines": 0, "active_seconds": 0.0,
                "cost": 0.0, "api_equivalent": 0.0, "pushed": 0, "unpushed": 0}

    per_day: dict[str, dict] = {}
    sessions_by_day: dict[str, set] = {}
    for r in usage:
        d = r.get("date") or local_date(r.get("ts") or 0)
        row = per_day.setdefault(d, day_row(d))
        i, o = int(r.get("input") or 0), int(r.get("output") or 0)
        row["input"] += i
        row["output"] += o
        row["total"] += i + o
        row["cache_read"] += int(r.get("cache_read") or 0)
        row["calls"] += 1
        row["cost"] += float(r.get("cost") or 0.0)
        row["api_equivalent"] += float(r.get("api_equivalent") or 0.0)
        sessions_by_day.setdefault(d, set()).add(r.get("sid"))
    for c in commits:
        d = c.get("date")
        row = per_day.setdefault(d, day_row(d))
        row["commits"] += 1
        row["insertions"] += int(c.get("insertions") or 0)
        row["deletions"] += int(c.get("deletions") or 0)
        row["lines"] += int(c.get("insertions") or 0) + int(c.get("deletions") or 0)
        row["pushed" if c.get("pushed") else "unpushed"] += 1
    for sid in metas:
        for s, e, elapsed in turn_windows(sid):
            d = local_date(e or s)
            row = per_day.setdefault(d, day_row(d))
            row["active_seconds"] += float(elapsed or 0)
            sessions_by_day.setdefault(d, set()).add(sid)
    for d, sids in sessions_by_day.items():
        per_day.setdefault(d, day_row(d))["sessions"] = len(sids)
    for row in per_day.values():
        row["cost"] = round(row["cost"], 4)
        row["api_equivalent"] = round(row["api_equivalent"], 4)
        row["active_seconds"] = round(row["active_seconds"])

    all_days = sorted(per_day.values(), key=lambda r: r["date"], reverse=True)
    window = _dates_back(days)
    series = [per_day.get(d) or day_row(d) for d in reversed(window)]

    def agg(rows: list) -> dict:
        out = day_row("")
        del out["date"]
        for r in rows:
            for k, v in r.items():
                if k != "date" and isinstance(v, (int, float)):
                    out[k] += v
        out["days"] = len(rows)
        return out

    def avg(rows: list, n: int) -> dict:
        s = agg(rows)
        return {k: (v / n if n else 0) for k, v in s.items() if k != "days"}

    d7, d30 = _dates_back(7), _dates_back(30)
    summary = {
        "today": agg([per_day.get(t) or day_row(t)]),
        "avg7": avg([per_day.get(d) or day_row(d) for d in d7], 7),
        "avg30": avg([per_day.get(d) or day_row(d) for d in d30], 30),
        "all": agg(all_days),
        "first_date": all_days[-1]["date"] if all_days else None,
    }

    # breakdowns over the selected window
    in_window = set(window)
    by_model: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    by_project: dict[str, dict] = {}
    by_session: dict[str, dict] = {}
    for r in usage:
        if r.get("date") not in in_window:
            continue
        i, o = int(r.get("input") or 0), int(r.get("output") or 0)
        cost, plan = float(r.get("cost") or 0.0), bool(r.get("plan"))
        api_eq = float(r.get("api_equivalent") or 0.0)
        model = r.get("model") or "?"
        prov = r.get("provider") or "?"
        meta = metas.get(r.get("sid")) or {}
        proj = (meta.get("project") or {}).get("name") or os.path.basename(meta.get("cwd") or "") or "?"
        for table, key in ((by_model, model), (by_provider, prov), (by_project, proj), (by_session, r.get("sid") or "?")):
            row = table.setdefault(key, {"key": key, "input": 0, "output": 0, "total": 0, "calls": 0, "cost": 0.0,
                                         "api_equivalent": 0.0, "plan": plan, "sessions": set()})
            row["input"] += i
            row["output"] += o
            row["total"] += i + o
            row["calls"] += 1
            row["cost"] += cost
            row["api_equivalent"] += api_eq
            row["plan"] = row["plan"] and plan
            row["sessions"].add(r.get("sid"))

    def finish(table: dict, extra=None) -> list:
        rows = []
        for row in table.values():
            row = dict(row)
            row["sessions"] = len(row["sessions"])
            row["cost"] = round(row["cost"], 4)
            row["api_equivalent"] = round(row["api_equivalent"], 4)
            if extra:
                row.update(extra(row))
            rows.append(row)
        rows.sort(key=lambda r: -r["total"])
        return rows

    for key, row in by_provider.items():
        row["billing"] = "subscription" if row["plan"] else "api key"

    def session_extra(row: dict) -> dict:
        meta = metas.get(row["key"]) or {}
        return {"name": meta.get("name"), "title": meta.get("title"),
                "project": (meta.get("project") or {}).get("name"), "model": meta.get("model"),
                "archived": bool(meta.get("archived")),
                "turns": len(turn_windows(row["key"])),
                "active_seconds": round(sum(e for _, _, e in turn_windows(row["key"])))}

    top_sessions = finish(by_session, session_extra)[:15]
    window_commits = [c for c in commits if c.get("date") in in_window]
    return {
        "days": days,
        "today": t,
        "summary": summary,
        "series": series,
        "daily": all_days,
        "by_model": finish(by_model),
        "by_provider": finish(by_provider),
        "by_project": finish(by_project),
        "top_sessions": top_sessions,
        "commits": window_commits[:300],
        "commit_totals": {"total": len(window_commits), "pushed": sum(1 for c in window_commits if c["pushed"]),
                          "unpushed": sum(1 for c in window_commits if not c["pushed"])},
        "generated": time.time(),
    }
