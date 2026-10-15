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

from . import achievements, identity, paths, repos

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


def session_facts(sid: str) -> dict:
    """Everything the stats view needs from one session's events.jsonl, parsed
    once per file change: turn windows, tool calls, waits on the user,
    interrupts, undos and compactions. Timestamps are kept so callers can
    filter by date window."""
    path = os.path.join(paths.SESSIONS_DIR, sid, "events.jsonl")
    sig = _sig(path)
    empty = {"turns": [], "tools": [], "waits": [], "interrupts": [], "undos": [], "compactions": []}
    if sig is None:
        return empty
    with _lock:
        if _cache["turns_sig"].get(sid) == sig:
            return _cache["turns"][sid]
    f = {k: [] for k in empty}
    start = None
    calls: dict[str, tuple] = {}
    wait_since = None
    for ev in _read_jsonl(path):
        t = ev.get("t")
        ts = float(ev.get("ts") or 0)
        if t == "turn_start":
            start = ts
        elif t == "turn_end":
            elapsed = float(ev.get("elapsed") or 0)
            if start is None and elapsed:
                start = ts - elapsed
            if start is not None:
                f["turns"].append((start, ts, elapsed or max(0.0, ts - start), ev.get("result") or "ok"))
            if ev.get("result") == "interrupted":
                f["interrupts"].append(ts)
            start = None
        elif t == "tool_call":
            calls[ev.get("id")] = (ts, ev.get("name") or "tool")
        elif t == "tool_result":
            c = calls.pop(ev.get("id"), None)
            f["tools"].append((c[0] if c else ts, (c[1] if c else ev.get("name")) or "tool", bool(ev.get("is_error"))))
        elif t == "status":
            st = ev.get("status")
            if st == "waiting" and wait_since is None:
                wait_since = ts
            elif st != "waiting" and wait_since is not None:
                f["waits"].append((wait_since, max(0.0, ts - wait_since)))
                wait_since = None
        elif t == "history_reset":
            f["undos"].append(ts)
        elif t == "compaction":
            f["compactions"].append(ts)
    for cid, (ts, name) in calls.items():      # calls that never got a result (crash, interrupt)
        f["tools"].append((ts, name, False))
    with _lock:
        _cache["turns"][sid] = f
        _cache["turns_sig"][sid] = sig
    return f


def turn_windows(sid: str) -> list:
    """[(start_ts, end_ts, elapsed)] for every finished turn of a session."""
    return [(a, b, c) for a, b, c, _ in session_facts(sid)["turns"]]


# ----------------------------------------------------------------------
# model names: one row per model family, whatever alias or id was used
# ----------------------------------------------------------------------

_FAMILY_PRICE_ID = {"fable": "claude-fable-5-1", "opus": "claude-opus-4-8", "sonnet": "claude-sonnet-4-6", "haiku": "claude-haiku-4-5"}


def normalize_model(model: str | None) -> str:
    """'fable', 'Fable', 'claude-fable-5-1' and 'claude-fable-5' are all one
    model to the stats; other providers' ids are lower-cased."""
    m = (model or "?").strip().lower()
    for fam in ("fable", "mythos", "opus", "sonnet", "haiku"):
        if fam in m:
            return "fable" if fam == "mythos" else fam
    return m or "?"


def api_equivalent(r: dict) -> float:
    """What a usage row would have cost at API rates: the logged figure when
    the call reported one, else an estimate from the pricing table."""
    v = float(r.get("api_equivalent") or 0.0)
    if v:
        return v
    if not r.get("plan"):
        return float(r.get("cost") or 0.0)
    from . import pricing
    fam = normalize_model(r.get("model"))
    cr, cw = int(r.get("cache_read") or 0), int(r.get("cache_write") or 0)
    fresh = max(0, int(r.get("input") or 0) - cr - cw)
    return pricing.cost(_FAMILY_PRICE_ID.get(fam, r.get("model") or ""), fresh, int(r.get("output") or 0), cr, cw)


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
    """Parse `git log --format=%H%x1f%ct%x1f%an%x1f%ae%x1f%s --numstat` output."""
    commits, cur = [], None
    for line in text.splitlines():
        if "\x1f" in line:
            if cur:
                commits.append(cur)
            sha, ct, author, email, subject = (line.split("\x1f") + ["", "", "", "", ""])[:5]
            cur = {"sha": sha, "ts": float(ct or 0), "author": author, "author_email": email, "subject": subject[:200],
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
        "author_email": c.get("author_email") or "", "login": (identity.account() or {}).get("login"),
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
    out = _git(cwd, "log", f"--format=%H%x1f%ct%x1f%an%x1f%ae%x1f%s", "--numstat", *rng.split())
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
        out = _git(root, "log", "--all", f"--since={int(earliest) - 60}", f"--format=%H%x1f%ct%x1f%an%x1f%ae%x1f%s",
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
            row = _row_for(c, owner[0], root, None, owner[1])
            row["login"] = None            # backfilled: ownership comes from the author email alone
            added.append(row)
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


def my_commit_rows() -> list:
    """Commits that belong to the signed-in GitHub account (each person's
    numbers are their own). Signed out: nothing."""
    acct = identity.account()
    if not acct:
        return []
    return [r for r in commit_rows() if identity.matches(r.get("author_email"), r.get("login"), acct)]


def commits_with_state(limit: int | None = None, since_date: str | None = None) -> list:
    rows = [r for r in my_commit_rows() if not since_date or r.get("date", "") >= since_date]
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
        "commits_today": sum(1 for r in my_commit_rows() if r.get("date") == t),
        "week_tokens": [tokens[d] for d in reversed(week)],
        "week_dates": list(reversed(week)),
    }


def _median(xs: list) -> float:
    xs = sorted(xs)
    if not xs:
        return 0.0
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _split_hours(start: float, end: float, matrix: list) -> None:
    """Spread an active window over local (weekday, hour) cells, in seconds."""
    if end <= start:
        return
    t = start
    while t < end:
        d = dt.datetime.fromtimestamp(t)
        edge = (d.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1)).timestamp()
        seg = min(end, edge) - t
        matrix[d.weekday()][d.hour] += seg
        t = min(end, edge)


def _parallelism(windows: list) -> dict:
    """windows: [(start, end)] for one day. Peak overlap, average concurrency
    while anything ran, and agent-hours."""
    if not windows:
        return {"peak": 0, "avg": 0.0, "agent_seconds": 0.0, "busy_seconds": 0.0}
    edges = sorted([(s, 1) for s, _ in windows] + [(e, -1) for _, e in windows])
    cur = peak = 0
    busy = 0.0
    last = None
    for ts, d in edges:
        if cur > 0 and last is not None:
            busy += ts - last
        cur += d
        peak = max(peak, cur)
        last = ts
    agent = sum(max(0.0, e - s) for s, e in windows)
    return {"peak": peak, "avg": round(agent / busy, 2) if busy else 0.0, "agent_seconds": round(agent), "busy_seconds": round(busy)}


def full(days: int = 30, date: str | None = None) -> dict:
    """Everything the stats view shows. `days`: 1 = today, 0 = all time,
    else the last N days; `date` (YYYY-MM-DD) = that one day."""
    days = max(0, min(int(days if days is not None else 30), 3650))
    date = str(date)[:10] if date and re.match(r"^\d{4}-\d{2}-\d{2}$", str(date)) else None
    usage = usage_rows()
    commits = commits_with_state()
    metas = session_metas()
    facts = {sid: session_facts(sid) for sid in metas}
    t = today()
    now = time.time()

    def day_row(d: str) -> dict:
        return {"date": d, "input": 0, "fresh": 0, "output": 0, "total": 0, "cache_read": 0, "cache_write": 0, "calls": 0,
                "sessions": 0, "commits": 0, "insertions": 0, "deletions": 0, "net": 0, "lines": 0, "files": 0,
                "active_seconds": 0.0, "cost": 0.0, "api_equivalent": 0.0, "pushed": 0, "unpushed": 0}

    per_day: dict[str, dict] = {}
    sessions_by_day: dict[str, set] = {}
    for r in usage:
        d = r.get("date") or local_date(r.get("ts") or 0)
        row = per_day.setdefault(d, day_row(d))
        i, o = int(r.get("input") or 0), int(r.get("output") or 0)
        cr, cw = int(r.get("cache_read") or 0), int(r.get("cache_write") or 0)
        row["input"] += i
        row["fresh"] += max(0, i - cr - cw)
        row["output"] += o
        row["total"] += i + o
        row["cache_read"] += cr
        row["cache_write"] += cw
        row["calls"] += 1
        row["cost"] += float(r.get("cost") or 0.0)
        row["api_equivalent"] += api_equivalent(r)
        sessions_by_day.setdefault(d, set()).add(r.get("sid"))
    for c in commits:
        d = c.get("date")
        row = per_day.setdefault(d, day_row(d))
        ins, dele = int(c.get("insertions") or 0), int(c.get("deletions") or 0)
        row["commits"] += 1
        row["insertions"] += ins
        row["deletions"] += dele
        row["net"] += ins - dele
        row["lines"] += ins + dele
        row["files"] += int(c.get("files") or 0)
        row["pushed" if c.get("pushed") else "unpushed"] += 1
    for sid, f in facts.items():
        for s0, e, elapsed, _ in f["turns"]:
            d = local_date(e or s0)
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
    if date:
        window = [date]
    elif days == 0:
        first = all_days[-1]["date"] if all_days else t
        span = (dt.date.fromisoformat(t) - dt.date.fromisoformat(first)).days + 1
        window = _dates_back(max(1, min(span, 3650)))
    else:
        window = _dates_back(days)
    series = [per_day.get(d) or day_row(d) for d in reversed(window)][-365:]

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
    window_totals = agg([per_day.get(d) or day_row(d) for d in window])
    first_date = all_days[-1]["date"] if all_days else None
    # averages divide by the days that can have data: when history is shorter than the
    # window, by the days since the first record (the app says "(N days of data)")
    history_days = (dt.date.fromisoformat(t) - dt.date.fromisoformat(first_date)).days + 1 if first_date else 0
    def avg_days(n: int) -> int:
        return max(1, min(n, history_days)) if history_days else max(1, n)
    w_days, a7_days, a30_days = avg_days(len(window)), avg_days(7), avg_days(30)
    # the previous equal period, for "vs prior N days" (none for all time)
    prev_dates: list = []
    if date:
        prev_dates = [(dt.date.fromisoformat(date) - dt.timedelta(days=1)).strftime("%Y-%m-%d")]
    elif days != 0:
        start = dt.date.fromisoformat(window[-1])
        prev_dates = [(start - dt.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, len(window) + 1)]
    prev_totals = agg([per_day.get(d) or day_row(d) for d in prev_dates]) if prev_dates else None
    summary = {
        "window": window_totals,
        "window_avg": {k: (v / w_days) for k, v in window_totals.items() if k != "days"},
        "window_avg_days": w_days,
        "today": agg([per_day.get(t) or day_row(t)]),
        "avg7": avg([per_day.get(d) or day_row(d) for d in d7], a7_days),
        "avg7_days": a7_days,
        "avg30": avg([per_day.get(d) or day_row(d) for d in d30], a30_days),
        "avg30_days": a30_days,
        "all": agg(all_days),
        "first_date": first_date,
        "history_days": history_days,
        "prev": prev_totals,
        "prev_days": len(prev_dates),
        "prev_has_data": bool(prev_dates) and bool(first_date) and prev_dates[-1] >= first_date,
    }

    # ---- breakdowns over the selected window ----
    in_window = set(window)
    win_start = min(in_window)

    def proj_name(sid: str) -> str:
        meta = metas.get(sid) or {}
        return (meta.get("project") or {}).get("name") or os.path.basename(meta.get("cwd") or "") or "?"

    def blank(key: str) -> dict:
        return {"key": key, "input": 0, "fresh": 0, "output": 0, "total": 0, "cache_read": 0, "cache_write": 0, "calls": 0,
                "cost": 0.0, "api_equivalent": 0.0, "plan": True, "sessions": set(),
                "commits": 0, "insertions": 0, "deletions": 0, "net": 0, "files": 0}

    by_model: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    by_project: dict[str, dict] = {}
    by_session: dict[str, dict] = {}
    model_tokens_by_sid: dict[str, dict] = {}
    for r in usage:
        if r.get("date") not in in_window:
            continue
        i, o = int(r.get("input") or 0), int(r.get("output") or 0)
        cr, cw = int(r.get("cache_read") or 0), int(r.get("cache_write") or 0)
        cost, plan = float(r.get("cost") or 0.0), bool(r.get("plan"))
        model = normalize_model(r.get("model"))
        prov = r.get("provider") or "?"
        sid = r.get("sid") or "?"
        model_tokens_by_sid.setdefault(sid, {})[model] = model_tokens_by_sid.setdefault(sid, {}).get(model, 0) + i + o
        for table, key in ((by_model, model), (by_provider, prov), (by_project, proj_name(sid)), (by_session, sid)):
            row = table.setdefault(key, blank(key))
            row["input"] += i
            row["fresh"] += max(0, i - cr - cw)
            row["output"] += o
            row["total"] += i + o
            row["cache_read"] += cr
            row["cache_write"] += cw
            row["calls"] += 1
            row["cost"] += cost
            row["api_equivalent"] += api_equivalent(r)
            row["plan"] = row["plan"] and plan
            row["sessions"].add(sid)

    def dominant_model(sid: str) -> str:
        mt = model_tokens_by_sid.get(sid)
        if mt:
            return max(mt.items(), key=lambda kv: kv[1])[0]
        return normalize_model((metas.get(sid) or {}).get("model"))

    window_commits = [c for c in commits if c.get("date") in in_window]
    for c in window_commits:
        sid = c.get("sid") or "?"
        ins, dele = int(c.get("insertions") or 0), int(c.get("deletions") or 0)
        for table, key in ((by_model, dominant_model(sid)), (by_project, c.get("project") or proj_name(sid)), (by_session, sid)):
            row = table.setdefault(key, blank(key))
            row["commits"] += 1
            row["insertions"] += ins
            row["deletions"] += dele
            row["net"] += ins - dele
            row["files"] += int(c.get("files") or 0)
            row["sessions"].add(sid)

    def finish(table: dict, extra=None) -> list:
        rows = []
        for row in table.values():
            row = dict(row)
            row["sessions"] = len(row["sessions"])
            row["cost"] = round(row["cost"], 4)
            row["api_equivalent"] = round(row["api_equivalent"], 4)
            row["cache_hit"] = round(row["cache_read"] / row["input"], 4) if row["input"] else 0.0
            shipped = row["insertions"] + row["deletions"]
            row["tokens_per_line"] = round(row["total"] / shipped, 1) if shipped else None
            if extra:
                row.update(extra(row))
            rows.append(row)
        rows.sort(key=lambda r: -r["total"])
        return rows

    for key, row in by_provider.items():
        row["billing"] = "subscription" if row["plan"] else "api key"

    def session_extra(row: dict) -> dict:
        meta = metas.get(row["key"]) or {}
        f = facts.get(row["key"]) or session_facts(row["key"])
        return {"name": meta.get("name"), "title": meta.get("title"),
                "project": (meta.get("project") or {}).get("name"), "model": dominant_model(row["key"]),
                "archived": bool(meta.get("archived")),
                "turns": len(f["turns"]),
                "active_seconds": round(sum(e for _, _, e, _ in f["turns"]))}

    top_sessions = finish(by_session, session_extra)[:15]

    # ---- cache split (window) ----
    wu = [r for r in usage if r.get("date") in in_window]
    cache = {"input": sum(int(r.get("input") or 0) for r in wu),
             "cache_read": sum(int(r.get("cache_read") or 0) for r in wu),
             "cache_write": sum(int(r.get("cache_write") or 0) for r in wu)}
    cache["fresh"] = max(0, cache["input"] - cache["cache_read"] - cache["cache_write"])
    cache["hit_rate"] = round(cache["cache_read"] / cache["input"], 4) if cache["input"] else 0.0
    cache["api_equivalent"] = round(sum(api_equivalent(r) for r in wu), 4)
    cache["plan_api_equivalent"] = round(sum(api_equivalent(r) for r in wu if r.get("plan")), 4)
    cache["cost"] = round(sum(float(r.get("cost") or 0.0) for r in wu), 4)

    # ---- activity calendar: last 365 days, streaks ----
    year = _dates_back(365)
    calendar = [{"date": d, "tokens": (per_day.get(d) or {}).get("total", 0), "lines": (per_day.get(d) or {}).get("lines", 0),
                 "commits": (per_day.get(d) or {}).get("commits", 0)} for d in reversed(year)]
    active_days = {r["date"] for r in all_days if r["total"] or r["commits"] or r["active_seconds"]}
    streak = 0
    for d in _dates_back(400):
        if d in active_days:
            streak += 1
        elif d != t:          # today not counting yet does not break the streak
            break
    longest = run = 0
    prev = None
    for d in sorted(active_days):
        day = dt.date.fromisoformat(d)
        run = run + 1 if prev is not None and (day - prev).days == 1 else 1
        longest = max(longest, run)
        prev = day
    streaks = {"current": streak, "longest": longest, "active_days": len(active_days)}

    # ---- hour-of-day / day-of-week, parallelism, waiting, tools, health (window) ----
    hours = [[0.0] * 24 for _ in range(7)]
    windows_by_day: dict[str, list] = {}
    waits: list = []
    tools: dict[str, dict] = {}
    health = {"interrupts": 0, "undos": 0, "compactions": 0, "sessions_no_commit": 0, "sessions_with_turns": 0}
    longest_turn = None
    sids_with_commits = {c.get("sid") for c in window_commits}
    for sid, f in facts.items():
        had_turn = False
        for s0, e, elapsed, result in f["turns"]:
            if local_date(e) not in in_window:
                continue
            had_turn = True
            _split_hours(s0, e, hours)
            windows_by_day.setdefault(local_date(e), []).append((s0, e))
            if longest_turn is None or elapsed > longest_turn["seconds"]:
                longest_turn = {"sid": sid, "name": (metas.get(sid) or {}).get("name"), "seconds": round(elapsed), "date": local_date(e)}
        if had_turn:
            health["sessions_with_turns"] += 1
            if sid not in sids_with_commits:
                health["sessions_no_commit"] += 1
        for ws, secs in f["waits"]:
            if local_date(ws) in in_window and secs < 24 * 3600:
                waits.append(secs)
        for ts, name, err in f["tools"]:
            if local_date(ts) in in_window:
                row = tools.setdefault(name, {"name": name, "count": 0, "errors": 0})
                row["count"] += 1
                row["errors"] += 1 if err else 0
        health["interrupts"] += sum(1 for ts in f["interrupts"] if local_date(ts) in in_window)
        health["undos"] += sum(1 for ts in f["undos"] if local_date(ts) in in_window)
        health["compactions"] += sum(1 for ts in f["compactions"] if local_date(ts) in in_window)
    hours = [[round(x) for x in row] for row in hours]
    par_days = [{"date": d, **_parallelism(w)} for d, w in sorted(windows_by_day.items())]
    parallel = {"days": par_days,
                "avg_peak": round(sum(p["peak"] for p in par_days) / len(par_days), 2) if par_days else 0,
                "max_peak": max((p["peak"] for p in par_days), default=0),
                "avg_concurrency": round(sum(p["avg"] for p in par_days) / len(par_days), 2) if par_days else 0,
                "agent_hours": round(sum(p["agent_seconds"] for p in par_days) / 3600, 1)}
    waiting = {"total_seconds": round(sum(waits)), "median_seconds": round(_median(waits)), "count": len(waits)}
    tool_rows = sorted(tools.values(), key=lambda r: -r["count"])
    for r in tool_rows:
        r["error_rate"] = round(r["errors"] / r["count"], 4) if r["count"] else 0.0

    # ---- records (window) ----
    biggest = max(window_commits, key=lambda c: int(c.get("insertions") or 0) + int(c.get("deletions") or 0), default=None)
    win_days = [per_day[d] for d in in_window if d in per_day]
    most_tokens = max(win_days, key=lambda r: r["total"], default=None)
    most_lines = max(win_days, key=lambda r: r["lines"], default=None)
    records = {
        "biggest_commit": {"sha": biggest["sha"], "lines": int(biggest.get("insertions") or 0) + int(biggest.get("deletions") or 0),
                           "insertions": biggest.get("insertions"), "deletions": biggest.get("deletions"), "date": biggest.get("date"),
                           "url": biggest.get("url"), "project": biggest.get("project"), "subject": biggest.get("subject")} if biggest else None,
        "longest_turn": longest_turn,
        "most_tokens_day": {"date": most_tokens["date"], "tokens": most_tokens["total"]} if most_tokens and most_tokens["total"] else None,
        "most_lines_day": {"date": most_lines["date"], "lines": most_lines["lines"]} if most_lines and most_lines["lines"] else None,
    }

    return {
        "days": days,
        "date": date,
        "window": {"start": window[-1], "end": window[0], "n": len(window)},
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
        "cache": cache,
        "calendar": calendar,
        "streaks": streaks,
        "hours": hours,
        "parallel": parallel,
        "waiting": waiting,
        "tools": tool_rows,
        "health": health,
        "records": records,
        "achievements": achievements.compute(all_days, facts, metas, commits, first_date, t, _cfg_plan_price()),
        "generated": now,
    }


CSV_COLUMNS = ["date", "input", "fresh", "cache_read", "cache_write", "output", "total", "calls", "sessions", "commits",
               "insertions", "deletions", "net", "files", "active_seconds", "cost", "api_equivalent", "pushed", "unpushed"]
_CSV_MONEY = {"cost", "api_equivalent"}


def csv_export(days: int = 30, date: str | None = None) -> dict:
    """The daily table of the stats page as CSV text for the same range
    (`days`: 1 = today, 0 = all time, else the last N days; `date` = one
    day), oldest day first, one row for every day of the range with zeros
    on days that had no activity, money rounded to cents. Returns the text,
    a file name like kcoder-stats-2026-10-15-7d.csv and the row count."""
    import csv
    import io
    f = full(days, date)
    by_date = {r["date"]: r for r in f["daily"]}
    start, end = dt.date.fromisoformat(f["window"]["start"]), dt.date.fromisoformat(f["window"]["end"])
    rows = []
    d = start
    while d <= end:
        key = d.strftime("%Y-%m-%d")
        r = by_date.get(key) or {"date": key}
        rows.append([key] + [f"{float(r.get(c) or 0):.2f}" if c in _CSV_MONEY else int(r.get(c) or 0) for c in CSV_COLUMNS[1:]])
        d += dt.timedelta(days=1)
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(CSV_COLUMNS)
    w.writerows(rows)
    if f["date"]:
        tag = f["date"]
    else:
        n = f["days"]
        tag = f"{f['today']}-" + ("today" if n == 1 else "all" if n == 0 else f"{n}d")
    return {"csv": out.getvalue(), "filename": f"kcoder-stats-{tag}.csv", "rows": len(rows),
            "start": f["window"]["start"], "end": f["window"]["end"]}


def _cfg_plan_price() -> float | None:
    try:
        from . import config
        v = config.load().get("plan_price_usd")
        return float(v) if v else None
    except Exception:  # noqa: BLE001
        return None
