"""Conditions: fresh snow at a fixed place (Alta by default), bitcoin's 24 h
move and the moon, for the app's header accent and three secret badges.

Free sources, no keys: Open-Meteo for the snow (hourly snowfall, summed
over the last 24 h at the place's own time), CoinGecko for bitcoin with
Binance as the fallback, and arithmetic for the moon. The daemon refreshes
every 30 minutes (``REFRESH``) and keeps the last good value of each source
when a fetch fails; the app treats a value older than 12 hours (``STALE``)
as nothing. The state lives in ``conditions.json`` in the data dir so a
daemon restart starts from the last reading, and the same file holds the
unlock ledger for the badges: the first powder day (6 in or more in 24 h),
a 10% bitcoin day, and a session on a full-moon night.

``KCODER_CONDITIONS=off`` disables the fetches (the smoke test);
``KCODER_CONDITIONS_FAKE=<json file>`` reads ``{"snow_in", "btc_pct",
"btc_price", "moon_full"}`` from the file instead of the network (the
headless-Chrome harness)."""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
import os
import threading
import time
import urllib.parse
import urllib.request

from . import paths

log = logging.getLogger("kcoder.conditions")

STATE_PATH = os.path.join(paths.DATA_DIR, "conditions.json")
DEFAULT_PLACE = {"name": "Alta", "lat": 40.5884, "lon": -111.6386}
DEFAULTS = {"enabled": True, "snow": True, "btc": True, "moon": True, "place": dict(DEFAULT_PLACE)}
REFRESH = 30 * 60            # seconds between refreshes
STALE = 12 * 3600            # a reading older than this is shown as nothing
SNOW_MIN_IN = 1.0            # fresh snow worth showing
POWDER_IN = 6.0              # the badge's powder day
BTC_BIG = 5.0                # a badge on the ridgeline from here
BTC_TEN = 10.0               # the secret badge
TIMEOUT = 8
SYNODIC = 29.530588853       # days
# a known new moon: 2000-01-06 18:14 UTC
NEW_MOON_EPOCH = dt.datetime(2000, 1, 6, 18, 14, tzinfo=dt.timezone.utc).timestamp()

_lock = threading.Lock()
_state: dict | None = None


# ---- settings ----

def settings(cfg: dict | None) -> dict:
    """The conditions block of the config with every key present."""
    c = dict(DEFAULTS)
    c["place"] = dict(DEFAULT_PLACE)
    raw = (cfg or {}).get("conditions") or {}
    for k in ("enabled", "snow", "btc", "moon"):
        if k in raw:
            c[k] = bool(raw[k])
    place = raw.get("place") or {}
    try:
        lat, lon = float(place.get("lat")), float(place.get("lon"))
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            c["place"] = {"name": str(place.get("name") or "").strip()[:40] or DEFAULT_PLACE["name"], "lat": lat, "lon": lon}
    except (TypeError, ValueError):
        pass
    return c


def disabled() -> bool:
    return os.environ.get("KCODER_CONDITIONS", "").lower() in ("off", "0", "no")


def _fake() -> dict | None:
    p = os.environ.get("KCODER_CONDITIONS_FAKE")
    if not p:
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ---- state file ----

def _load() -> dict:
    global _state
    with _lock:
        if _state is None:
            try:
                with open(STATE_PATH, "r", encoding="utf-8") as f:
                    _state = json.load(f)
            except (OSError, ValueError):
                _state = {}
            if not isinstance(_state, dict):
                _state = {}
            _state.setdefault("unlocks", {})
        return _state


def _save(state: dict) -> None:
    tmp = STATE_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, STATE_PATH)
    except OSError as exc:
        log.warning("could not save conditions: %s", exc)


# ---- sources ----

def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "kcoder (conditions)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_snow(place: dict) -> dict:
    """Inches of snow in the last 24 h at the place (Open-Meteo)."""
    fake = _fake()
    if fake is not None:
        return {"inches": float(fake.get("snow_in") or 0), "place": place["name"]}
    q = urllib.parse.urlencode({"latitude": place["lat"], "longitude": place["lon"], "hourly": "snowfall",
                                "past_days": 1, "forecast_days": 1, "timezone": "auto", "precipitation_unit": "inch"})
    data = _get_json("https://api.open-meteo.com/v1/forecast?" + q)
    hourly = data.get("hourly") or {}
    times, falls = hourly.get("time") or [], hourly.get("snowfall") or []
    offset = int(data.get("utc_offset_seconds") or 0)
    now_local = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset)
    cutoff = now_local - dt.timedelta(hours=24)
    total = 0.0
    for t, v in zip(times, falls):
        try:
            when = dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        if cutoff < when <= now_local and v is not None:
            total += float(v)
    return {"inches": round(total, 1), "place": place["name"]}


def fetch_btc() -> dict:
    """Bitcoin's 24 h move in percent and the price (CoinGecko, then Binance)."""
    fake = _fake()
    if fake is not None:
        return {"pct": float(fake.get("btc_pct") or 0), "price": float(fake.get("btc_price") or 0)}
    try:
        data = _get_json("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true")
        b = data["bitcoin"]
        return {"pct": round(float(b["usd_24h_change"]), 2), "price": float(b["usd"])}
    except Exception as exc:  # noqa: BLE001
        log.info("coingecko failed (%s), trying binance", exc)
    data = _get_json("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
    return {"pct": round(float(data["priceChangePercent"]), 2), "price": float(data["lastPrice"])}


def moon(now: float | None = None) -> dict:
    """Phase (0 new, .5 full), illumination and whether it is a full-moon
    night here: within 18 h of the full moon and after dark (18:00 to 06:00
    local)."""
    fake = _fake()
    ts = now if now is not None else time.time()
    age = ((ts - NEW_MOON_EPOCH) / 86400.0) % SYNODIC
    phase = age / SYNODIC
    illum = (1 - math.cos(2 * math.pi * phase)) / 2
    near_full = abs(age - SYNODIC / 2) <= 0.75
    hour = dt.datetime.fromtimestamp(ts).hour
    night = hour >= 18 or hour < 6
    if fake is not None and "moon_full" in fake:
        near_full = bool(fake["moon_full"])
        night = True
    return {"phase": round(phase, 3), "illumination": round(illum, 2), "near_full": near_full, "night": night,
            "full": near_full and night}


# ---- refresh ----

def refresh(cfg: dict | None) -> dict:
    """Fetch every enabled source, keep the last good value where a fetch
    fails, record the badge unlocks and save."""
    c = settings(cfg)
    state = _load()
    now = time.time()
    if c["enabled"] and c["snow"] and not disabled():
        try:
            s = fetch_snow(c["place"])
            state["snow"] = {**s, "at": now}
            if s["inches"] >= POWDER_IN:
                _unlock(state, "powder")
        except Exception as exc:  # noqa: BLE001
            log.info("snow fetch failed: %s", exc)
            state.setdefault("snow", {})["error"] = str(exc)[:120]
    if c["enabled"] and c["btc"] and not disabled():
        try:
            b = fetch_btc()
            state["btc"] = {**b, "at": now}
            if abs(b["pct"]) >= BTC_TEN:
                _unlock(state, "btc10")
        except Exception as exc:  # noqa: BLE001
            log.info("btc fetch failed: %s", exc)
            state.setdefault("btc", {})["error"] = str(exc)[:120]
    state["refreshed_at"] = now
    _save(state)
    return payload(cfg)


def _unlock(state: dict, key: str) -> bool:
    un = state.setdefault("unlocks", {})
    if key in un:
        return False
    un[key] = dt.date.today().isoformat()
    return True


def note_session_turn() -> bool:
    """Called when a turn starts: a full-moon night earns the badge. Returns
    True the first time."""
    if not moon()["full"]:
        return False
    state = _load()
    if _unlock(state, "moon"):
        _save(state)
        return True
    return False


def unlocks() -> dict:
    """The badge ledger: {"powder": date, "btc10": date, "moon": date}."""
    return dict(_load().get("unlocks") or {})


def payload(cfg: dict | None) -> dict:
    """What the app gets: the settings, each source's last reading with its
    age, the moon now, and the condition picked by priority (snow, then a
    big bitcoin day, then the full moon). The app still decides about dark
    mode and reduced motion."""
    c = settings(cfg)
    state = _load()
    now = time.time()
    snow = dict(state.get("snow") or {})
    btc = dict(state.get("btc") or {})
    for src in (snow, btc):
        src["stale"] = "at" not in src or now - float(src.get("at") or 0) > STALE
    m = moon(now)
    active = None
    if c["enabled"]:
        if c["snow"] and not snow["stale"] and float(snow.get("inches") or 0) >= SNOW_MIN_IN:
            active = "snow"
        elif c["btc"] and not btc["stale"] and abs(float(btc.get("pct") or 0)) >= BTC_BIG:
            active = "btc"
        elif c["moon"] and m["full"]:
            active = "moon"
    return {"settings": c, "snow": snow, "btc": btc, "moon": m, "active": active, "now": now,
            "unlocks": dict(state.get("unlocks") or {}), "refreshed_at": state.get("refreshed_at")}
