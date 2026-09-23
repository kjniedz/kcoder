"""Synchronous client for kcoderd, used by the terminal CLI.

    with DaemonClient.connect() as client:      # starts kcoderd if needed
        reply = client.request("list")
        client.request("send", sid=sid, text="hello")
        for kind, payload in client.events():   # ("event", frame) / ("sessions", [...])
            ...
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect as ws_connect

from . import paths
from .daemon import already_running, read_daemon_info


class ClientError(Exception):
    pass


class DaemonUnavailable(ClientError):
    pass


def _read_token() -> str:
    try:
        with open(paths.TOKEN_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def spawn_daemon() -> None:
    """Start kcoderd detached from this terminal, logging to the data dir."""
    paths.ensure_data_dir()
    log = open(paths.DAEMON_LOG_PATH, "a")
    # -P keeps the cwd off sys.path so a stray "kcoder" folder can't shadow
    # the installed package.
    subprocess.Popen(
        [sys.executable, "-P", "-m", "kcoder.daemon"],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
        close_fds=True,
        cwd=os.path.expanduser("~"),
    )


def ensure_daemon(timeout: float = 15.0) -> dict:
    """Return daemon info, starting kcoderd if it isn't running."""
    info = already_running()
    if info:
        return info
    spawn_daemon()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.15)
        info = already_running()
        if info:
            return info
    raise DaemonUnavailable(
        f"kcoderd did not start within {timeout:.0f}s - see {paths.DAEMON_LOG_PATH}"
    )


class DaemonClient:
    def __init__(self, ws, info: dict):
        self.ws = ws
        self.info = info
        self._next_id = 1
        self._lock = threading.Lock()
        self._replies: dict[int, dict] = {}
        self._reply_events: dict[int, threading.Event] = {}
        self._events: queue.Queue = queue.Queue()
        self.sessions: list = []
        self.stats: dict = {}
        self.chats: list = []
        self.projects: list = []
        self.closed = threading.Event()
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name="kcoder-ws")
        self._reader.start()

    # -- connection ------------------------------------------------------

    @classmethod
    def connect(cls, *, autostart: bool = True) -> "DaemonClient":
        info = ensure_daemon() if autostart else already_running()
        if not info:
            raise DaemonUnavailable("kcoderd is not running")
        token = _read_token()
        if not token:
            raise ClientError(f"daemon token missing at {paths.TOKEN_PATH}")
        url = f"ws://{info['host']}:{info['port']}/ws"
        try:
            ws = ws_connect(url, max_size=64 * 1024 * 1024, open_timeout=5)
        except OSError as exc:
            raise DaemonUnavailable(f"couldn't connect to kcoderd at {url}: {exc}")
        client = cls(ws, info)
        reply = client.request("auth", token=token)
        client.version = reply.get("version")
        return client

    def close(self) -> None:
        self.closed.set()
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- requests --------------------------------------------------------

    def request(self, type_: str, timeout: float = 30.0, **fields) -> dict:
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._reply_events[rid] = ev
        frame = {"type": type_, "id": rid, **fields}
        try:
            self.ws.send(json.dumps(frame))
        except ConnectionClosed as exc:
            raise DaemonUnavailable(f"connection to kcoderd closed: {exc}")
        if not ev.wait(timeout):
            self._reply_events.pop(rid, None)
            if self.closed.is_set():
                raise DaemonUnavailable("connection to kcoderd closed")
            raise ClientError(f"kcoderd did not answer {type_!r} within {timeout:.0f}s")
        reply = self._replies.pop(rid)
        if not reply.get("ok"):
            raise ClientError(reply.get("error", "request failed"))
        return reply

    # -- events ----------------------------------------------------------

    def next_event(self, timeout: float | None = None):
        """Block for the next ("event", frame) or ("sessions", list) item.
        Returns None on timeout; raises DaemonUnavailable when disconnected."""
        try:
            item = self._events.get(timeout=timeout)
        except queue.Empty:
            if self.closed.is_set():
                raise DaemonUnavailable("connection to kcoderd closed")
            return None
        if item is None:
            raise DaemonUnavailable("connection to kcoderd closed")
        return item

    def drain_events(self) -> list:
        items = []
        while True:
            try:
                item = self._events.get_nowait()
            except queue.Empty:
                return items
            if item is None:
                self._events.put(None)
                return items
            items.append(item)

    def _read_loop(self) -> None:
        try:
            for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = msg.get("type")
                if t == "reply":
                    rid = msg.get("id")
                    ev = self._reply_events.pop(rid, None)
                    if ev is not None:
                        self._replies[rid] = msg
                        ev.set()
                elif t == "event":
                    self._events.put(("event", msg))
                elif t == "sessions":
                    self.sessions = msg.get("sessions", [])
                    self.stats = msg.get("stats", {})
                    self._events.put(("sessions", self.sessions))
                elif t == "chats":
                    self.chats = msg.get("chats", [])
                    self.projects = msg.get("projects", [])
                elif t == "shell":
                    self._events.put(("shell", msg))
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            self.closed.set()
            self._events.put(None)
            for ev in list(self._reply_events.values()):
                ev.set()


def daemon_url() -> str | None:
    info = read_daemon_info()
    if not info:
        return None
    return f"http://{info['host']}:{info['port']}/"
