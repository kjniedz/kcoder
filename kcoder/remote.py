"""Remote approvals from a phone. Opt-in, off by default.

The Mac never opens an inbound port: the daemon keeps one outbound
connection (server-sent events) to a relay you host (relay/ in the kcoder
repo, a Cloudflare Worker), posts approval requests to it, and receives
decisions over that same connection. Phones pair once through a QR code,
get a Web Push notification per request, and open a page on the relay that
shows exactly what is being approved. Approvals expire after
`remote.ttl_minutes`; revoking a device is one call.

<data dir>/remote.json: {"relay", "install_id", "install_token"}
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

from . import paths

STATE_PATH = os.path.join(paths.DATA_DIR, "remote.json")


class RemoteError(Exception):
    pass


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


def _call(relay: str, method: str, path: str, token: str | None = None, body: dict | None = None, timeout: int = 20) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(relay.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            msg = json.loads(exc.read()).get("error") or f"HTTP {exc.code}"
        except Exception:  # noqa: BLE001
            msg = f"HTTP {exc.code}"
        raise RemoteError(f"relay: {msg}")
    except (urllib.error.URLError, OSError) as exc:
        raise RemoteError(f"relay unreachable: {exc}")


class Remote:
    """Daemon-side client. `on_decision(request_id, approved, device)` is
    called from the listener thread; the daemon hops to its loop."""

    def __init__(self, on_decision, log=None):
        self.on_decision = on_decision
        self.log = log or (lambda *a: None)
        self.state = load_state()
        self._stop = threading.Event()
        self._thread = None
        self.connected = False
        self.last_error = None

    # -- setup -----------------------------------------------------------

    @property
    def relay(self) -> str | None:
        return self.state.get("relay")

    def enabled(self) -> bool:
        return bool(self.state.get("install_id") and self.state.get("install_token") and self.relay)

    def enable(self, relay: str) -> dict:
        relay = relay.strip().rstrip("/")
        if not relay.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise RemoteError("the relay URL must be https:// (or a local http://127.0.0.1 for testing)")
        if self.state.get("relay") == relay and self.enabled():
            self.start()
            return self.status()
        r = _call(relay, "POST", "/v1/installs", body={"name": os.uname().nodename})
        self.state = {"relay": relay, "install_id": r["install_id"], "install_token": r["install_token"]}
        save_state(self.state)
        self.start()
        return self.status()

    def disable(self) -> None:
        self.stop()
        if self.enabled():
            try:
                self._api("DELETE", f"/v1/installs/{self.state['install_id']}")
            except RemoteError as exc:
                self.log(f"remote: disable: {exc}")
        self.state = {}
        try:
            os.remove(STATE_PATH)
        except FileNotFoundError:
            pass

    def _api(self, method: str, path: str, body: dict | None = None) -> dict:
        if not self.enabled():
            raise RemoteError("remote approvals are not enabled")
        return _call(self.relay, method, path, self.state["install_token"], body)

    def pair(self) -> dict:
        r = self._api("POST", f"/v1/installs/{self.state['install_id']}/pairings")
        r["url"] = self.relay + (r.get("path") or f"/pair/{self.state['install_id']}/{r['code']}")
        return r

    def devices(self) -> list:
        return self._api("GET", f"/v1/installs/{self.state['install_id']}/devices").get("devices") or []

    def revoke(self, device_id: str) -> None:
        self._api("DELETE", f"/v1/installs/{self.state['install_id']}/devices/{device_id}")

    def status(self) -> dict:
        out = {"enabled": self.enabled(), "relay": self.relay, "connected": self.connected, "error": self.last_error, "devices": []}
        if self.enabled():
            try:
                out["devices"] = self.devices()
            except RemoteError as exc:
                out["error"] = str(exc)
        return out

    # -- requests --------------------------------------------------------

    def post_request(self, req: dict) -> None:
        """req: {id, session, title, command, diff, expires_at}"""
        self._api("POST", f"/v1/installs/{self.state['install_id']}/requests", body=req)

    def resolve(self, request_id: str, outcome: str) -> None:
        try:
            self._api("POST", f"/v1/installs/{self.state['install_id']}/requests/{request_id}/resolve", body={"outcome": outcome})
        except RemoteError as exc:
            self.log(f"remote: resolve {request_id}: {exc}")

    # -- the outbound event stream ---------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._listen, name="kcoder-remote", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.connected = False

    def _listen(self) -> None:
        backoff = 2.0
        while not self._stop.is_set() and self.enabled():
            try:
                url = f"{self.relay}/v1/installs/{self.state['install_id']}/events"
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.state['install_token']}", "Accept": "text/event-stream"})
                with urllib.request.urlopen(req, timeout=90) as r:
                    self.connected = True
                    self.last_error = None
                    backoff = 2.0
                    data = ""
                    for raw in r:
                        if self._stop.is_set():
                            return
                        line = raw.decode("utf-8", "replace").rstrip("\n")
                        if line.startswith("data:"):
                            data += line[5:].strip()
                        elif line == "" and data:
                            try:
                                ev = json.loads(data)
                            except json.JSONDecodeError:
                                ev = None
                            data = ""
                            if ev and ev.get("type") == "decision":
                                try:
                                    self.on_decision(ev.get("request_id"), bool(ev.get("approved")), ev.get("device") or {})
                                except Exception as exc:  # noqa: BLE001
                                    self.log(f"remote: decision handler failed: {exc}")
            except Exception as exc:  # noqa: BLE001
                self.connected = False
                self.last_error = str(exc)[:200]
                if self._stop.is_set():
                    return
                self.log(f"remote: stream closed ({exc}); reconnecting in {backoff:.0f}s")
                self._stop.wait(backoff)
                backoff = min(60.0, backoff * 2)
        self.connected = False
