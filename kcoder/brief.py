"""The morning brief: what every session did since you last looked, what is
waiting on you, what is in review.

Built from what kcoder already records: session meta (title, status, PR,
review flag, jobs), commits.jsonl, usage.jsonl, the task queue, plan usage,
and the last assistant reply of each session. `build()` returns data for the
app and the terminal; `to_markdown()` renders it.
"""

from __future__ import annotations

import collections
import datetime as dt
import os
import time

from . import stats


def _first_line(text: str, n: int = 160) -> str:
    for line in (text or "").splitlines():
        line = line.strip().lstrip("#*-> ").strip()
        if line and not line.startswith("```"):
            return line if len(line) <= n else line[: n - 1] + "…"
    return ""


def _last_reply(sdir: str) -> tuple[str, str]:
    """(last assistant reply's first line, last user prompt's first line) from the event tail."""
    from .daemon import load_events
    reply = prompt = ""
    for e in reversed(load_events(sdir, 400)):
        t = e.get("t")
        if not reply and t == "assistant_end" and e.get("text"):
            reply = _first_line(e["text"])
        elif not prompt and t == "user" and e.get("text") and not str(e["text"]).startswith(("Background job ", "CI failed on PR", "[Handoff from")):
            prompt = _first_line(e["text"])
        if reply and prompt:
            break
    return reply, prompt


def build(manager, since: float | None = None) -> dict:
    """since: unix time; default the last 24 hours."""
    from .daemon import session_dir
    from .providers import plan_usage
    now = time.time()
    since = float(since) if since else now - 24 * 3600
    live = manager.sessions
    commits = [c for c in stats.commit_rows() if float(c.get("ts") or 0) >= since]
    usage = [u for u in stats.usage_rows() if float(u.get("ts") or 0) >= since]
    by_sid_commits: dict = collections.defaultdict(list)
    for c in commits:
        by_sid_commits[c.get("sid")].append(c)
    by_sid_usage: dict = collections.defaultdict(lambda: {"input": 0, "output": 0, "calls": 0, "cost": 0.0})
    for u in usage:
        b = by_sid_usage[u.get("sid")]
        b["input"] += int(u.get("input") or 0)
        b["output"] += int(u.get("output") or 0)
        b["calls"] += 1
        b["cost"] += float(u.get("cost") or 0.0)
    tasks = getattr(manager, "tasks", None)
    task_by_sid = {t.get("sid"): t for t in (tasks.tasks if tasks else []) if t.get("sid")}

    sessions = []
    waiting = []
    review = []
    for meta in manager.chats.values():
        if meta.get("deleted"):
            continue
        sid = meta["id"]
        s = live.get(sid)
        snap = s.snapshot() if s else dict(meta)
        active = float(meta.get("last_activity") or 0) >= since or sid in by_sid_commits or sid in by_sid_usage
        pr = snap.get("pr") or {}
        status = snap.get("status") or ("archived" if meta.get("archived") else "idle")
        # what is waiting on you, regardless of the window
        if s and s.engine.pending_approval():
            desc = ""
            for e in reversed(list(getattr(s, "events", []))[-200:]):
                if e.get("t") == "approval_request" and e.get("id") == s.engine.pending_approval():
                    desc = e.get("description") or ""
                    break
            waiting.append({"kind": "approval", "sid": sid, "name": meta["name"], "text": desc or "a tool call needs your approval", "ts": meta.get("last_activity")})
        elif s and s.pending_review:
            waiting.append({"kind": s.pending_review.get("kind") or "review", "sid": sid, "name": meta["name"], "text": s.pending_review.get("description") or "waiting for your approval", "ts": s.pending_review.get("ts")})
        elif status == "waiting":
            waiting.append({"kind": "question", "sid": sid, "name": meta["name"], "text": meta.get("title") or "asked you something", "ts": meta.get("last_activity")})
        elif status == "error":
            waiting.append({"kind": "error", "sid": sid, "name": meta["name"], "text": "the last turn failed; open the details", "ts": meta.get("last_activity")})
        if snap.get("needs_review") or (task_by_sid.get(sid) or {}).get("status") == "review":
            review.append({"kind": "changes", "sid": sid, "name": meta["name"], "text": meta.get("title") or "changes wait for your review", "ts": meta.get("last_activity")})
        if pr.get("url") and pr.get("state") in (None, "OPEN"):
            review.append({"kind": "pr", "sid": sid, "name": meta["name"], "text": f"PR #{pr.get('number')} {pr.get('title') or ''}".strip(), "url": pr.get("url"),
                           "checks": pr.get("checks") or "none", "draft": bool(pr.get("draft")), "ts": pr.get("updated")})
        if not active:
            continue
        reply, prompt = _last_reply(session_dir(sid))
        u = by_sid_usage.get(sid) or {"input": 0, "output": 0, "calls": 0, "cost": 0.0}
        cs = by_sid_commits.get(sid) or []
        jobs = [j for j in (snap.get("jobs") or []) if j.get("status") in ("running", "lost")]
        sessions.append({
            "sid": sid, "name": meta["name"], "title": meta.get("title") or "", "project": (meta.get("project") or {}).get("name") or os.path.basename(meta.get("cwd") or ""),
            "status": status, "last_activity": meta.get("last_activity"), "branch": (meta.get("worktree") or {}).get("branch"),
            "did": reply, "asked": prompt, "turns": u["calls"], "tokens": u["input"] + u["output"], "cost": round(u["cost"], 4),
            "commits": [{"sha": c.get("sha", "")[:7], "subject": c.get("subject") or "", "files": c.get("files") or 0} for c in cs[-6:]],
            "commit_count": len(cs), "files": sum(int(c.get("files") or 0) for c in cs), "added": sum(int(c.get("insertions") or 0) for c in cs), "removed": sum(int(c.get("deletions") or 0) for c in cs),
            "pr": {"number": pr.get("number"), "url": pr.get("url"), "checks": pr.get("checks"), "state": pr.get("state"), "draft": pr.get("draft")} if pr.get("url") else None,
            "needs_review": bool(snap.get("needs_review")), "jobs": [{"id": j.get("id"), "name": j.get("name"), "status": j.get("status")} for j in jobs],
            "handed_off_to": meta.get("handed_off_to"), "issue": meta.get("issue"),
        })
    sessions.sort(key=lambda x: -(x.get("last_activity") or 0))
    waiting.sort(key=lambda x: x.get("ts") or 0)
    review.sort(key=lambda x: -(x.get("ts") or 0))
    tq = tasks.summary() if tasks else {"counts": {}, "tasks": []}
    t_since = [t for t in tq.get("tasks", []) if float(t.get("finished") or t.get("started") or t.get("created") or 0) >= since]
    try:
        plan = plan_usage()
    except Exception:  # noqa: BLE001
        plan = []
    return {
        "since": since, "until": now,
        "totals": {"sessions": len(sessions), "commits": len(commits), "files": sum(int(c.get("files") or 0) for c in commits),
                   "added": sum(int(c.get("insertions") or 0) for c in commits), "removed": sum(int(c.get("deletions") or 0) for c in commits),
                   "tokens": sum(int(u.get("input") or 0) + int(u.get("output") or 0) for u in usage), "cost": round(sum(float(u.get("cost") or 0) for u in usage), 4),
                   "turns": len(usage)},
        "waiting": waiting, "review": review, "sessions": sessions,
        "tasks": {"queued": tq["counts"].get("queued", 0), "running": tq["counts"].get("running", 0), "review": tq["counts"].get("review", 0),
                  "failed": sum(1 for t in t_since if t.get("status") == "failed"), "finished": sum(1 for t in t_since if t.get("status") in ("review", "failed", "cancelled")), "paused": tq.get("paused", False)},
        "plan": [{"limit": p["limit"], "label": p["label"], "utilization": p["utilization"], "resets_at": p.get("resets_at")} for p in plan if not p.get("stale")],
    }


def _when(ts: float | None) -> str:
    if not ts:
        return ""
    d = dt.datetime.fromtimestamp(ts)
    return d.strftime("%a %H:%M") if (dt.datetime.now() - d).days < 6 else d.strftime("%b %d")


def to_markdown(b: dict) -> str:
    t = b["totals"]
    lines = [f"# kcoder brief · since {_when(b['since'])}", "",
             f"{t['sessions']} session(s) active · {t['turns']} turn(s) · {t['tokens']:,} tokens · {t['commits']} commit(s), {t['files']} file(s), +{t['added']} / -{t['removed']}"
             + (f" · ${t['cost']:.2f} on API keys" if t.get("cost") else "")]
    if b.get("plan"):
        lines.append("Claude plan: " + ", ".join(f"{p['label']} {int(round(p['utilization'] * 100))}%" for p in b["plan"]))
    lines += ["", "## Waiting on you", ""]
    if b["waiting"]:
        for w in b["waiting"]:
            lines.append(f"- **{w['name']}** · {w['kind']}: {w['text']}")
    else:
        lines.append("Nothing.")
    lines += ["", "## In review", ""]
    if b["review"]:
        for r in b["review"]:
            extra = f" · checks {r['checks']}" + (" · draft" if r.get("draft") else "") if r["kind"] == "pr" else ""
            lines.append(f"- **{r['name']}** · {r['text']}{extra}" + (f" · {r['url']}" if r.get("url") else ""))
    else:
        lines.append("Nothing.")
    tq = b["tasks"]
    if any(tq.get(k) for k in ("queued", "running", "review", "failed")):
        lines += ["", f"Task queue: {tq['running']} running, {tq['queued']} queued, {tq['review']} in review, {tq['failed']} failed" + (" (paused)" if tq.get("paused") else "")]
    lines += ["", "## Sessions", ""]
    if not b["sessions"]:
        lines.append("No session was active.")
    for s in b["sessions"]:
        head = f"### {s['name']}" + (f" · {s['title']}" if s["title"] and s["title"] != s["name"] else "") + f"  ({s['project']}, {s['status']}, {_when(s['last_activity'])})"
        lines.append(head)
        if s.get("asked"):
            lines.append(f"- asked: {s['asked']}")
        if s.get("did"):
            lines.append(f"- last reply: {s['did']}")
        if s["commit_count"]:
            lines.append(f"- {s['commit_count']} commit(s), {s['files']} file(s), +{s['added']} / -{s['removed']}: " + "; ".join(c["subject"][:70] for c in s["commits"]))
        if s.get("pr"):
            lines.append(f"- PR #{s['pr']['number']}: checks {s['pr'].get('checks') or 'none'} · {s['pr']['url']}")
        if s.get("needs_review"):
            lines.append("- changes wait for your review")
        if s.get("jobs"):
            lines.append("- jobs: " + ", ".join(f"{j['name']} ({j['status']})" for j in s["jobs"]))
        if s.get("handed_off_to"):
            lines.append("- handed off to a fresh session")
        lines.append(f"- {s['turns']} turn(s), {s['tokens']:,} tokens")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
