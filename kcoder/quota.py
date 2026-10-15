"""The weekly plan limit meter: how much of the week's Claude plan allowance is
used, when it resets, the pace, and a forecast of when it runs out.

Two sources, labelled so the app always says which one it is:

- "provider": Claude Code reports the seven-day utilization and reset time
  with every request (rate_limit_event, see providers.plan_usage). This is
  the real number.
- "estimate": no report yet (or none since the window reset): tokens on the
  plan since the window started, against a weekly token limit the user set
  in Settings (config quota.limit_tokens), with the window resetting on
  quota.reset_weekday (0 = Monday) at quota.reset_hour local time.

Pace: used / elapsed. The forecast is linear: at this pace the limit is hit
at window_start + elapsed / utilization. It is marked reliable once six
hours of the window have passed or a fifth of the limit is used.

Quota shift (config quota.shift, off by default): while the forecast says
the limit runs out before the reset, small turns in sessions pinned to the
provider's large tier go to the small tier instead (shift_model). The
status bar shows it whenever it is active.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time

from . import paths, routing

WEEK = 7 * 86400
WARN_LEVELS = (0.75, 0.9)
WARN_PATH = os.path.join(paths.DATA_DIR, "quota-warned.json")
_cache: dict = {"at": 0.0, "status": None, "key": None}
STATUS_TTL = 15.0


def _cfg(cfg: dict | None) -> dict:
    if cfg is None:
        from . import config
        cfg = config.load()
    q = cfg.get("quota") or {}
    try:
        limit = max(0, int(q.get("limit_tokens") or 0))
    except (TypeError, ValueError):
        limit = 0
    try:
        wd = int(q.get("reset_weekday") or 0) % 7
    except (TypeError, ValueError):
        wd = 0
    try:
        hr = max(0, min(23, int(q.get("reset_hour") or 0)))
    except (TypeError, ValueError):
        hr = 0
    return {"limit_tokens": limit, "reset_weekday": wd, "reset_hour": hr, "shift": bool(q.get("shift"))}


def estimate_window(cfg: dict | None = None, now: float | None = None) -> tuple[float, float]:
    """(start, end) of the current week as the user defined it."""
    q = _cfg(cfg)
    d = dt.datetime.fromtimestamp(now or time.time())
    base = d.replace(hour=q["reset_hour"], minute=0, second=0, microsecond=0)
    start = base - dt.timedelta(days=(d.weekday() - q["reset_weekday"]) % 7)
    if start > d:
        start -= dt.timedelta(days=7)
    return start.timestamp(), (start + dt.timedelta(days=7)).timestamp()


def _plan_rows_since(start: float) -> list:
    from . import stats
    return [r for r in stats.usage_rows() if r.get("plan") and float(r.get("ts") or 0) >= start]


def _daily(rows: list, start: float, end: float, now: float) -> list:
    from . import stats
    per: dict = {}
    for r in rows:
        d = r.get("date") or stats.local_date(float(r.get("ts") or 0))
        per[d] = per.get(d, 0) + int(r.get("input") or 0) + int(r.get("output") or 0)
    out = []
    day = dt.datetime.fromtimestamp(start).date()
    last = dt.datetime.fromtimestamp(min(end, now)).date()
    while day <= last:
        key = day.isoformat()
        out.append({"date": key, "tokens": per.get(key, 0)})
        day += dt.timedelta(days=1)
    return out


def status(cfg: dict | None = None, now: float | None = None, fresh: bool = False) -> dict:
    """Everything the meter shows. Cached for a few seconds; `fresh` recomputes."""
    now = now or time.time()
    key = json.dumps(_cfg(cfg), sort_keys=True)
    if not fresh and _cache["status"] is not None and _cache["key"] == key and now - _cache["at"] < STATUS_TTL:
        return dict(_cache["status"])
    out = compute(cfg, now)
    _cache.update(at=now, status=out, key=key)
    return dict(out)


def invalidate() -> None:
    _cache["status"] = None


def compute(cfg: dict | None = None, now: float | None = None) -> dict:
    from .providers import plan_usage
    now = now or time.time()
    q = _cfg(cfg)
    out: dict = {"source": "none", "limit": "seven_day", "label": "weekly limit", "shift_enabled": q["shift"], "shift_active": False,
                 "limit_tokens": q["limit_tokens"], "reset_weekday": q["reset_weekday"], "reset_hour": q["reset_hour"], "now": now}
    try:
        usage = plan_usage()
    except Exception:  # noqa: BLE001
        usage = []
    prov = next((u for u in usage if u.get("limit") == "seven_day" and not u.get("stale") and u.get("resets_at")), None)
    short = next((u for u in usage if u.get("limit") == "five_hour" and not u.get("stale")), None)
    if short:
        out["five_hour"] = {"utilization": float(short.get("utilization") or 0.0), "resets_at": short.get("resets_at"), "seen": short.get("seen")}
    est_start, est_end = estimate_window(cfg, now)
    if prov:
        end = float(prov["resets_at"])
        start = end - WEEK
        util = max(0.0, min(1.0, float(prov.get("utilization") or 0.0)))
        rows = _plan_rows_since(start)
        out.update(source="provider", utilization=util, window_start=start, resets_at=end, seen=prov.get("seen"),
                   used_tokens=sum(int(r.get("input") or 0) + int(r.get("output") or 0) for r in rows),
                   source_label="from Claude Code's rate-limit reports, updated on every turn")
    elif q["limit_tokens"] > 0:
        start, end = est_start, est_end
        rows = _plan_rows_since(start)
        used = sum(int(r.get("input") or 0) + int(r.get("output") or 0) for r in rows)
        out.update(source="estimate", utilization=used / q["limit_tokens"], window_start=start, resets_at=end, used_tokens=used,
                   source_label=f"estimated from token history against your limit of {q['limit_tokens']:,} tokens a week (Settings)")
    else:
        rows = _plan_rows_since(est_start)
        out.update(window_start=est_start, resets_at=est_end, used_tokens=sum(int(r.get("input") or 0) + int(r.get("output") or 0) for r in rows),
                   source_label="no report from Claude Code yet; set a weekly token limit in Settings for an estimate")
        out["daily"] = _daily(rows, est_start, est_end, now)
        return out
    start, end, util = out["window_start"], out["resets_at"], out["utilization"]
    total = max(1.0, end - start)
    elapsed = max(60.0, min(total, now - start))
    out["elapsed_fraction"] = elapsed / total
    out["daily"] = _daily(rows, start, end, now)
    out["level"] = "full" if util >= 1 else "warn90" if util >= 0.9 else "warn75" if util >= 0.75 else "ok"
    reliable = elapsed >= 6 * 3600 or util >= 0.2
    out["forecast_reliable"] = reliable
    if util > 0:
        hit = start + elapsed / util
        out["forecast_hit"] = hit
        out["projected_at_reset"] = util * total / elapsed
        out["on_track"] = hit >= end
    else:
        out["on_track"] = True
    out["shift_active"] = bool(q["shift"] and reliable and util < 1 and not out["on_track"])
    return out


def _load_warned() -> dict:
    try:
        with open(WARN_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def check_warnings(st: dict | None = None) -> str | None:
    """Once per window per threshold (75%, 90%): the warning text, else None."""
    from .providers import _when
    st = st or status()
    if st.get("source") == "none" or st.get("utilization") is None:
        return None
    key = f"{st['source']}:{int(st['window_start'])}"
    data = _load_warned()
    done = set(float(x) for x in data.get(key) or [])
    util = float(st["utilization"])
    hit = None
    for level in sorted(WARN_LEVELS, reverse=True):
        if util >= level and level not in done:
            hit = level
            break
    if hit is None:
        return None
    done.update(l for l in WARN_LEVELS if l <= hit)
    try:
        paths.ensure_data_dir()
        with open(WARN_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump({key: sorted(done)}, f)
        os.replace(WARN_PATH + ".tmp", WARN_PATH)
    except OSError:
        pass
    pct = int(round(util * 100))
    msg = f"Weekly plan limit at {pct}% (resets {_when(st.get('resets_at'))})."
    if st.get("forecast_hit") and not st.get("on_track"):
        msg += f" At this pace you hit it {_when(st['forecast_hit'])}."
    elif st.get("projected_at_reset") is not None:
        msg += f" On pace for about {int(round(min(1.0, st['projected_at_reset']) * 100))}% at the reset."
    if st.get("shift_active"):
        msg += " Small turns are going to the cheaper model."
    return msg


def shift_model(provider, model: str, text: str, context_tokens: int, cfg: dict | None = None) -> str | None:
    """The cheaper model a pinned turn should use while the quota shift is
    active, or None to leave it alone."""
    st = status(cfg)
    if not st.get("shift_active"):
        return None
    tiers = routing.tiers_for(provider, cfg)
    small, large = tiers.get("small"), tiers.get("large")
    if not small or not large or model == small:
        return None
    from .providers import model_family
    same = model == large or (provider.kind in ("claude", "anthropic") and model_family(model) == model_family(large) and model_family(model) != "other")
    if not same:
        return None
    if routing.classify(text, context_tokens) != "small":
        return None
    return small
