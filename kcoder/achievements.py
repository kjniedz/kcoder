"""Achievements: badges earned from what the stats already know, backfilled
from history so each one carries the day it was first earned.

Groups: tokens (all-time and single-day), commits, lines, API equivalent,
agent time, sessions, streaks, habits (time of day, parallelism, sessions
that ran clean), and a few hidden ones that only show once earned. The
Powder Day record (biggest token day) is tracked separately and is earned
again every time the record is beaten.

`compute()` runs inside stats.full(); the app shows "next up" (the three
locked badges closest to unlocking) above the badge wall.
"""

from __future__ import annotations

import datetime as dt
import math

PLAN_PRICE_DEFAULT = 200.0   # USD per month; Settings "Claude plan price" overrides

M = 1_000_000
B = 1_000_000_000


def _earned_cumulative(days: list, key: str, threshold: float) -> str | None:
    """First day the running total of `key` reached `threshold` (days ascending)."""
    total = 0.0
    for r in days:
        total += float(r.get(key) or 0)
        if total >= threshold:
            return r["date"]
    return None


def _earned_single(days: list, key: str, threshold: float, cmp=lambda v, t: v >= t) -> str | None:
    for r in days:
        if cmp(float(r.get(key) or 0), threshold):
            return r["date"]
    return None


def _local(ts: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(float(ts))


def _streak_runs(active_days: list) -> list:
    """[(length, end_date)] for every run of consecutive active days."""
    runs = []
    prev = None
    run = 0
    end = None
    for d in sorted(active_days):
        day = dt.date.fromisoformat(d)
        if prev is not None and (day - prev).days == 1:
            run += 1
        else:
            if run:
                runs.append((run, end))
            run = 1
        prev, end = day, d
    if run:
        runs.append((run, end))
    return runs


def _streak_earned(active_days: list, n: int) -> str | None:
    """The day a streak first reached n days."""
    prev = None
    run = 0
    for d in sorted(active_days):
        day = dt.date.fromisoformat(d)
        run = run + 1 if prev is not None and (day - prev).days == 1 else 1
        prev = day
        if run >= n:
            return d
    return None


def _peak_parallel_by_day(facts: dict) -> dict:
    """{date: peak number of sessions working at once}."""
    by_day: dict[str, list] = {}
    for f in facts.values():
        for s0, e, _elapsed, _result in f["turns"]:
            by_day.setdefault(_local(e).strftime("%Y-%m-%d"), []).append((s0, e))
    out = {}
    for d, w in by_day.items():
        events = sorted([(s, 1) for s, _ in w] + [(e, -1) for _, e in w])
        cur = peak = 0
        for _, delta in events:
            cur += delta
            peak = max(peak, cur)
        out[d] = peak
    return out


def compute(all_days_desc: list, facts: dict, metas: dict, commits: list, first_date: str | None, today: str,
            plan_price: float | None = None) -> dict:
    days = sorted(all_days_desc, key=lambda r: r["date"])          # ascending, every day with anything
    active = [r["date"] for r in days if r.get("total") or r.get("commits") or r.get("active_seconds")]
    tot = {k: sum(float(r.get(k) or 0) for r in days) for k in ("total", "commits", "insertions", "deletions", "api_equivalent", "active_seconds")}
    sessions_all = len(metas)
    history_days = (dt.date.fromisoformat(today) - dt.date.fromisoformat(first_date)).days + 1 if first_date else 0
    price = float(plan_price or PLAN_PRICE_DEFAULT)
    plan_cost = price * max(1, math.ceil(max(history_days, 1) / 30))
    badges: list = []

    def add(bid, name, group, desc, value, threshold, earned, *, unit="", hidden=False, fmt=None):
        badges.append({"id": bid, "name": name, "group": group, "desc": desc, "value": value, "threshold": threshold, "unit": unit,
                       "progress": 1.0 if earned else (min(0.999, value / threshold) if threshold else 0.0), "earned": earned, "hidden": hidden, "fmt": fmt or unit})

    # ---- tokens, all time ----
    for bid, name, thr in (("first_chair", "First Chair", 10 * M), ("treeline", "Treeline", 100 * M), ("above_the_clouds", "Above the Clouds", 500 * M),
                           ("summit", "Summit", B), ("seven_summits", "Seven Summits", 5 * B), ("everest", "Everest", 10 * B), ("space_station", "Space Station", 50 * B)):
        add(bid, name, "tokens", f"{_big(thr)} tokens all time", tot["total"], thr, _earned_cumulative(days, "total", thr), fmt="tokens")
    # ---- tokens in a single day ----
    best_day = max(days, key=lambda r: r.get("total") or 0, default=None)
    best_tokens = float(best_day["total"]) if best_day else 0.0
    add("powder_day", "Powder Day", "tokens", "100M tokens in one day", best_tokens, 100 * M, _earned_single(days, "total", 100 * M), fmt="tokens")
    add("avalanche", "Avalanche", "tokens", "250M tokens in one day", best_tokens, 250 * M, _earned_single(days, "total", 250 * M), fmt="tokens")
    # ---- commits ----
    for bid, name, thr in (("dropped_in", "Dropped In", 1), ("session_regular", "Session Regular", 100), ("five_hundred_runs", "Five Hundred Runs", 500),
                           ("thousand_run_pass", "Thousand-Run Pass", 1000), ("lifer", "Lifer", 5000)):
        add(bid, name, "commits", f"{thr:,} commit{'s' if thr > 1 else ''} all time", tot["commits"], thr, _earned_cumulative(days, "commits", thr), fmt="int")
    best_commits = max((float(r.get("commits") or 0) for r in days), default=0.0)
    add("double_digits", "Double Digits", "commits", "10 commits in one day", best_commits, 10, _earned_single(days, "commits", 10), fmt="int")
    add("ripper", "Ripper", "commits", "25 commits in one day", best_commits, 25, _earned_single(days, "commits", 25), fmt="int")
    # ---- lines ----
    for bid, name, thr in (("bulldozer", "Bulldozer", 10_000), ("hundred_k_club", "Hundred-K Club", 100_000), ("quarter_million", "Quarter Million", 250_000), ("megaproject", "Megaproject", M)):
        add(bid, name, "lines", f"{_big(thr)} lines added all time", tot["insertions"], thr, _earned_cumulative(days, "insertions", thr), fmt="int")
    big_commit = max(commits, key=lambda c: int(c.get("insertions") or 0) + int(c.get("deletions") or 0), default=None)
    big_lines = (int(big_commit.get("insertions") or 0) + int(big_commit.get("deletions") or 0)) if big_commit else 0
    big_earned = next((c.get("date") for c in sorted(commits, key=lambda c: float(c.get("ts") or 0)) if int(c.get("insertions") or 0) + int(c.get("deletions") or 0) > 1000), None)
    add("big_air", "Big Air", "lines", "a single commit over 1,000 lines", big_lines, 1001, big_earned, fmt="int")
    kondo = next((r["date"] for r in days if (r.get("deletions") or 0) > (r.get("insertions") or 0) and (r.get("deletions") or 0) > 0), None)
    best_ratio = max((float(r.get("deletions") or 0) / max(1.0, float(r.get("insertions") or 0)) for r in days if r.get("deletions")), default=0.0)
    add("marie_kondo", "Marie Kondo", "lines", "a day with more lines removed than added", min(1.0, best_ratio), 1.0, kondo, fmt="ratio")
    add("clear_cut", "Clear-Cut", "lines", "10k lines removed all time", tot["deletions"], 10_000, _earned_cumulative(days, "deletions", 10_000), fmt="int")
    # ---- API equivalent ----
    best_api = max((float(r.get("api_equivalent") or 0) for r in days), default=0.0)
    add("whale", "Whale", "api", "$1k of API-equivalent usage in one day", best_api, 1000, _earned_single(days, "api_equivalent", 1000), fmt="usd")
    add("big_spender_day", "Big Spender Day", "api", "$2.5k of API-equivalent usage in one day", best_api, 2500, _earned_single(days, "api_equivalent", 2500), fmt="usd")
    for bid, name, thr in (("ten_k_club", "Ten-K Club", 10_000), ("season_pass_paid_off", "Season Pass Paid Off", 25_000), ("fund_manager", "Fund Manager", 100_000)):
        add(bid, name, "api", f"${thr:,} API-equivalent all time", tot["api_equivalent"], thr, _earned_cumulative(days, "api_equivalent", thr), fmt="usd")
    for mult in (10, 50, 100):
        thr = mult * plan_cost
        months = max(1, math.ceil(max(history_days, 1) / 30))
        add(f"paid_{mult}x", f"Paid for itself {mult}×", "api", f"{mult}× the plan price so far (${price:,.0f}/mo × {months} mo)",
            tot["api_equivalent"], thr, _earned_cumulative(days, "api_equivalent", thr), fmt="usd")
    # ---- agent time ----
    best_active = max((float(r.get("active_seconds") or 0) for r in days), default=0.0)
    add("full_shift", "Full Shift", "time", "8 hours of agent time in one day", best_active, 8 * 3600, _earned_single(days, "active_seconds", 8 * 3600), fmt="dur")
    for bid, name, hrs in (("day_one", "Day One", 24), ("hundred_hours", "Hundred Hours", 100), ("thousand_hours", "Thousand Hours", 1000)):
        add(bid, name, "time", f"{hrs:,} hours of agent time all time", tot["active_seconds"], hrs * 3600, _earned_cumulative(days, "active_seconds", hrs * 3600), fmt="dur")
    # ---- sessions ----
    best_sessions = max((float(r.get("sessions") or 0) for r in days), default=0.0)
    add("ten_agents", "Ten Agents, One Keyboard", "sessions", "10 sessions in one day", best_sessions, 10, _earned_single(days, "sessions", 10), fmt="int")
    created = sorted(d for d in ((m.get("created") and _local(m["created"]).strftime("%Y-%m-%d")) for m in metas.values()) if d)
    for bid, name, thr in (("fifty_sessions", "Fifty Sessions", 50), ("two_hundred", "Two Hundred", 200)):
        add(bid, name, "sessions", f"{thr} sessions all time", sessions_all, thr, created[thr - 1] if len(created) >= thr else None, fmt="int")
    # ---- streaks ----
    longest = max((n for n, _ in _streak_runs(active)), default=0)
    add("bluebird", "Bluebird", "streaks", "7 active days in a row", longest, 7, _streak_earned(active, 7), fmt="days")
    add("season_pass", "Season Pass", "streaks", "30 active days in a row", longest, 30, _streak_earned(active, 30), fmt="days")
    # ---- habits: time of day, parallelism, clean and hands-off sessions, long turns, long sessions ----
    dawn = night = None
    long_haul = None
    longest_turn = 0.0
    for sid, f in facts.items():
        for s0, e, elapsed, _r in f["turns"]:
            a, b = _local(s0), _local(e)
            d = b.strftime("%Y-%m-%d")
            if dawn is None and (5 <= a.hour < 7 or 5 <= b.hour < 7):
                dawn = d
            if night is None and (a.hour < 4 or b.hour < 4):
                night = d
            longest_turn = max(longest_turn, float(elapsed or 0))
            if long_haul is None and float(elapsed or 0) >= 1800:
                long_haul = d
    add("dawn_patrol", "Dawn Patrol", "habits", "a turn running between 5 and 7 in the morning", 1 if dawn else 0, 1, dawn, fmt="flag")
    add("night_shift", "Night Shift", "habits", "a turn running between midnight and 4", 1 if night else 0, 1, night, fmt="flag")
    add("long_haul", "Long Haul", "habits", "a single turn longer than 30 minutes", longest_turn, 1800, long_haul, fmt="dur")
    peaks = _peak_parallel_by_day(facts)
    best_peak = max(peaks.values(), default=0)
    rope = next((d for d in sorted(peaks) if peaks[d] >= 3), None)
    add("rope_team", "Three-Man Rope Team", "habits", "3 sessions working at the same time", best_peak, 3, rope, fmt="int")
    hands_off = clean_line = diamond = None
    best_tools_no_wait = best_tools_clean = best_turns = 0
    for sid, f in facts.items():
        ntools = len(f["tools"])
        nturns = len(f["turns"])
        last = max((e for _s, e, _el, _r in f["turns"]), default=None)
        d = _local(last).strftime("%Y-%m-%d") if last else None
        if not f["waits"]:
            best_tools_no_wait = max(best_tools_no_wait, ntools)
            if ntools >= 50 and d and (hands_off is None or d < hands_off):
                hands_off = d
        if not any(err for _ts, _n, err in f["tools"]):
            best_tools_clean = max(best_tools_clean, ntools)
            if ntools >= 25 and d and (clean_line is None or d < clean_line):
                clean_line = d
        best_turns = max(best_turns, nturns)
        if nturns >= 100 and d and (diamond is None or d < diamond):
            diamond = d
    add("hands_off", "Hands Off", "habits", "a session with 50 tool calls that never waited on you", best_tools_no_wait, 50, hands_off, fmt="int")
    add("clean_line", "Clean Line", "habits", "a session with 25 tool calls and not one failure", best_tools_clean, 25, clean_line, fmt="int")
    add("diamond_hands", "Diamond Hands", "habits", "a session you kept going for 100 turns", best_turns, 100, diamond, fmt="int")
    gas = next((r["date"] for r in days if float(r.get("input") or 0) >= M and float(r.get("cache_read") or 0) / float(r["input"]) >= 0.8), None)
    best_hit = max((float(r.get("cache_read") or 0) / float(r["input"]) for r in days if float(r.get("input") or 0) >= M), default=0.0)
    add("gas_saver", "Gas Saver", "habits", "a 1M-token day with an 80% cache hit rate", best_hit, 0.8, gas, fmt="pct")
    # ---- hidden: only shown once earned ----
    def day_matches(pred):
        return next((d for d in active if pred(dt.date.fromisoformat(d))), None)
    leap = day_matches(lambda x: x.month == 2 and x.day == 29)
    add("leap_day", "Leap Day", "hidden", "worked on February 29", 1 if leap else 0, 1, leap, hidden=True, fmt="flag")
    fri13 = next((c.get("date") for c in sorted(commits, key=lambda c: float(c.get("ts") or 0)) if c.get("date") and dt.date.fromisoformat(c["date"]).day == 13 and dt.date.fromisoformat(c["date"]).weekday() == 4), None)
    add("friday_13th", "Friday the 13th", "hidden", "a commit on a Friday the 13th", 1 if fri13 else 0, 1, fri13, hidden=True, fmt="flag")
    fresh = day_matches(lambda x: x.month == 1 and x.day == 1)
    add("fresh_tracks", "Fresh Tracks", "hidden", "worked on New Year's Day", 1 if fresh else 0, 1, fresh, hidden=True, fmt="flag")
    xmas = day_matches(lambda x: x.month == 12 and x.day == 25)
    add("holiday_shred", "Holiday Shred", "hidden", "worked on December 25", 1 if xmas else 0, 1, xmas, hidden=True, fmt="flag")
    # ---- the Powder Day record: biggest token day, earned again whenever it is beaten ----
    record = None
    beaten = []
    for r in days:
        v = float(r.get("total") or 0)
        if v >= 100 * M and (record is None or v > record["tokens"]):
            if record is not None:
                beaten.append(r["date"])
            record = {"tokens": v, "date": r["date"]}
    records = {"powder_day": {**record, "times_beaten": len(beaten), "history": beaten[-5:]} if record else None}

    earned = [b for b in badges if b["earned"]]
    locked = [b for b in badges if not b["earned"] and not b["hidden"]]
    next_up = sorted(locked, key=lambda b: -b["progress"])[:3]
    return {"badges": badges, "next_up": [b["id"] for b in next_up], "records": records,
            "earned": len(earned), "total": len([b for b in badges if not b["hidden"]]) + len([b for b in earned if b["hidden"]]),
            "plan_price": price, "plan_cost": plan_cost}


def _big(n: float) -> str:
    if n >= B:
        return f"{n / B:g}B"
    if n >= M:
        return f"{n / M:g}M"
    if n >= 1000:
        return f"{n / 1000:g}k"
    return f"{n:g}"
