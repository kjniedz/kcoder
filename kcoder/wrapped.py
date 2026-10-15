"""kcoder Wrapped: a weekly recap every Monday and a monthly one on the 1st,
plus any period on demand. Built on stats.full() over an exact date range so
every number matches the stats page for the same range.

Cards are kept in <data dir>/wrapped/<key>.json (key: 2026-W42 or 2026-10)
so the archive on the stats page never recomputes history, and "due" cards
(a finished week or month not yet shown) are offered once when the app opens.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import time

from . import stats, paths

DIR = os.path.join(paths.DATA_DIR, "wrapped")
SEEN_PATH = os.path.join(DIR, "seen.json")
_KEY = re.compile(r"^(\d{4})-(W(\d{2})|(\d{2}))$")

# the fun equivalents: (unit, tokens or lines per unit, label) - the first one that gives at least 1
TOKEN_FUN = [("the whole Harry Potter series", 1_400_000, "copies of the whole Harry Potter series"), ("War and Peace", 780_000, "copies of War and Peace"),
             ("a novel", 100_000, "novels' worth of text"), ("a newspaper", 25_000, "newspapers' worth of text")]
LINE_FUN = [("the Linux kernel's drivers", 2_000_000, "× the Linux kernel's driver tree"), ("Doom", 60_000, "× the original Doom source"),
            ("a printed page", 55, "printed pages of code")]


def week_key(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def month_key(d: dt.date) -> str:
    return f"{d.year}-{d.month:02d}"


def period_of(key: str) -> tuple[str, str, str]:
    """(kind, start, end) for a key: 2026-W42 → Monday..Sunday, 2026-10 → the month."""
    m = _KEY.match(key or "")
    if not m:
        raise ValueError(f"bad wrapped key: {key!r}")
    year = int(m.group(1))
    if m.group(3):
        start = dt.date.fromisocalendar(year, int(m.group(3)), 1)
        return "week", start.isoformat(), (start + dt.timedelta(days=6)).isoformat()
    month = int(m.group(4))
    start = dt.date(year, month, 1)
    end = (dt.date(year + (month == 12), (month % 12) + 1, 1) - dt.timedelta(days=1))
    return "month", start.isoformat(), end.isoformat()


def current_keys(today: dt.date | None = None) -> dict:
    """The keys the app offers: this week / last week / this month / last month."""
    d = today or dt.date.today()
    last_week = d - dt.timedelta(days=7)
    first = d.replace(day=1)
    last_month = first - dt.timedelta(days=1)
    return {"this_week": week_key(d), "last_week": week_key(last_week), "this_month": month_key(d), "last_month": month_key(last_month)}


def due(today: dt.date | None = None) -> list:
    """Finished periods to show once: last week on a Monday, last month on the 1st (a missed Monday or 1st
    still counts for the rest of that week / month)."""
    d = today or dt.date.today()
    seen = _seen()
    out = []
    keys = current_keys(d)
    if keys["last_week"] not in seen:
        out.append(keys["last_week"])
    if d.day <= 7 and keys["last_month"] not in seen:     # the first week of the month: last month's card
        out.append(keys["last_month"])
    return out


def _seen() -> dict:
    try:
        with open(SEEN_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def mark_seen(key: str) -> None:
    os.makedirs(DIR, exist_ok=True)
    data = _seen()
    data[key] = time.time()
    tmp = SEEN_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, SEEN_PATH)


def _path(key: str) -> str:
    return os.path.join(DIR, f"{key}.json")


def load(key: str) -> dict | None:
    try:
        with open(_path(key), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def archive() -> list:
    """Every card on disk, newest period first (short rows for the list)."""
    out = []
    if not os.path.isdir(DIR):
        return out
    for name in os.listdir(DIR):
        if not name.endswith(".json") or name == "seen.json":
            continue
        card = load(name[:-5])
        if card:
            out.append({k: card.get(k) for k in ("key", "kind", "start", "end", "generated", "tokens", "commits", "lines_added", "lines_removed", "top_repo", "complete")})
    out.sort(key=lambda c: (c.get("start") or ""), reverse=True)
    return out


def fun_line(tokens: int, lines: int) -> str:
    for _name, per, label in TOKEN_FUN:
        if tokens >= per:
            n = tokens / per
            return f"{n:.1f} {label}" if n < 10 else f"{int(round(n))} {label}"
    for _name, per, label in LINE_FUN:
        if lines >= per:
            n = lines / per
            return f"{n:.1f} {label}" if n < 10 else f"{int(round(n))} {label}"
    return f"{tokens:,} tokens: a short story's worth" if tokens else "a quiet period"


def build(key: str, verb: dict | None = None, plan_price: float | None = None) -> dict:
    """Compute the card for a period and keep it. `verb` is the most-shown working verb
    the browser counted ({name, count}); the daemon has no view of that."""
    kind, start, end = period_of(key)
    today = dt.date.today().isoformat()
    f = stats.full(0, None, start=start, end=min(end, today) if end > today else end)
    S = f["summary"]["window"]
    projects = f.get("by_project") or []
    top_repo = max(projects, key=lambda r: r.get("total") or 0, default=None)
    sessions = f.get("top_sessions") or []
    longest = max(sessions, key=lambda r: r.get("active_seconds") or 0, default=None)
    rec = f.get("records") or {}
    badges = [b for b in (f.get("achievements") or {}).get("badges", []) if b.get("earned") and start <= str(b["earned"]) <= end]
    price = float(plan_price or (f.get("achievements") or {}).get("plan_price") or 200.0)
    days_in = (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 1
    plan_share = price * days_in / 30.0           # what this period of the plan costs
    api = float(S.get("api_equivalent") or 0.0)
    card = {
        "key": key, "kind": kind, "start": start, "end": end, "generated": time.time(), "complete": end < today,
        "days": days_in, "days_with_data": sum(1 for r in f.get("daily") or [] if start <= r["date"] <= end and (r.get("total") or r.get("commits"))),
        "tokens": int(S.get("total") or 0), "input": int(S.get("input") or 0), "output": int(S.get("output") or 0),
        "lines_added": int(S.get("insertions") or 0), "lines_removed": int(S.get("deletions") or 0), "net": int(S.get("net") or 0), "files": int(S.get("files") or 0),
        "commits": int(S.get("commits") or 0), "sessions": int(S.get("sessions") or 0), "active_seconds": float(S.get("active_seconds") or 0.0),
        "api_equivalent": round(api, 2), "cost": round(float(S.get("cost") or 0.0), 2), "plan_price": price, "plan_share": round(plan_share, 2),
        "paid_multiple": round(api / plan_share, 1) if plan_share > 0 else None,
        "top_repo": {"name": top_repo.get("key"), "tokens": top_repo.get("total"), "commits": top_repo.get("commits")} if top_repo else None,
        "longest_session": {"sid": longest.get("key"), "name": longest.get("name") or longest.get("key"), "title": longest.get("title"), "active_seconds": longest.get("active_seconds"), "tokens": longest.get("total")} if longest and longest.get("active_seconds") else None,
        "biggest_commit": rec.get("biggest_commit"),
        "most_tokens_day": rec.get("most_tokens_day"),
        "badges": [{"id": b["id"], "name": b["name"], "desc": b.get("desc"), "earned": b["earned"]} for b in badges],
        "verb": verb if verb and verb.get("name") else None,
        "streak": (f.get("streaks") or {}).get("current"),
        "daily": [{"date": r["date"], "tokens": r.get("total") or 0, "commits": r.get("commits") or 0} for r in reversed(f.get("series") or [])],
    }
    card["fun"] = fun_line(card["tokens"], card["lines_added"] + card["lines_removed"])
    os.makedirs(DIR, exist_ok=True)
    tmp = _path(key) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(card, fh)
    os.replace(tmp, _path(key))
    return card


def get(key: str, verb: dict | None = None, fresh: bool = False) -> dict:
    """A finished period's card comes from disk once built; a running one is rebuilt."""
    card = None if fresh else load(key)
    if card and card.get("complete") and (card.get("verb") or not verb):
        return card
    return build(key, verb)
