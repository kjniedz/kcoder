"""kcoder on a phone, through a relay you host. Opt-in, off by default.

The Mac never opens an inbound port: the daemon keeps one outbound websocket
(the tunnel) to the relay (relay/ in the kcoder repo, a Cloudflare Worker),
and every phone opens the relay's /m/<install>/ page, which is kcoder's own
web app served through that tunnel, then a websocket the relay pairs with a
fresh connection to this daemon's own socket. Every frame between the phone
and the daemon is sealed with AES-GCM under a key that rides only in the QR
code's URL fragment, so the relay sees which Mac the bytes are for and
nothing else. The relay token (a hash of the key) is what a phone shows the
relay to be let through; rotating the key cuts every phone off until it
scans again. Push notifications go through the relay to the phones that
asked for them.

<data dir>/phone.json: {"relay", "install_id", "install_token", "key"}
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import ssl
import time
import urllib.error
import urllib.request

from . import __version__, compat, paths

log = logging.getLogger("kcoderd")
STATE_PATH = os.path.join(paths.DATA_DIR, "phone.json")
CHUNK = 180_000          # base64 characters per tunnel frame for a file (the relay's frames stay well under its limit)
DEFAULT_RELAY = "https://kcoder-relay.kyle-d12.workers.dev"


class PhoneError(Exception):
    pass


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def relay_token(key: bytes) -> str:
    """What a phone shows the relay: derived from the key, reveals nothing of it."""
    return _b64u(hashlib.sha256(b"kcoder-relay-token" + key).digest())


def _aesgcm(key: bytes):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:   # the package is in kcoder's dependencies; an old install may predate it
        raise PhoneError("the phone needs the cryptography package: run the updater (or pip install cryptography) and restart kcoderd") from exc
    return AESGCM(key)


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(paths.DATA_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)
    os.chmod(STATE_PATH, 0o600)


USER_AGENT = f"kcoder/{__version__}"   # Cloudflare turns the default Python agent away at the door


def _ssl_context():
    """The python.org Python on a Mac ships an often empty trust store: certifi's bundle
    (installed with kcoder's dependencies) is used when it is there, like conditions does."""
    try:
        import certifi  # noqa: PLC0415
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return None


def _call(relay: str, method: str, path: str, token: str | None = None, body: dict | None = None, timeout: int = 20, headers: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(relay.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context() if relay.startswith("https://") else None) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            msg = json.loads(exc.read()).get("error") or f"HTTP {exc.code}"
        except Exception:  # noqa: BLE001
            msg = f"HTTP {exc.code}"
        raise PhoneError(f"relay: {msg}")
    except (urllib.error.URLError, OSError) as exc:
        raise PhoneError(f"relay unreachable: {exc}")


class Phone:
    """Daemon-side: the tunnel and the relay API. `local_connect()` opens a
    websocket to this daemon's own listener (the phone's frames go through it
    like any client's, token and all); `serve_file(path)` returns
    (status, content_type, bytes) for the web app's files."""

    def __init__(self, loop: asyncio.AbstractEventLoop, token: str, local_connect, serve_file, version: str = __version__):
        self.loop = loop
        self.token = token
        self.version = version      # what the relay caches the web app's files under: the release plus a hash of the files, so a checkout's edits are not served stale
        self.local_connect = local_connect
        self.serve_file = serve_file
        self.state = load_state()
        self.connected = False
        self.last_error: str | None = None
        self.phones = 0
        self._task: asyncio.Task | None = None
        self._ws = None
        self._channels: dict[str, object] = {}
        self._pumps: dict[str, asyncio.Task] = {}
        self.on_phones = lambda n: None

    # -- setup -----------------------------------------------------------

    @property
    def relay(self) -> str | None:
        return self.state.get("relay")

    def enabled(self) -> bool:
        return bool(self.state.get("install_id") and self.state.get("install_token") and self.state.get("key") and self.relay)

    def _key(self) -> bytes:
        return _unb64u(self.state["key"])

    def enable(self, relay: str | None) -> dict:
        relay = (relay or DEFAULT_RELAY).strip().rstrip("/")
        if not relay.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise PhoneError("the relay URL must be https:// (or a local http://127.0.0.1 for testing)")
        _aesgcm(secrets.token_bytes(32))   # fail now, not on the first phone, if the cipher is missing
        if self.state.get("relay") == relay and self.enabled():
            self.start()
            return self.status()
        r = _call(relay, "POST", "/v1/installs", body={"name": compat.hostname()})
        self.state = {"relay": relay, "install_id": r["install_id"], "install_token": r["install_token"], "key": _b64u(secrets.token_bytes(32))}
        self._register_key()
        save_state(self.state)
        self.start()
        return self.status()

    def _register_key(self) -> None:
        self._api("POST", f"/v1/installs/{self.state['install_id']}/key", body={"rt": relay_token(self._key()), "version": self.version})

    def rotate(self) -> dict:
        """A new key: every phone paired so far is cut off until it scans again."""
        if not self.enabled():
            raise PhoneError("the phone is not enabled")
        self.state["key"] = _b64u(secrets.token_bytes(32))
        self._register_key()
        save_state(self.state)
        return self.status()

    def disable(self) -> None:
        self.stop()
        if self.enabled():
            try:
                self._api("DELETE", f"/v1/installs/{self.state['install_id']}")
            except PhoneError as exc:
                log.info("phone: disable: %s", exc)
        self.state = {}
        try:
            os.remove(STATE_PATH)
        except FileNotFoundError:
            pass

    def _api(self, method: str, path: str, body: dict | None = None) -> dict:
        if not self.state.get("install_token"):
            raise PhoneError("the phone is not enabled")
        return _call(self.relay, method, path, self.state["install_token"], body)

    def pair_url(self) -> str:
        """The QR code's URL: the page on the relay, with the daemon token and the key in the fragment (never sent to the relay)."""
        if not self.enabled():
            raise PhoneError("the phone is not enabled")
        return f"{self.relay}/m/{self.state['install_id']}/#token={self.token}&key={self.state['key']}"

    def revoke(self, device_id: str) -> None:
        self._api("DELETE", f"/v1/installs/{self.state['install_id']}/devices/{device_id}")

    def status(self) -> dict:
        out = {"enabled": self.enabled(), "relay": self.relay, "connected": self.connected, "error": self.last_error, "devices": [], "phones": self.phones, "url": None}
        if self.enabled():
            out["url"] = f"{self.relay}/m/{self.state['install_id']}/"
            try:
                st = self._api("GET", f"/v1/installs/{self.state['install_id']}/status")
                out["devices"] = st.get("devices") or []
                out["phones"] = int(st.get("phones") or 0)
            except PhoneError as exc:
                out["error"] = str(exc)
        return out

    def push(self, title: str, body: str, url: str = "", tag: str = "kcoder") -> int:
        """A push notification to every phone that asked for them; returns how many were sent."""
        if not self.enabled():
            return 0
        try:
            return int(self._api("POST", f"/v1/installs/{self.state['install_id']}/push", body={"title": title, "body": body, "url": url, "tag": tag}).get("pushed") or 0)
        except PhoneError as exc:
            log.info("phone: push: %s", exc)
            return 0

    # -- the tunnel -------------------------------------------------------

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = self.loop.create_task(self._run())

    def stop(self) -> None:
        self.connected = False
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def _seal(self, text: str) -> str:
        nonce = secrets.token_bytes(12)
        return _b64u(nonce + _aesgcm(self._key()).encrypt(nonce, text.encode(), None))

    def _open(self, data: str) -> str:
        raw = _unb64u(data)
        return _aesgcm(self._key()).decrypt(raw[:12], raw[12:], None).decode()

    async def _run(self) -> None:
        from websockets.asyncio.client import connect
        backoff = 2.0
        while self.enabled():
            url = self.relay.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + f"/v1/installs/{self.state['install_id']}/tunnel"
            try:
                async with connect(url, additional_headers={"Authorization": f"Bearer {self.state['install_token']}", "User-Agent": USER_AGENT}, ssl=_ssl_context() if url.startswith("wss://") else None, max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20) as ws:
                    self._ws = ws
                    self.connected = True
                    self.last_error = None
                    backoff = 2.0
                    await ws.send(json.dumps({"op": "hello", "version": self.version}))
                    async for raw in ws:
                        try:
                            m = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        await self._dispatch(m)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)[:200]
                log.info("phone: tunnel closed (%s); reconnecting in %.0fs", exc, backoff)
            finally:
                self.connected = False
                self._ws = None
                await self._close_all()
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                break
            backoff = min(60.0, backoff * 2)
        self.connected = False

    async def _send(self, obj: dict) -> None:
        ws = self._ws
        if ws is not None:
            try:
                await ws.send(json.dumps(obj))
            except Exception:  # noqa: BLE001
                pass

    async def _dispatch(self, m: dict) -> None:
        op = m.get("op")
        ch = m.get("ch")
        if op == "open" and ch:
            if ch in self._channels:
                return
            try:
                local = await self.local_connect()
            except Exception as exc:  # noqa: BLE001
                log.warning("phone: could not open a local connection: %s", exc)
                await self._send({"op": "close", "ch": ch, "code": 4500, "reason": "kcoderd could not take the connection"})
                return
            self._channels[ch] = local
            self._pumps[ch] = self.loop.create_task(self._pump(ch, local))
            self._set_phones()
        elif op == "msg" and ch:
            local = self._channels.get(ch)
            if local is None:
                await self._send({"op": "close", "ch": ch, "code": 4404, "reason": "no such channel"})
                return
            try:
                text = self._open(str(m.get("data") or ""))
            except Exception:  # noqa: BLE001  a frame the key does not open: a phone with an old key, or noise
                await self._send({"op": "close", "ch": ch, "code": 4401, "reason": "the pairing key changed: scan the QR code again"})
                await self._drop(ch)
                return
            try:
                await local.send(text)
            except Exception:  # noqa: BLE001
                await self._drop(ch)
        elif op == "close" and ch:
            await self._drop(ch)
        elif op == "http":
            await self._http(m)

    async def _pump(self, ch: str, local) -> None:
        """The daemon's frames for one phone, sealed, to the relay."""
        try:
            async for raw in local:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                await self._send({"op": "msg", "ch": ch, "data": self._seal(raw)})
        except Exception:  # noqa: BLE001
            pass
        finally:
            if self._channels.get(ch) is local:
                self._channels.pop(ch, None)
                self._pumps.pop(ch, None)
                await self._send({"op": "close", "ch": ch})
                self._set_phones()

    async def _drop(self, ch: str) -> None:
        local = self._channels.pop(ch, None)
        task = self._pumps.pop(ch, None)
        if task is not None:
            task.cancel()
        if local is not None:
            try:
                await local.close()
            except Exception:  # noqa: BLE001
                pass
        self._set_phones()

    async def _close_all(self) -> None:
        for ch in list(self._channels):
            await self._drop(ch)

    def _set_phones(self) -> None:
        n = len(self._channels)
        if n != self.phones:
            self.phones = n
            try:
                self.on_phones(n)
            except Exception:  # noqa: BLE001
                pass

    async def _http(self, m: dict) -> None:
        rid = m.get("id")
        try:
            status, ctype, body = await self.loop.run_in_executor(None, self.serve_file, str(m.get("path") or "/"))
        except Exception as exc:  # noqa: BLE001
            status, ctype, body = 500, "text/plain; charset=utf-8", str(exc).encode()
        data = _b64u(body)
        if not data:
            await self._send({"op": "http", "id": rid, "status": status, "ctype": ctype, "body": "", "more": False})
            return
        for i in range(0, len(data), CHUNK):
            part = data[i:i + CHUNK]
            await self._send({"op": "http", "id": rid, "status": status, "ctype": ctype, "body": part, "more": i + CHUNK < len(data)})
