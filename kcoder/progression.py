"""Progression: the game that does not end. Levels (XP from tokens, commits,
lines and merged PRs, weighted so shipping beats token burn), tiered badges
(bronze to diamond, each tier about ten times the last), monthly seasons with
a rotating badge set and a rank, three daily quests and a weekly one drawn
from the real repos and recent activity, a daily shipping streak with one
freeze a week, personal records and thirteen secret badges (three of them
from conditions the daemon observed: a powder day, a 10% bitcoin day and a
full-moon session).

Everything but the quests is computed from history, so a fresh install
backfills the lot. The quests are drawn once per local day and kept in
progress.json next to the usage log, with a ledger of the XP they paid.

`compute()` runs inside stats.full() and behind the `progress` request;
`lite()` is the cheap version for the status bar (level and the bar to the
next one).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import random
import threading

from . import achievements, paths

PROGRESS_PATH = os.path.join(paths.DATA_DIR, "progress.json")

# ---- XP: what a unit of each thing is worth, and the level curve ----
XP_PER_TOKEN = 1 / 100_000     # a million tokens: 10 XP
XP_PER_COMMIT = 30
XP_PER_LINE = 1 / 20           # a thousand lines changed: 50 XP
XP_PER_MERGE = 250             # a merged PR (kcoder's merge, or a merge commit)
XP_PER_SEASON_BADGE = 200

TIERS = ["bronze", "silver", "gold", "platinum", "diamond"]
SEASON_RANKS = [(1_000, "bronze"), (5_000, "silver"), (15_000, "gold"), (30_000, "platinum"), (60_000, "diamond")]

_lock = threading.Lock()
_lite_cache: dict = {"key": None, "value": None, "full": None}   # full: {"xp": the last compute()'s XP, "cheap": the cheap XP at that moment}


def level_cost(n: int) -> int:
    """XP it takes to go from level n to n + 1: more every level, no cap."""
    return int(round(60 * (n ** 1.25)))


def level_from_xp(xp: float) -> dict:
    lvl, spent = 1, 0.0
    while xp - spent >= level_cost(lvl):
        spent += level_cost(lvl)
        lvl += 1
    need = level_cost(lvl)
    into = xp - spent
    return {"level": lvl, "xp": int(xp), "into": int(into), "need": need, "pct": round(into / need, 4) if need else 0.0}


def xp_of(tokens: float, commits: float, lines: float, merges: float) -> float:
    return tokens * XP_PER_TOKEN + commits * XP_PER_COMMIT + lines * XP_PER_LINE + merges * XP_PER_MERGE


# ---- the state file: quests and the XP they paid ----

def load_state() -> dict:
    try:
        with open(PROGRESS_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        if not isinstance(s, dict):
            raise ValueError
    except (OSError, ValueError):
        s = {}
    s.setdefault("daily", {})
    s.setdefault("weekly", {})
    s.setdefault("ledger", [])
    return s


def save_state(s: dict) -> None:
    os.makedirs(os.path.dirname(PROGRESS_PATH), exist_ok=True)
    tmp = PROGRESS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f)
    os.replace(tmp, PROGRESS_PATH)


# ---- helpers ----

def _local(ts: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(float(ts))


def _date(ts: float) -> str:
    return _local(ts).strftime("%Y-%m-%d")


def _week_key(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _month_days(key: str) -> int:
    y, m = int(key[:4]), int(key[5:7])
    nxt = dt.date(y + (m == 12), (m % 12) + 1, 1)
    return (nxt - dt.date(y, m, 1)).days


def _seeded(seed: str) -> random.Random:
    return random.Random(seed)


def _merges(commits: list, facts: dict) -> list:
    """Merged PRs: kcoder's own merge (a git event) and merge commits, as dates."""
    out = [_date(ts) for f in facts.values() for ts in f.get("merges", [])]
    out += [c.get("date") for c in commits if str(c.get("subject") or "").startswith(("Merge pull request", "Merge branch"))]
    return sorted(d for d in out if d)


def _fmt_thr(fmt: str, v: float) -> str:
    if fmt == "tokens":
        return achievements._big(v) + " tokens"
    if fmt == "usd":
        return f"${v:,.0f}"
    if fmt == "dur":
        return f"{v / 3600:g} h" if v >= 3600 else f"{v / 60:g} min"
    if fmt == "pct":
        return f"{round(v * 100)}%"
    if fmt == "days":
        return f"{int(v)} day{'s' if v != 1 else ''}"
    if fmt == "x":
        return f"{v:g}×"
    return f"{int(v):,}"


# ---- tiered badges ----

def _series(days: list, facts: dict, metas: dict, commits: list, merges: list, plan_cost: float, price: float, months: int,
            ship_streak_longest: int, ship_streak_first: dict) -> list:
    """Every badge series with its five thresholds, the value, and the day each
    tier was first reached (backfilled from history)."""
    cum = lambda key, thr: achievements._earned_cumulative(days, key, thr)   # noqa: E731
    single = lambda key, thr: achievements._earned_single(days, key, thr)   # noqa: E731
    tot = {k: sum(float(r.get(k) or 0) for r in days) for k in ("total", "commits", "insertions", "deletions", "api_equivalent", "active_seconds")}
    best = lambda key: max((float(r.get(key) or 0) for r in days), default=0.0)   # noqa: E731
    active = [r["date"] for r in days if r.get("total") or r.get("commits") or r.get("active_seconds")]
    sorted_commits = sorted(commits, key=lambda c: float(c.get("ts") or 0))

    def first_day(items, thr, value):
        """items: [(date, value)] ascending; the first date whose value reaches thr."""
        for d, v in items:
            if v >= thr:
                return d
        return None

    out = []

    def add(bid, name, group, desc, fmt, tiers, value, earned_fn):
        out.append({"id": bid, "name": name, "group": group, "desc": desc, "fmt": fmt, "tiers": tiers, "value": value,
                    "earned": [earned_fn(t) for t in tiers]})

    # tokens
    add("tokens_all", "Summit", "tokens", "{t} all time", "tokens", [1e6, 1e7, 1e8, 1e9, 1e10], tot["total"], lambda t: cum("total", t))
    add("tokens_day", "Powder Day", "tokens", "{t} in one day", "tokens", [1e7, 5e7, 1e8, 2.5e8, 1e9], best("total"), lambda t: single("total", t))
    hit_days = [(r["date"], float(r.get("cache_read") or 0) / float(r["input"])) for r in days if float(r.get("input") or 0) >= 1e6]
    add("gas_saver", "Gas Saver", "tokens", "a {t} cache hit rate on a 1M-token day", "pct", [0.5, 0.7, 0.85, 0.95, 0.99],
        max((v for _, v in hit_days), default=0.0), lambda t: first_day(hit_days, t, None))
    # commits
    add("commits_all", "Shipping", "commits", "{t} commits all time", "int", [1, 10, 100, 1000, 5000], tot["commits"], lambda t: cum("commits", t))
    add("commits_day", "Ripper", "commits", "{t} commits in one day", "int", [3, 10, 30, 100, 300], best("commits"), lambda t: single("commits", t))
    add("merges", "Merged", "commits", "{t} merged PRs", "int", [1, 5, 25, 100, 500], len(merges), lambda t: merges[int(t) - 1] if len(merges) >= t else None)
    pushed = [(c.get("date"), i + 1) for i, c in enumerate(c for c in sorted_commits if c.get("pushed"))]
    add("pushed", "Upstream", "commits", "{t} commits pushed", "int", [1, 10, 100, 1000, 5000], len(pushed), lambda t: first_day(pushed, t, None))
    # lines
    add("lines_added", "Bulldozer", "lines", "{t} lines added all time", "int", [100, 1e3, 1e4, 1e5, 1e6], tot["insertions"], lambda t: cum("insertions", t))
    add("lines_removed", "Clear-Cut", "lines", "{t} lines removed all time", "int", [25, 250, 2500, 25000, 250000], tot["deletions"], lambda t: cum("deletions", t))
    add("lines_day", "Big Day", "lines", "{t} lines in one day", "int", [500, 2000, 10000, 50000, 200000], best("lines"), lambda t: single("lines", t))
    sizes = [(c.get("date"), int(c.get("insertions") or 0) + int(c.get("deletions") or 0)) for c in sorted_commits]
    add("big_air", "Big Air", "lines", "a single commit of {t} lines", "int", [100, 500, 2000, 10000, 50000],
        max((s for _, s in sizes), default=0), lambda t: first_day(sizes, t, None))
    kondo = [(r["date"], i + 1) for i, r in enumerate(r for r in days if (r.get("deletions") or 0) > (r.get("insertions") or 0) and (r.get("deletions") or 0) > 0)]
    add("marie_kondo", "Marie Kondo", "lines", "{t} days with more lines removed than added", "int", [1, 3, 10, 30, 100], len(kondo), lambda t: first_day(kondo, t, None))
    # API equivalent
    add("api_all", "Fund Manager", "api", "{t} API-equivalent all time", "usd", [10, 100, 1000, 10000, 100000], tot["api_equivalent"], lambda t: cum("api_equivalent", t))
    add("api_day", "Whale", "api", "{t} API-equivalent in one day", "usd", [10, 100, 500, 2500, 10000], best("api_equivalent"), lambda t: single("api_equivalent", t))
    add("paid", "Paid for itself", "api", "{t} the plan price so far (" + f"${price:,.0f}/mo × {months} mo)",
        "x", [1, 3, 10, 30, 100], tot["api_equivalent"] / plan_cost if plan_cost else 0.0, lambda t: cum("api_equivalent", t * plan_cost))
    # agent time
    add("time_all", "Hundred Hours", "time", "{t} of agent time all time", "dur", [600, 3600, 36000, 360000, 1_800_000], tot["active_seconds"], lambda t: cum("active_seconds", t))
    add("time_day", "Full Shift", "time", "{t} of agent time in one day", "dur", [1800, 7200, 28800, 57600, 86400], best("active_seconds"), lambda t: single("active_seconds", t))
    turns = sorted(((_date(e), float(el or 0)) for f in facts.values() for _s, e, el, _r in f["turns"]), key=lambda x: x[0])
    add("long_haul", "Long Haul", "time", "a single turn of {t}", "dur", [300, 1800, 3600, 10800, 28800], max((el for _, el in turns), default=0.0), lambda t: first_day(turns, t, None))
    # sessions
    created = sorted(d for d in ((m.get("created") and _date(m["created"])) for m in metas.values()) if d)
    add("sessions_all", "The Fleet", "sessions", "{t} sessions all time", "int", [1, 10, 100, 500, 2000], len(metas), lambda t: created[int(t) - 1] if len(created) >= t else None)
    add("sessions_day", "Ten Agents, One Keyboard", "sessions", "{t} sessions in one day", "int", [2, 5, 10, 25, 50], best("sessions"), lambda t: single("sessions", t))
    peaks = achievements._peak_parallel_by_day(facts)
    peak_items = sorted(peaks.items())
    add("rope_team", "Rope Team", "sessions", "{t} sessions working at the same time", "int", [2, 3, 5, 10, 20], max(peaks.values(), default=0), lambda t: first_day(peak_items, t, None))
    per_session = []
    for sid, f in facts.items():
        if f["turns"]:
            last = max(e for _s, e, _el, _r in f["turns"])
            per_session.append((_date(last), len(f["turns"]), len(f["tools"]), sum(1 for _ts, _n, err in f["tools"] if err), len(f["waits"]), sum(float(el or 0) for _s, _e, el, _r in f["turns"])))
    per_session.sort()
    add("diamond_hands", "Diamond Hands", "sessions", "a session you kept going for {t} turns", "int", [10, 25, 100, 250, 1000],
        max((n for _, n, _t, _e, _w, _a in per_session), default=0), lambda t: first_day([(d, n) for d, n, _t, _e, _w, _a in per_session], t, None))
    add("session_time", "Marathon", "sessions", "{t} of agent time in one session", "dur", [1800, 7200, 28800, 86400, 360000],
        max((a for _, _n, _t, _e, _w, a in per_session), default=0.0), lambda t: first_day([(d, a) for d, _n, _t, _e, _w, a in per_session], t, None))
    tools = sorted(((_date(ts), 1) for f in facts.values() for ts, _n, _e in f["tools"]))
    tools_cum = [(d, i + 1) for i, (d, _) in enumerate(tools)]
    add("tools_all", "Toolsmith", "sessions", "{t} tool calls all time", "int", [100, 1e3, 1e4, 1e5, 1e6], len(tools), lambda t: first_day(tools_cum, t, None))
    # streaks
    add("bluebird", "Bluebird", "streaks", "{t} active days in a row", "days", [3, 7, 30, 100, 365],
        max((n for n, _ in achievements._streak_runs(active)), default=0), lambda t: achievements._streak_earned(active, int(t)))
    add("ship_streak", "Shipping Streak", "streaks", "a commit every day for {t} (one freeze a week)", "days", [3, 7, 30, 100, 365], ship_streak_longest, lambda t: ship_streak_first.get(int(t)))
    # habits
    add("hands_off", "Hands Off", "habits", "a session with {t} tool calls that never waited on you", "int", [10, 50, 100, 500, 2000],
        max((t for _, _n, t, _e, w, _a in per_session if not w), default=0), lambda t: first_day([(d, tl) for d, _n, tl, _e, w, _a in per_session if not w], t, None))
    add("clean_line", "Clean Line", "habits", "a session with {t} tool calls and not one failure", "int", [10, 25, 100, 500, 2000],
        max((t for _, _n, t, e, _w, _a in per_session if not e), default=0), lambda t: first_day([(d, tl) for d, _n, tl, e, _w, _a in per_session if not e], t, None))
    dawn_days, night_days = set(), set()
    for f in facts.values():
        for s0, e, _el, _r in f["turns"]:
            a, b = _local(s0), _local(e)
            if 5 <= a.hour < 7 or 5 <= b.hour < 7:
                dawn_days.add(b.strftime("%Y-%m-%d"))
            if a.hour < 4 or b.hour < 4:
                night_days.add(b.strftime("%Y-%m-%d"))
    dawn_l = [(d, i + 1) for i, d in enumerate(sorted(dawn_days))]
    night_l = [(d, i + 1) for i, d in enumerate(sorted(night_days))]
    add("dawn_patrol", "Dawn Patrol", "habits", "{t} days with a turn running between 5 and 7 in the morning", "int", [1, 5, 20, 50, 100], len(dawn_l), lambda t: first_day(dawn_l, t, None))
    add("night_shift", "Night Shift", "habits", "{t} days with a turn running between midnight and 4", "int", [1, 5, 20, 50, 100], len(night_l), lambda t: first_day(night_l, t, None))
    weekend = sorted({c["date"] for c in commits if c.get("date") and dt.date.fromisoformat(c["date"]).weekday() >= 5})
    weekend_l = [(d, i + 1) for i, d in enumerate(weekend)]
    add("weekend_warrior", "Weekend Warrior", "habits", "{t} weekend days with a commit", "int", [1, 5, 20, 50, 100], len(weekend_l), lambda t: first_day(weekend_l, t, None))

    for b in out:
        earned = b["earned"]
        tier = sum(1 for d in earned if d)          # tiers are cumulative: the count of earned ones
        b["tier"] = tier
        b["tier_name"] = TIERS[tier - 1] if tier else None
        nxt = b["tiers"][tier] if tier < 5 else None
        prev = b["tiers"][tier - 1] if tier else 0
        b["next"] = nxt
        b["progress"] = 1.0 if nxt is None else min(0.999, max(0.0, (b["value"] - prev) / (nxt - prev))) if nxt > prev else 0.0
        b["earned_at"] = earned[tier - 1] if tier else None
        b["desc_next"] = b["desc"].replace("{t}", _fmt_thr(b["fmt"], nxt)) if nxt is not None else b["desc"].replace("{t}", _fmt_thr(b["fmt"], b["tiers"][-1]))
        b["tier_descs"] = [b["desc"].replace("{t}", _fmt_thr(b["fmt"], t)) for t in b["tiers"]]
    return out


# ---- secret badges ----

def _secrets(days: list, facts: dict, commits: list, observed: dict | None = None) -> list:
    """observed: the conditions ledger ({"powder": date, "btc10": date, "moon": date}), facts the
    daemon saw while kcoder was open and that history cannot replay."""
    observed = observed or {}
    active = [r["date"] for r in days if r.get("total") or r.get("commits") or r.get("active_seconds")]
    sorted_commits = sorted((c for c in commits if c.get("ts")), key=lambda c: float(c["ts"]))

    def day_matches(pred):
        return next((d for d in active if pred(dt.date.fromisoformat(d))), None)

    def commit_matches(pred):
        return next((c.get("date") for c in sorted_commits if pred(c, _local(c["ts"]))), None)

    out = []

    def add(bid, name, desc, earned):
        out.append({"id": bid, "name": name, "desc": desc, "earned": earned, "hidden": True})

    add("leap_day", "Leap Day", "worked on February 29", day_matches(lambda x: x.month == 2 and x.day == 29))
    add("friday_13th", "Friday the 13th", "a commit on a Friday the 13th", commit_matches(lambda c, t: t.day == 13 and t.weekday() == 4))
    add("fresh_tracks", "Fresh Tracks", "worked on New Year's Day", day_matches(lambda x: x.month == 1 and x.day == 1))
    add("holiday_shred", "Holiday Shred", "worked on December 25", day_matches(lambda x: x.month == 12 and x.day == 25))
    add("leet", "1337", "a commit at 13:37", commit_matches(lambda c, t: t.hour == 13 and t.minute == 37))
    add("four_twenty", "Four Twenty", "a commit at 4:20", commit_matches(lambda c, t: t.hour in (4, 16) and t.minute == 20))
    add("nice", "Nice", "a commit of exactly 69 or 420 lines", commit_matches(lambda c, t: int(c.get("insertions") or 0) + int(c.get("deletions") or 0) in (69, 420)))
    def palindrome(c, t):
        hm = t.strftime("%H%M")
        return hm == hm[::-1]
    add("palindrome", "Palindrome", "a commit at a time that reads the same backwards (12:21, 13:31 …)", commit_matches(palindrome))
    # speed demon: ten commits inside one hour
    speed = None
    for i in range(len(sorted_commits) - 9):
        if float(sorted_commits[i + 9]["ts"]) - float(sorted_commits[i]["ts"]) <= 3600:
            speed = sorted_commits[i + 9].get("date")
            break
    add("speed_demon", "Speed Demon", "ten commits inside one hour", speed)
    rage = None
    for f in facts.values():
        if len(f["interrupts"]) >= 5:
            d = _date(sorted(f["interrupts"])[4])
            if rage is None or d < rage:
                rage = d
    add("rage_quit", "Rage Quit", "five interrupts in one session", rage)
    add("first_powder", "First Chair", "a powder day: 6 in or more of fresh snow at your place in 24 h while kcoder was open", observed.get("powder"))
    add("btc_ten", "Diamond Hands", "bitcoin moved 10% in a day, either way, while kcoder was open", observed.get("btc10"))
    add("full_moon", "Moonlit Run", "a session on a full-moon night", observed.get("moon"))
    return out


# ---- the shipping streak: a commit a day, one freeze a week ----

def ship_streak(days: list, today: str) -> dict:
    commit_days = {r["date"] for r in days if (r.get("commits") or 0) > 0}
    if not commit_days:
        return {"current": 0, "longest": 0, "freeze_left": True, "frozen": [], "first_at": {}, "commit_days": 0, "today_done": False}
    first = dt.date.fromisoformat(min(commit_days))
    end = dt.date.fromisoformat(today)
    run = longest = 0
    frozen: list = []
    freeze_weeks: set = set()
    first_at: dict = {}
    d = first
    while d <= end:
        ds = d.isoformat()
        if ds in commit_days:
            run += 1
        elif ds == today:
            pass                                     # today is not over
        else:
            wk = _week_key(d)
            if wk not in freeze_weeks and run > 0:   # the week's freeze covers one missed day
                freeze_weeks.add(wk)
                frozen.append(ds)
            else:
                run = 0
        longest = max(longest, run)
        for n in (3, 7, 30, 100, 365):
            if run >= n and n not in first_at:
                first_at[n] = ds
        d += dt.timedelta(days=1)
    return {"current": run, "longest": longest, "freeze_left": _week_key(end) not in freeze_weeks, "frozen": frozen[-5:],
            "first_at": first_at, "commit_days": len(commit_days), "today_done": today in commit_days}


# ---- records ----

def records(days: list, facts: dict, metas: dict) -> dict:
    def best(key, label):
        r = max(days, key=lambda r: float(r.get(key) or 0), default=None)
        return {"value": float(r.get(key) or 0), "date": r["date"], "label": label} if r and float(r.get(key) or 0) > 0 else None
    longest = None
    for sid, f in facts.items():
        secs = sum(float(el or 0) for _s, _e, el, _r in f["turns"])
        if secs > 0 and (longest is None or secs > longest["value"]):
            last = max(e for _s, e, _el, _r in f["turns"])
            longest = {"value": secs, "date": _date(last), "sid": sid, "name": (metas.get(sid) or {}).get("name"), "label": "longest session"}
    peaks = achievements._peak_parallel_by_day(facts)
    most_at_once = None
    if peaks:
        d, n = max(peaks.items(), key=lambda kv: (kv[1], kv[0]))
        most_at_once = {"value": n, "date": d, "label": "most sessions at once"}
    return {"tokens_day": best("total", "best day for tokens"), "commits_day": best("commits", "best day for commits"),
            "lines_day": best("lines", "best day for lines"), "longest_session": longest, "most_at_once": most_at_once}


# ---- seasons: a month each, with its own badge set and a rank ----

SEASON_POOL = [
    ("s_tokens", "{n} this month", "tokens", lambda b, nd: b["tokens"] * nd * 0.8),
    ("s_commits", "{n} commits this month", "int", lambda b, nd: b["commits"] * nd * 0.8),
    ("s_lines", "{n} lines added this month", "int", lambda b, nd: b["insertions"] * nd * 0.8),
    ("s_hours", "{n} of agent time this month", "dur", lambda b, nd: b["active"] * nd * 0.8),
    ("s_sessions", "{n} sessions this month", "int", lambda b, nd: b["sessions"] * nd * 0.6),
    ("s_days", "active on {n} days this month", "int", lambda b, nd: math.ceil(nd * 0.6)),
    ("s_repos", "commits in {n} repos this month", "int", lambda b, nd: 3),
    ("s_streak", "a {n}-day shipping streak this month", "int", lambda b, nd: 7),
    ("s_bigday", "a day with {n}", "tokens", lambda b, nd: b["tokens"] * 2),
    ("s_weekend", "{n} weekend days with a commit", "int", lambda b, nd: 2),
    ("s_early", "{n} commits before 9 in the morning", "int", lambda b, nd: 3),
    ("s_late", "{n} commits after 10 at night", "int", lambda b, nd: 3),
    ("s_pushed", "{n} commits pushed this month", "int", lambda b, nd: b["commits"] * nd * 0.5),
    ("s_clean", "{n} sessions with 25 clean tool calls", "int", lambda b, nd: 3),
]
SEASON_SIZE = 8
BASE_FLOORS = {"tokens": 5e6, "commits": 5, "insertions": 1000, "active": 3600, "sessions": 3}


def _season_base(days_by_date: dict, key: str) -> dict:
    """Per-day averages over everything before the season, never under the floors:
    what a season's targets are scaled from (so they are fixed once the month starts)."""
    before = [r for d, r in days_by_date.items() if d < key + "-01"]
    n = len({r["date"] for r in before if r.get("total") or r.get("commits") or r.get("active_seconds")})
    if n < 3:
        return dict(BASE_FLOORS)
    s = {"tokens": sum(float(r.get("total") or 0) for r in before), "commits": sum(float(r.get("commits") or 0) for r in before),
         "insertions": sum(float(r.get("insertions") or 0) for r in before), "active": sum(float(r.get("active_seconds") or 0) for r in before),
         "sessions": sum(float(r.get("sessions") or 0) for r in before)}
    return {k: max(BASE_FLOORS[k], v / n) for k, v in s.items()}


def _round_nice(v: float, fmt: str) -> float:
    if fmt in ("int", "dur") and v < 10:
        return max(1, round(v))
    if fmt == "dur":
        return max(1800, round(v / 1800) * 1800)
    mag = 10 ** max(0, int(math.log10(v)) - 1) if v >= 10 else 1
    return max(1, round(v / mag) * mag)


def season(key: str, days_by_date: dict, facts: dict, commits: list, metas: dict, ledger: list, today: str) -> dict:
    nd = _month_days(key)
    base = _season_base(days_by_date, key)
    rnd = _seeded("season:" + key)
    picks = sorted(rnd.sample(range(len(SEASON_POOL)), SEASON_SIZE))
    month_days = [r for d, r in days_by_date.items() if d.startswith(key)]
    month_commits = [c for c in commits if str(c.get("date") or "").startswith(key)]
    tot = {k: sum(float(r.get(k) or 0) for r in month_days) for k in ("total", "commits", "insertions", "active_seconds", "sessions")}
    active_days = sorted({r["date"] for r in month_days if r.get("total") or r.get("commits") or r.get("active_seconds")})
    streak = ship_streak(month_days, today if key == today[:7] else f"{key}-{nd:02d}")
    clean = 0
    for f in facts.values():
        if f["tools"] and not any(e for _t, _n, e in f["tools"]) and len(f["tools"]) >= 25:
            last = max((e for _s, e, _el, _r in f["turns"]), default=None)
            if last and _date(last).startswith(key):
                clean += 1
    values = {
        "s_tokens": tot["total"], "s_commits": tot["commits"], "s_lines": tot["insertions"], "s_hours": tot["active_seconds"],
        "s_sessions": len({c.get("sid") for c in month_commits} | {sid for sid, m in metas.items() if m.get("created") and _date(m["created"]).startswith(key)}),
        "s_days": len(active_days), "s_repos": len({c.get("project") for c in month_commits if c.get("project")}),
        "s_streak": streak["longest"], "s_bigday": max((float(r.get("total") or 0) for r in month_days), default=0.0),
        "s_weekend": len({c["date"] for c in month_commits if dt.date.fromisoformat(c["date"]).weekday() >= 5}),
        "s_early": sum(1 for c in month_commits if c.get("ts") and _local(c["ts"]).hour < 9),
        "s_late": sum(1 for c in month_commits if c.get("ts") and _local(c["ts"]).hour >= 22),
        "s_pushed": sum(1 for c in month_commits if c.get("pushed")), "s_clean": clean,
    }
    badges = []
    for i in picks:
        bid, text, fmt, target = SEASON_POOL[i]
        n = _round_nice(target(base, nd), fmt)
        v = values.get(bid, 0)
        badges.append({"id": bid, "text": text.replace("{n}", _fmt_thr(fmt, n)), "n": n, "value": v, "fmt": fmt,
                       "progress": 1.0 if v >= n else min(0.999, v / n) if n else 0.0, "earned": v >= n})
    earned = sum(1 for b in badges if b["earned"])
    xp = xp_of(tot["total"], tot["commits"], sum(float(r.get("insertions") or 0) + float(r.get("deletions") or 0) for r in month_days), 0)
    xp += sum(int(e.get("xp") or 0) for e in ledger if str(e.get("date") or "").startswith(key))
    xp += earned * XP_PER_SEASON_BADGE
    rank = None
    for thr, name in SEASON_RANKS:
        if xp >= thr:
            rank = name
    nxt = next(((thr, name) for thr, name in SEASON_RANKS if xp < thr), None)
    start = dt.date(int(key[:4]), int(key[5:7]), 1)
    return {"key": key, "name": start.strftime("%B %Y"), "start": start.isoformat(), "end": (start + dt.timedelta(days=nd - 1)).isoformat(),
            "badges": badges, "earned": earned, "total": len(badges), "xp": int(xp), "rank": rank,
            "next_rank": {"name": nxt[1], "xp": nxt[0]} if nxt else None, "days_left": max(0, (start + dt.timedelta(days=nd) - dt.date.fromisoformat(today)).days) if key == today[:7] else 0}


# ---- quests: three a day and one a week, from the real repos and the last two weeks ----

def _recent(days_by_date: dict, commits: list, metas: dict, facts: dict, today: str) -> dict:
    """The last 14 days: per-day averages and the repos with the most activity."""
    end = dt.date.fromisoformat(today)
    window = {(end - dt.timedelta(days=i)).isoformat() for i in range(1, 15)}
    rows = [r for d, r in days_by_date.items() if d in window]
    n = max(1, len([r for r in rows if r.get("total") or r.get("commits")]))
    avg = {k: sum(float(r.get(k) or 0) for r in rows) / n for k in ("total", "commits", "insertions", "deletions", "active_seconds", "sessions")}
    repo_commits: dict = {}
    for c in commits:
        if c.get("date") in window and c.get("project"):
            repo_commits[c["project"]] = repo_commits.get(c["project"], 0) + 1
    repo_sessions: dict = {}
    for sid, m in metas.items():
        p = (m.get("project") or {}).get("name")
        if p and m.get("created") and _date(m["created"]) in window:
            repo_sessions[p] = repo_sessions.get(p, 0) + 1
    repos = sorted(set(repo_commits) | set(repo_sessions), key=lambda p: -(repo_commits.get(p, 0) * 2 + repo_sessions.get(p, 0)))
    return {"avg": avg, "days": n, "repos": repos[:6], "repo_commits": repo_commits}


def _draw_daily(key: str, recent: dict) -> list:
    rnd = _seeded("quest:" + key)
    avg, repos = recent["avg"], recent["repos"]
    n_days = recent["days"]
    pool = []
    if repos:
        repo = repos[0] if len(repos) == 1 or rnd.random() < 0.6 else repos[rnd.randrange(min(3, len(repos)))]
        per_day = recent["repo_commits"].get(repo, 0) / max(1, n_days)
        pool.append({"id": "d_commits_repo", "text": f"{{n}} commit{{s}} in {repo}", "n": max(1, round(per_day * 0.8)), "repo": repo, "xp": 60})
        repo2 = repos[rnd.randrange(len(repos))]
        pool.append({"id": "d_session_repo", "text": f"a session of {{n}}+ turns in {repo2}", "n": 10, "repo": repo2, "xp": 50})
    pool += [
        {"id": "d_commits", "text": "{n} commit{s} today", "n": max(2, round(avg["commits"] * 0.6)), "xp": 50},
        {"id": "d_lines", "text": "ship {n} lines today", "n": max(200, round(avg["insertions"] * 0.6 / 100) * 100), "xp": 50},
        {"id": "d_tokens", "text": "{n} today", "n": max(1_000_000, round(avg["total"] * 0.5 / 1e6) * 1_000_000), "fmt": "tokens", "xp": 40},
        {"id": "d_repos", "text": "commits in {n} repos today", "n": 2 if len(repos) < 4 else 3, "xp": 60},
        {"id": "d_hours", "text": "{n} of agent time today", "n": max(1800, round(avg["active_seconds"] * 0.5 / 1800) * 1800), "fmt": "dur", "xp": 40},
        {"id": "d_push", "text": "push a commit today", "n": 1, "xp": 30},
        {"id": "d_clean", "text": "a session with 15 tool calls and no failures", "n": 15, "xp": 50},
        {"id": "d_early", "text": "a commit before noon", "n": 1, "xp": 30},
    ]
    out = []
    while len(out) < 3 and pool:
        q = pool.pop(rnd.randrange(len(pool)))
        out.append({**q, "done": None})
    for q in out:
        q["text"] = q["text"].replace("{n}", _fmt_thr(q.get("fmt", "int"), q["n"])).replace("{s}", "" if q["n"] == 1 else "s")
    return out


def _draw_weekly(key: str, recent: dict) -> dict:
    rnd = _seeded("quest-week:" + key)
    avg = recent["avg"]
    pool = [
        {"id": "w_commits", "text": "{n} commits this week", "n": max(5, round(avg["commits"] * 7 * 0.6)), "xp": 200},
        {"id": "w_lines", "text": "ship {n} lines this week", "n": max(1000, round(avg["insertions"] * 7 * 0.6 / 500) * 500), "xp": 200},
        {"id": "w_days", "text": "ship on {n} days this week", "n": 5, "xp": 200},
        {"id": "w_repos", "text": "commits in {n} repos this week", "n": 3 if len(recent["repos"]) >= 3 else 2, "xp": 200},
        {"id": "w_hours", "text": "{n} of agent time this week", "n": max(7200, round(avg["active_seconds"] * 7 * 0.5 / 3600) * 3600), "fmt": "dur", "xp": 200},
    ]
    q = pool[rnd.randrange(len(pool))]
    q["text"] = q["text"].replace("{n}", _fmt_thr(q.get("fmt", "int"), q["n"]))
    return {**q, "done": None}


def _quest_value(q: dict, dates: set, days_by_date: dict, commits: list, metas: dict, facts: dict) -> float:
    rows = [days_by_date[d] for d in dates if d in days_by_date]
    cs = [c for c in commits if c.get("date") in dates]
    qid = q["id"]
    if qid == "d_commits_repo":
        return sum(1 for c in cs if c.get("project") == q.get("repo"))
    if qid in ("d_commits", "w_commits"):
        return sum(float(r.get("commits") or 0) for r in rows)
    if qid in ("d_lines", "w_lines"):
        return sum(float(r.get("insertions") or 0) for r in rows)
    if qid == "d_tokens":
        return sum(float(r.get("total") or 0) for r in rows)
    if qid in ("d_repos", "w_repos"):
        return len({c.get("project") for c in cs if c.get("project")})
    if qid in ("d_hours", "w_hours"):
        return sum(float(r.get("active_seconds") or 0) for r in rows)
    if qid == "d_push":
        return sum(1 for c in cs if c.get("pushed"))
    if qid == "d_early":
        return sum(1 for c in cs if c.get("ts") and _local(c["ts"]).hour < 12)
    if qid == "w_days":
        return len({c["date"] for c in cs})
    if qid in ("d_session_repo", "d_clean"):
        best = 0
        for sid, f in facts.items():
            if qid == "d_session_repo" and ((metas.get(sid) or {}).get("project") or {}).get("name") != q.get("repo"):
                continue
            if qid == "d_session_repo":
                n = sum(1 for _s, e, _el, _r in f["turns"] if _date(e) in dates)
            else:
                today_tools = [(ts, nm, err) for ts, nm, err in f["tools"] if _date(ts) in dates]
                n = len(today_tools) if today_tools and not any(e for _t, _n, e in today_tools) else 0
            best = max(best, n)
        return best
    return 0


def quests(state: dict, today: str, days_by_date: dict, commits: list, metas: dict, facts: dict) -> tuple[dict, bool]:
    """Today's three and the week's one, drawn once and kept; done ones pay into
    the ledger. Returns (quests, state_changed)."""
    changed = False
    recent = None
    if today not in state["daily"]:
        recent = _recent(days_by_date, commits, metas, facts, today)
        state["daily"][today] = _draw_daily(today, recent)
        for k in [k for k in state["daily"] if k < (dt.date.fromisoformat(today) - dt.timedelta(days=60)).isoformat()]:
            del state["daily"][k]
        changed = True
    wk = _week_key(dt.date.fromisoformat(today))
    if wk not in state["weekly"]:
        recent = recent or _recent(days_by_date, commits, metas, facts, today)
        state["weekly"][wk] = _draw_weekly(wk, recent)
        for k in [k for k in state["weekly"] if k < _week_key(dt.date.fromisoformat(today) - dt.timedelta(days=120))]:
            del state["weekly"][k]
        changed = True
    monday = dt.date.fromisoformat(today) - dt.timedelta(days=dt.date.fromisoformat(today).weekday())
    week_dates = {(monday + dt.timedelta(days=i)).isoformat() for i in range(7)}
    daily = state["daily"][today]
    weekly = state["weekly"][wk]
    for q, dates in [(q, {today}) for q in daily] + [(weekly, week_dates)]:
        v = _quest_value(q, dates, days_by_date, commits, metas, facts)
        q["value"] = v
        q["progress"] = 1.0 if v >= q["n"] else min(0.999, v / q["n"]) if q["n"] else 0.0
        if v >= q["n"] and not q.get("done"):
            q["done"] = today
            state["ledger"].append({"date": today, "id": q["id"], "xp": q["xp"], "text": q["text"]})
            changed = True
    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    return {"daily": daily, "weekly": weekly, "week": wk, "date": today, "yesterday": state["daily"].get(yesterday),
            "week_dates": sorted(week_dates), "ledger_xp": sum(int(e.get("xp") or 0) for e in state["ledger"])}, changed


# ---- the whole thing ----

def compute(all_days_desc: list, facts: dict, metas: dict, commits: list, first_date: str | None, today: str,
            plan_price: float | None = None, observed: dict | None = None) -> dict:
    days = sorted(all_days_desc, key=lambda r: r["date"])
    days_by_date = {r["date"]: r for r in days}
    price = float(plan_price or achievements.PLAN_PRICE_DEFAULT)
    history_days = (dt.date.fromisoformat(today) - dt.date.fromisoformat(first_date)).days + 1 if first_date else 0
    months = max(1, math.ceil(max(history_days, 1) / 30))
    plan_cost = price * months
    merges = _merges(commits, facts)
    with _lock:
        state = load_state()
        q, changed = quests(state, today, days_by_date, commits, metas, facts)
        if changed:
            try:
                save_state(state)
            except OSError:
                pass
        ledger = list(state["ledger"])
    streak = ship_streak(days, today)
    tiers = _series(days, facts, metas, commits, merges, plan_cost, price, months, streak["longest"], streak["first_at"])
    secrets = _secrets(days, facts, commits, observed or {})
    tot = {k: sum(float(r.get(k) or 0) for r in days) for k in ("total", "commits", "insertions", "deletions")}
    seasons_keys = sorted({d[:7] for d in days_by_date} | {today[:7]})
    seasons = [season(k, days_by_date, facts, commits, metas, ledger, today) for k in seasons_keys]
    season_xp = sum(s["earned"] * XP_PER_SEASON_BADGE for s in seasons)
    sources = {"tokens": tot["total"] * XP_PER_TOKEN, "commits": tot["commits"] * XP_PER_COMMIT,
               "lines": (tot["insertions"] + tot["deletions"]) * XP_PER_LINE, "merges": len(merges) * XP_PER_MERGE,
               "quests": q["ledger_xp"], "seasons": season_xp}
    xp = sum(sources.values())
    level = level_from_xp(xp)
    level["sources"] = {k: int(v) for k, v in sources.items()}
    level["today_xp"] = int(xp_of(float(days_by_date.get(today, {}).get("total") or 0), float(days_by_date.get(today, {}).get("commits") or 0),
                                  float(days_by_date.get(today, {}).get("insertions") or 0) + float(days_by_date.get(today, {}).get("deletions") or 0),
                                  sum(1 for d in merges if d == today)) + sum(int(e.get("xp") or 0) for e in ledger if e.get("date") == today))
    # next up: the three closest things, across badge tiers, quests and records
    cands = []
    for b in tiers:
        if b["next"] is not None:
            cands.append({"kind": "badge", "id": b["id"], "name": f"{b['name']} {TIERS[b['tier']]}", "desc": b["desc_next"], "progress": b["progress"],
                          "value": b["value"], "target": b["next"], "fmt": b["fmt"]})
    for qq in q["daily"] + [q["weekly"]]:
        if not qq.get("done"):
            cands.append({"kind": "quest", "id": qq["id"], "name": "weekly quest" if qq["id"].startswith("w_") else "quest", "desc": qq["text"],
                          "progress": qq["progress"], "value": qq.get("value", 0), "target": qq["n"], "fmt": qq.get("fmt", "int")})
    rec = records(days, facts, metas)
    today_row = days_by_date.get(today) or {}
    for key, rk, fmt in (("total", "tokens_day", "tokens"), ("commits", "commits_day", "int"), ("lines", "lines_day", "int")):
        r = rec.get(rk)
        if r and r["date"] != today and float(today_row.get(key) or 0) > 0:
            v = float(today_row.get(key) or 0)
            cands.append({"kind": "record", "id": rk, "name": "record", "desc": f"{r['label']}: {_fmt_thr(fmt, r['value'])} on {r['date']}",
                          "progress": min(0.999, v / r["value"]) if r["value"] else 0.0, "value": v, "target": r["value"], "fmt": fmt})
    next_up = sorted(cands, key=lambda c: -c["progress"])[:3]
    return {
        "level": level, "tiers": tiers, "secrets": secrets, "streak": streak, "records": rec, "quests": q,
        "season": seasons[-1], "seasons": list(reversed(seasons[:-1])), "next_up": next_up, "merges": len(merges),
        "tier_names": TIERS, "earned_tiers": sum(b["tier"] for b in tiers), "total_tiers": len(tiers) * 5,
        "secrets_earned": sum(1 for s in secrets if s["earned"]), "secrets_total": len(secrets),
    }


def _cheap_xp(usage: list, commits: list) -> float:
    """XP from the totals alone (no session facts: merge commits only, no
    seasons, the quest ledger from the file)."""
    tokens = sum(int(r.get("input") or 0) + int(r.get("output") or 0) for r in usage)
    lines = sum(int(c.get("insertions") or 0) + int(c.get("deletions") or 0) for c in commits)
    merges = sum(1 for c in commits if str(c.get("subject") or "").startswith(("Merge pull request", "Merge branch")))
    try:
        ledger_xp = sum(int(e.get("xp") or 0) for e in load_state()["ledger"])
    except Exception:  # noqa: BLE001
        ledger_xp = 0
    return xp_of(tokens, len(commits), lines, merges) + ledger_xp


def has_full() -> bool:
    with _lock:
        return _lite_cache["full"] is not None


def remember(usage: list, commits: list, level: dict) -> None:
    """compute() ran: keep its XP with the cheap XP of the same moment, so the
    status bar shows the full level and moves it by the cheap delta until the
    next full run (never a level that drops because a cheaper count came by)."""
    with _lock:
        _lite_cache["full"] = {"xp": float(level["xp"]), "cheap": _cheap_xp(usage, commits)}
        _lite_cache["key"] = None


def lite(usage: list, commits: list) -> dict:
    """The status bar's level. Cached on the inputs' size."""
    key = (len(usage), len(commits))
    with _lock:
        if _lite_cache["key"] == key:
            return _lite_cache["value"]
        full = _lite_cache["full"]
    cheap = _cheap_xp(usage, commits)
    xp = full["xp"] + max(0.0, cheap - full["cheap"]) if full else cheap
    out = level_from_xp(xp)
    with _lock:
        _lite_cache["key"], _lite_cache["value"] = key, out
    return out
