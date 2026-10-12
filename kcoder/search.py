"""Search across transcripts with filters.

Query syntax (the box in the app, `kcoder search`, request `search`):

    parser bug                    every word must appear (any order, any case)
    "exact phrase"                quoted = that phrase
    repo:kcoder                   project name or folder contains this
    since:2026-10-01  until:…     sessions active in that date range
    date:today | yesterday | 7d   shortcuts for since/until
    who:me | agent                only your messages, or only kcoder's

Hits carry the user-turn number so the app can jump to the message.
"""

from __future__ import annotations

import datetime as dt
import re
import time

from . import chatlog

_TOKEN = re.compile(r'(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)')
WHO = {"me": "you", "you": "you", "user": "you", "agent": "kcoder", "kcoder": "kcoder", "assistant": "kcoder", "ai": "kcoder"}


def _day(s: str) -> float | None:
    s = s.strip().strip('"').lower()
    today = dt.date.today()
    if s == "today":
        return time.mktime(today.timetuple())
    if s == "yesterday":
        return time.mktime((today - dt.timedelta(days=1)).timetuple())
    m = re.fullmatch(r"(\d+)\s*d(?:ays?)?", s)
    if m:
        return time.mktime((today - dt.timedelta(days=int(m.group(1)))).timetuple())
    m = re.fullmatch(r"(\d+)\s*w(?:eeks?)?", s)
    if m:
        return time.mktime((today - dt.timedelta(days=7 * int(m.group(1)))).timetuple())
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return time.mktime(dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).timetuple())
        except ValueError:
            return None
    return None


def parse(query: str) -> dict:
    """{terms: [...], repo, since, until, who} from the query text."""
    out: dict = {"terms": [], "repo": None, "since": None, "until": None, "who": None}
    for m in _TOKEN.finditer(query or ""):
        key, val, phrase, word = m.groups()
        if key:
            k, v = key.lower(), val.strip('"')
            if k in ("repo", "project", "in"):
                out["repo"] = v.lower()
            elif k in ("since", "after", "from"):
                out["since"] = _day(v)
            elif k in ("until", "before", "to"):
                t = _day(v)
                out["until"] = t + 86400 if t else None
            elif k in ("date", "on"):
                t = _day(v)
                if t is not None:
                    out["since"] = t
                    out["until"] = None if re.fullmatch(r"\d+\s*[dw]\w*", v.lower()) else t + 86400
            elif k == "who":
                out["who"] = WHO.get(v.lower())
            else:
                out["terms"].append(f"{key}:{v}".lower())
        elif phrase is not None:
            if phrase.strip():
                out["terms"].append(phrase.strip().lower())
        elif word:
            out["terms"].append(word.lower())
    return out


def message_hits(messages: list, terms: list, who: str | None = None, max_hits: int = 4) -> list:
    """Messages containing every term; snippet around the first term, plus the
    user-turn number the message belongs to (for jumping)."""
    if not terms:
        return []
    hits = []
    turn = -1
    for i, m in enumerate(messages):
        if m.get("role") == "user" and chatlog.is_user_turn(m):
            turn += 1
            text, role = chatlog.user_text(m), "you"
        elif m.get("role") == "assistant":
            text, role = chatlog.assistant_text(m), "kcoder"
        else:
            continue
        if who and role != who:
            continue
        low = text.lower()
        if not all(t in low for t in terms):
            continue
        pos = low.find(terms[0])
        start = max(0, pos - 60)
        end = min(len(text), pos + len(terms[0]) + 90)
        snippet = re.sub(r"\s+", " ", text[start:end]).strip()
        hits.append({"index": i, "turn": max(turn, 0), "who": role, "snippet": ("…" if start else "") + snippet + ("…" if end < len(text) else "")})
        if len(hits) >= max_hits:
            break
    return hits


def session_matches(meta: dict, f: dict) -> bool:
    """Repo and date filters on a session's meta."""
    if f.get("repo"):
        p = meta.get("project") or {}
        hay = " ".join(str(x) for x in (p.get("name"), p.get("path"), meta.get("cwd"), (meta.get("worktree") or {}).get("root"))).lower()
        if f["repo"] not in hay:
            return False
    last = float(meta.get("last_activity") or meta.get("created") or 0)
    first = float(meta.get("created") or last)
    if f.get("since") and last < f["since"]:
        return False
    if f.get("until") and first >= f["until"]:
        return False
    return True


def run(manager, query: str, project: str | None = None, limit: int = 50, **filters) -> dict:
    """Search every chat (live or archived). `filters` override the query's own repo/since/until/who."""
    from .daemon import load_messages, session_dir
    f = parse(query)
    for k in ("repo", "since", "until", "who"):
        if filters.get(k) not in (None, ""):
            f[k] = filters[k] if k != "who" else WHO.get(str(filters[k]).lower(), filters[k])
    if isinstance(f.get("since"), str):
        f["since"] = _day(f["since"])
    if isinstance(f.get("until"), str):
        t = _day(f["until"])
        f["until"] = t + 86400 if t else None
    results = []
    if not f["terms"] and not any(f.get(k) for k in ("repo", "since", "until")):
        return {"results": [], "filters": f}
    for m in manager.chats.values():
        if m.get("deleted"):
            continue
        if project and (m.get("project") or {}).get("id") != project:
            continue
        if not session_matches(m, f):
            continue
        sid = m["id"]
        session = manager.sessions.get(sid)
        messages = session.engine.messages if session else load_messages(session_dir(sid))
        hits = message_hits(messages, f["terms"], f.get("who")) if f["terms"] else []
        title_hit = bool(f["terms"]) and all(t in (m.get("title") or m.get("name") or "").lower() for t in f["terms"])
        if hits or title_hit or not f["terms"]:
            results.append({**manager.chat_summary(m), "hits": hits})
        if len(results) >= limit:
            break
    results.sort(key=lambda r: -float(r.get("last_activity") or 0))
    return {"results": results, "filters": f}
