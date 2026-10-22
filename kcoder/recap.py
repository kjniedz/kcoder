"""Where we left off: a short recap of a session for when you come back to
it after a day or an app restart.

The model-written part (what was done, what is pending, open decisions) is
written by a cheap model from the transcript tail and the session's
commits, then cached in <session dir>/recap.json. It is only written again
when the session has new activity (another turn or message); the branch
state (uncommitted changes, unpushed commits, open PR) is read live from
git every time because it is cheap and changes outside the session.

Claude sessions write the recap with Haiku on the plan through Claude Code
with no tools and no session persistence, so it never spends credits and
never touches the session's own Claude Code history.
"""

from __future__ import annotations

import json
import os
import time

from . import chatlog, routing, stats, worktree

MAX_EXCERPT = 14_000
MAX_ITEM = 1_500

RECAP_SYSTEM = (
    "You write a very short 'where we left off' recap of a coding session for the person who ran it. "
    "Use only what is in the transcript and the facts given; never invent. Do not use any tools. "
    "Answer in markdown with exactly these two headings, each followed by 1 to 3 bullets of at most "
    "fifteen words (plain sentences, no sub-bullets, no preamble, no closing line):\n"
    "### Done\n### Next\n"
    "Under Next put what is still to do and any question the person still has to answer. "
    "Name files, commands and branches exactly as they appear. Keep the whole recap under 60 words."
)


class _Hooks:
    """Collects the streamed text and refuses tools (one model call, no side effects)."""

    def __init__(self, cwd: str, trust: str = "read"):
        self.text = ""
        self.usage_in = self.usage_out = 0
        self.cwd = cwd
        self.trust = trust
        self.sid = None                       # no approval hook, no settings
        self.claude_args = ["--tools", "", "--no-session-persistence"]
        self.proc = None

    def on_stream(self, it):
        for piece in it:
            self.text += piece or ""

    def usage(self, i, o, **kw):
        self.usage_in += int(i or 0)
        self.usage_out += int(o or 0)

    def handle_tool_call(self, name, tool_input, call_id=None):
        return "Tools are unavailable while writing the recap.", True

    def notice(self, m):
        pass

    def info(self, m):
        pass


def _path(sdir: str) -> str:
    return os.path.join(sdir, "recap.json")


def load(sdir: str) -> dict | None:
    try:
        with open(_path(sdir), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) and data.get("text") else None
    except (OSError, ValueError):
        return None


def _save(sdir: str, data: dict) -> None:
    os.makedirs(sdir, exist_ok=True)
    tmp = _path(sdir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _path(sdir))


def fingerprint(session) -> str:
    """Changes only with new activity: another turn, or a message added or removed."""
    turns = int((session.meta.get("usage") or {}).get("turns") or 0)
    return f"{turns}:{len(session.engine.messages)}"


def branch_state(session) -> dict:
    """Live git facts: branch, uncommitted files, unpushed commits, the PR."""
    cwd = session.engine.cwd
    out: dict = {"git": False}
    if not os.path.isdir(cwd):
        return out
    try:
        if not stats.repo_root(cwd):
            return out
        st = worktree.status(cwd)
    except Exception:  # noqa: BLE001 - git trouble must not hide the recap
        return out
    out.update(git=True, branch=st.get("branch"), dirty=int(st.get("dirty") or 0), unpushed=int(st.get("ahead") or 0),
               behind=int(st.get("behind") or 0), last_commit=st.get("last_commit") or "")
    pr = session.meta.get("pr") or {}
    if pr.get("url"):
        out["pr"] = {"number": pr.get("number"), "url": pr.get("url"), "state": pr.get("state") or "OPEN", "checks": pr.get("checks"), "draft": bool(pr.get("draft"))}
    return out


def excerpt(messages: list, limit: int = MAX_EXCERPT) -> str:
    """The first prompt plus the newest exchanges that fit the budget."""
    items = []
    for m in messages:
        if m.get("role") == "user" and chatlog.is_user_turn(m):
            t = chatlog.user_text(m).strip()
            if t:
                items.append(("User", t))
        elif m.get("role") == "assistant":
            t = chatlog.assistant_text(m).strip()
            if t:
                items.append(("Assistant", t))
    if not items:
        return ""
    first = items[0]
    tail: list = []
    size = len(first[1][:MAX_ITEM])
    for who, t in reversed(items[1:]):
        t = t if len(t) <= MAX_ITEM else t[:MAX_ITEM] + " …"
        if size + len(t) > limit:
            break
        tail.append((who, t))
        size += len(t)
    tail.reverse()
    parts = [f"{first[0]} (first message): {first[1][:MAX_ITEM]}"]
    if len(items) - 1 > len(tail):
        parts.append(f"[{len(items) - 1 - len(tail)} earlier exchanges omitted]")
    parts += [f"{who}: {t}" for who, t in tail]
    return "\n\n".join(parts)


def prompt_for(session, branch: dict) -> str:
    sid = session.id
    commits = [c for c in stats.commit_rows() if c.get("sid") == sid][-8:]
    facts = [f"Session: {session.meta.get('name')}" + (f" · {session.meta.get('title')}" if session.meta.get("title") else ""),
             f"Project: {(session.meta.get('project') or {}).get('name') or os.path.basename(session.engine.cwd)}"]
    if branch.get("git"):
        facts.append(f"Branch: {branch.get('branch')} · {branch.get('dirty', 0)} uncommitted file(s) · {branch.get('unpushed', 0)} unpushed commit(s)")
    if branch.get("pr"):
        facts.append(f"PR #{branch['pr'].get('number')} {branch['pr'].get('state')} · checks {branch['pr'].get('checks') or 'none'}")
    if commits:
        facts.append("Commits from this session: " + "; ".join(str(c.get("subject") or "")[:80] for c in commits))
    return ("Facts:\n" + "\n".join(facts) + "\n\nTranscript (newest last):\n\n" + excerpt(session.engine.messages)
            + "\n\nWrite the recap now.")


def pick_model(session) -> tuple:
    """(backend, model): the cheap tier of the session's provider; Haiku on the plan for Claude."""
    provider = session.engine.provider
    cfg = getattr(session.manager, "cfg", None)
    if provider.kind == "claude":
        from .providers import ClaudeCodeBackend
        return ClaudeCodeBackend(provider), "haiku"
    small = routing.tiers_for(provider, cfg).get("small")
    return session.engine.backend, small or provider.default_model


def generate(session) -> dict:
    """One cheap model call. Returns the saved recap record."""
    branch = branch_state(session)
    backend, model = pick_model(session)
    hooks = _Hooks(session.engine.cwd)
    started = time.time()
    backend.run_turn([{"role": "user", "content": prompt_for(session, branch)}], model, RECAP_SYSTEM, hooks)
    text = hooks.text.strip()
    if not text:
        raise RuntimeError("the model wrote an empty recap")
    rec = {"text": text, "at": time.time(), "fp": fingerprint(session), "model": f"{session.engine.provider.id}/{model}",
           "dismissed": False, "usage": {"input": hooks.usage_in, "output": hooks.usage_out, "elapsed": round(time.time() - started, 2)}}
    _save(session.dir, rec)
    return rec


def build(session, force: bool = False) -> dict:
    """The recap for the app: cached when the session has had no new activity."""
    cached = load(session.dir)
    fp = fingerprint(session)
    if cached and cached.get("fp") == fp and not force:
        rec, fresh = cached, False
    else:
        rec, fresh = generate(session), True
    idle = max(0.0, time.time() - float(session.meta.get("last_activity") or 0))
    return {**rec, "cached": not fresh, "branch": branch_state(session), "idle_seconds": idle, "sid": session.id}


def dismiss(session) -> dict | None:
    cached = load(session.dir)
    if not cached:
        return None
    cached["dismissed"] = True
    _save(session.dir, cached)
    return cached


def peek(session) -> dict | None:
    """The cached recap with its freshness, without ever calling a model."""
    cached = load(session.dir)
    if not cached:
        return None
    return {**cached, "stale": cached.get("fp") != fingerprint(session), "sid": session.id}
