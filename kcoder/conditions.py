"""Conditions: fresh snow at the nearest ski area (or a pinned place),
bitcoin's 24 h move and the moon, for the app's header accent and three
secret badges.

Free sources, no keys: Open-Meteo for the snow (hourly snowfall, summed
over the last 24 h at the place's own time), CoinGecko for bitcoin with
Binance as the fallback, and arithmetic for the moon. With ``follow`` on
(the default) the daemon asks an IP geolocation service (ipinfo.io, then
ipapi.co, then ipwho.is) where the Mac is, to the city, and reads the snow
at the nearest of the ski areas in ``data/ski_areas.json`` within
``FOLLOW_MAX_KM``; farther from any, it reads the snow at the city itself.
The IP itself is never kept, only the city and the coordinates. With
``follow`` off the place in the config is used as it is. The daemon refreshes
every 30 minutes (``REFRESH``) and keeps the last good value of each source
when a fetch fails; the app treats a value older than 12 hours (``STALE``)
as nothing. The state lives in ``conditions.json`` in the data dir so a
daemon restart starts from the last reading, and the same file holds the
unlock ledger for the badges: the first powder day (6 in or more in 24 h),
a 10% bitcoin day, and a session on a full-moon night.

``KCODER_CONDITIONS=off`` disables the fetches (the smoke test);
``KCODER_CONDITIONS_FAKE=<json file>`` reads ``{"snow_in", "btc_pct",
"btc_price", "moon_full", "lat", "lon", "city", "region"}`` from the file
instead of the network (the headless-Chrome harness)."""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
import os
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import paths

log = logging.getLogger("kcoder.conditions")

STATE_PATH = os.path.join(paths.DATA_DIR, "conditions.json")
DEFAULT_PLACE = {"name": "Alta", "lat": 40.5884, "lon": -111.6386}
DEFAULTS = {"enabled": True, "snow": True, "btc": True, "moon": True, "follow": True, "place": dict(DEFAULT_PLACE)}
FOLLOW_MAX_KM = 300.0        # a ski area farther than this is not "near"; the snow is read at the city instead
AREAS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ski_areas.json")
LOCATE_URLS = ("https://ipinfo.io/json", "https://ipapi.co/json/", "https://ipwho.is/")
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
    for k in ("enabled", "snow", "btc", "moon", "follow"):
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

def _ssl_context():
    """The python.org Python on a Mac ships its own (often empty) trust
    store, so plain urllib fails with "certificate verify failed" on a Mac
    that has a security proxy or no `Install Certificates` run; certifi's
    bundle (installed with kcoder's dependencies) is used when it is there."""
    try:
        import certifi  # noqa: PLC0415
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return None


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "kcoder (conditions)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ssl_context()) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc) or not shutil.which("curl"):
            raise
        # the system's own trust store, through curl (always on a Mac): the last resort when Python's bundle is refused
        r = subprocess.run(["curl", "-fsSL", "--max-time", str(TIMEOUT), "-H", "User-Agent: kcoder (conditions)", "-H", "Accept: application/json", url],
                           capture_output=True, text=True, timeout=TIMEOUT + 5)
        if r.returncode != 0:
            raise RuntimeError(f"curl failed ({r.returncode}): {(r.stderr or '').strip()[:100]}") from exc
        return json.loads(r.stdout)


def fetch_snow(place: dict) -> dict:
    """Inches of snow in the last 24 h at the place (Open-Meteo), plus a day
    table for the detail view: the last 7 days and the next 7 (``days``:
    date, snow_in, precip_in, hi, lo in °F, forecast flag)."""
    fake = _fake()
    if fake is not None:
        days = [{"date": d[0], "snow_in": float(d[1]), "precip_in": float(d[2]), "hi": d[3], "lo": d[4],
                 "forecast": d[0] > dt.date.today().isoformat()} for d in (fake.get("snow_days") or [])]
        return {"inches": float(fake.get("snow_in") or 0), "place": place["name"], "days": days}
    q = urllib.parse.urlencode({"latitude": place["lat"], "longitude": place["lon"], "hourly": "snowfall",
                                "daily": "snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min",
                                "past_days": 7, "forecast_days": 7, "timezone": "auto", "precipitation_unit": "inch",
                                "temperature_unit": "fahrenheit"})
    data = _get_json("https://api.open-meteo.com/v1/forecast?" + q)
    daily = data.get("daily") or {}
    offset = int(data.get("utc_offset_seconds") or 0)
    today = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset)).date().isoformat()
    days = []
    for i, date in enumerate(daily.get("time") or []):
        def at(key):
            v = (daily.get(key) or [None] * (i + 1))[i] if i < len(daily.get(key) or []) else None
            return None if v is None else round(float(v), 1)
        days.append({"date": date, "snow_in": at("snowfall_sum") or 0.0, "precip_in": at("precipitation_sum") or 0.0,
                     "hi": at("temperature_2m_max"), "lo": at("temperature_2m_min"), "forecast": date > today})
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
    return {"inches": round(total, 1), "place": place["name"], "days": days}


def fetch_btc() -> dict:
    """Bitcoin's 24 h move in percent and the price (CoinGecko, then Binance)."""
    fake = _fake()
    if fake is not None:
        return {"pct": float(fake.get("btc_pct") or 0), "price": float(fake.get("btc_price") or 0),
                "week": [{"t": float(t), "price": float(p)} for t, p in (fake.get("btc_week") or [])]}
    try:
        data = _get_json("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true")
        b = data["bitcoin"]
        out = {"pct": round(float(b["usd_24h_change"]), 2), "price": float(b["usd"])}
        week = _btc_week_coingecko()
    except Exception as exc:  # noqa: BLE001
        log.info("coingecko failed (%s), trying binance", exc)
        data = _get_json("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
        out = {"pct": round(float(data["priceChangePercent"]), 2), "price": float(data["lastPrice"])}
        week = _btc_week_binance()
    out["week"] = week
    return out


def _btc_week_coingecko() -> list:
    """Daily closes for the last week, oldest first; [] when the call fails
    (the badge does not need it)."""
    try:
        data = _get_json("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily")
        return [{"t": float(t) / 1000, "price": round(float(p), 2)} for t, p in (data.get("prices") or [])][-8:]
    except Exception as exc:  # noqa: BLE001
        log.info("coingecko week failed: %s", exc)
        return []


def _btc_week_binance() -> list:
    try:
        rows = _get_json("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=8")
        return [{"t": float(r[6]) / 1000, "price": round(float(r[4]), 2)} for r in rows]
    except Exception as exc:  # noqa: BLE001
        log.info("binance week failed: %s", exc)
        return []


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


# ---- where the Mac is ----

_areas: list | None = None


def areas() -> list:
    """The bundled ski areas: [name, region, lat, lon] each."""
    global _areas
    if _areas is None:
        try:
            with open(AREAS_PATH, "r", encoding="utf-8") as f:
                _areas = [a for a in json.load(f) if isinstance(a, list) and len(a) == 4]
        except (OSError, ValueError) as exc:
            log.warning("ski areas list unreadable: %s", exc)
            _areas = []
    return _areas


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def nearest_area(lat: float, lon: float) -> dict | None:
    """The closest bundled ski area within FOLLOW_MAX_KM, with its distance,
    or None when nothing is that near."""
    best = None
    for name, region, alat, alon in areas():
        d = distance_km(lat, lon, alat, alon)
        if best is None or d < best["km"]:
            best = {"name": name, "region": region, "lat": alat, "lon": alon, "km": round(d)}
    if best is None or best["km"] > FOLLOW_MAX_KM:
        return None
    return best


def _parse_location(d: dict) -> dict:
    """ipinfo (loc: "lat,lon"), ipapi.co and ipwho.is (latitude, longitude);
    all three give city and region."""
    if "loc" in d:
        lat, lon = (float(x) for x in str(d["loc"]).split(",")[:2])
    else:
        lat, lon = float(d["latitude"]), float(d["longitude"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("coordinates out of range")
    city = str(d.get("city") or "").strip()[:40]
    region = str(d.get("region") or d.get("region_name") or "").strip()[:40]
    return {"lat": lat, "lon": lon, "city": city, "region": region}


def locate() -> dict:
    """Where the Mac is, to the city, from its public IP: {"lat", "lon",
    "city", "region"}. The IP is not returned. Raises when every service
    fails (offline, or all three refused)."""
    fake = _fake()
    if fake is not None:
        if fake.get("lat") is None:
            raise RuntimeError("fake has no location")
        return _parse_location({"latitude": fake["lat"], "longitude": fake["lon"], "city": fake.get("city") or "",
                                "region": fake.get("region") or ""})
    last = None
    for url in LOCATE_URLS:
        try:
            return _parse_location(_get_json(url))
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"location lookup failed: {last}")


def resolve_place(c: dict, state: dict) -> dict:
    """The place to read the snow at. Pinned (follow off): the config's
    place. Follow on: locate the Mac (the last location is kept when the
    lookup fails), then the nearest ski area within FOLLOW_MAX_KM, or the
    city itself when none is that near; the config's place when there has
    never been a location."""
    if not c.get("follow"):
        return dict(c["place"])
    loc = None
    try:
        loc = locate()
        state["location"] = {**loc, "at": time.time()}
        state["location"].pop("error", None)
    except Exception as exc:  # noqa: BLE001
        log.info("location lookup failed: %s", exc)
        prev = state.get("location") or {}
        if prev.get("lat") is not None:
            loc = prev
            state["location"]["error"] = str(exc)[:120]
        else:
            state["location"] = {"error": str(exc)[:120]}
    if loc is None:
        return dict(c["place"])
    where = ", ".join(x for x in (loc.get("city"), loc.get("region")) if x)
    area = nearest_area(loc["lat"], loc["lon"])
    if area:
        return {"name": area["name"], "lat": area["lat"], "lon": area["lon"], "near": where, "km": area["km"], "followed": True}
    return {"name": loc.get("city") or "here", "lat": loc["lat"], "lon": loc["lon"], "near": where, "km": 0, "followed": True}


# ---- refresh ----

def refresh(cfg: dict | None) -> dict:
    """Fetch every enabled source, keep the last good value where a fetch
    fails, record the badge unlocks and save."""
    c = settings(cfg)
    state = _load()
    now = time.time()
    if c["enabled"] and c["snow"] and not disabled():
        try:
            place = resolve_place(c, state)
            s = fetch_snow(place)
            state["snow"] = {**s, "at": now, "followed": bool(place.get("followed")), "near": place.get("near") or "",
                             "km": place.get("km"), "lat": place["lat"], "lon": place["lon"]}
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
            "location": dict(state.get("location") or {}),
            "unlocks": dict(state.get("unlocks") or {}), "refreshed_at": state.get("refreshed_at")}
