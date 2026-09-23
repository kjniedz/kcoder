"""kcoderd - the kcoder session daemon.

Owns every agent session, runs them concurrently, persists them to disk, and
streams their events to clients (the terminal CLI and the web app) over a
token-authenticated WebSocket bound to 127.0.0.1.

Wire protocol (JSON text frames):

  client -> daemon   {"type": <request>, "id": <n>, ...}
  daemon -> client   {"type": "reply", "id": <n>, "ok": true, ...}
                     {"type": "reply", "id": <n>, "ok": false, "error": "..."}
                     {"type": "event", "sid": <session>, "seq": <n>, "ev": {...}}
                     {"type": "sessions", "sessions": [<meta>, ...]}

The first frame a client sends must be {"type": "auth", "token": "..."}.

Requests: list, create, attach, detach, send, approve, interrupt, set,
clear, rename, close, delete, ping, shutdown. See `_dispatch`.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import datetime as dt
import http
import json
import logging
import os
import secrets
import signal
import socket
import sys
import time
import uuid

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from . import __version__, auth, paths
from .engine import Engine, EngineBusy
from .providers import PROVIDERS

log = logging.getLogger("kcoderd")

EVENT_TAIL = 2000          # events kept in memory per session for replay
PERSISTED_EVENTS = {       # streamed text deltas are rebuilt from assistant_end
    "turn_start", "assistant_start", "assistant_end", "usage", "tool_call",
    "approval_request", "approval_result", "tool_result", "notice", "info",
    "error", "status", "turn_end", "user", "system",
}


# ----------------------------------------------------------------------
# sessions
# ----------------------------------------------------------------------

class Session:
    def __init__(self, manager: "Manager", meta: dict, engine: Engine):
        self.manager = manager
        self.id: str = meta["id"]
        self.meta = meta
        self.engine = engine
        self.seq = int(meta.get("seq", 0))
        self.events: collections.deque = collections.deque(maxlen=EVENT_TAIL)
        self.dir = os.path.join(paths.SESSIONS_DIR, self.id)
        self._events_file = None

    # -- persistence ---------------------------------------------------

    @property
    def meta_path(self) -> str:
        return os.path.join(self.dir, "meta.json")

    def snapshot(self) -> dict:
        """Public view of the session, sent to clients."""
        m = dict(self.meta)
        m["status"] = self.engine.status
        m["model"] = self.engine.model
        m["cwd"] = self.engine.cwd
        m["auto_approve"] = self.engine.auto_approve
        m["pending_approval"] = self.engine.pending_approval()
        m["seq"] = self.seq
        m["context_tokens"] = self.engine.last_input_tokens
        m["messages"] = len(self.engine.messages)
        return m

    def save_meta(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        data = self.snapshot()
        _atomic_write(self.meta_path, json.dumps(data, indent=2))

    def save_messages(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        _atomic_write(
            os.path.join(self.dir, "messages.json"), json.dumps(self.engine.messages)
        )

    def append_event(self, event: dict) -> None:
        if event["t"] not in PERSISTED_EVENTS:
            return
        os.makedirs(self.dir, exist_ok=True)
        if self._events_file is None:
            self._events_file = open(os.path.join(self.dir, "events.jsonl"), "a", encoding="utf-8")
        self._events_file.write(json.dumps(event) + "\n")
        self._events_file.flush()

    def close_files(self) -> None:
        if self._events_file is not None:
            self._events_file.close()
            self._events_file = None

    @staticmethod
    def load_events_tail(session_dir: str, limit: int) -> list:
        path = os.path.join(session_dir, "events.jsonl")
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = collections.deque(f, maxlen=limit)
        except FileNotFoundError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out


def _atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.subs: set = set()
        self.all = False
        self.queue: asyncio.Queue = asyncio.Queue()

    def wants(self, sid: str) -> bool:
        return self.all or sid in self.subs


class Manager:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.sessions: dict[str, Session] = {}
        self.clients: set[Client] = set()
        self.stop = asyncio.Event()
        self._usage_file = None

    # -- lifecycle -----------------------------------------------------

    def load_from_disk(self) -> None:
        paths.ensure_data_dir()
        for sid in sorted(os.listdir(paths.SESSIONS_DIR)):
            sdir = os.path.join(paths.SESSIONS_DIR, sid)
            meta_path = os.path.join(sdir, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                if meta.get("status") == "closed" or meta.get("closed"):
                    continue
                try:
                    with open(os.path.join(sdir, "messages.json"), "r", encoding="utf-8") as f:
                        messages = json.load(f)
                except FileNotFoundError:
                    messages = []
                was_busy = meta.get("status") in ("working", "waiting")
                session = self._build_session(meta, messages)
                session.events.extend(Session.load_events_tail(sdir, EVENT_TAIL))
                if was_busy:
                    self._record(session, {
                        "t": "info", "ts": time.time(),
                        "text": "daemon restarted while this session was working; "
                                "the unfinished turn was dropped - resend it",
                    })
                    session.save_meta()
                log.info("loaded session %s (%s) in %s", sid, meta.get("name"), meta.get("cwd"))
            except Exception as exc:  # noqa: BLE001 - one bad session must not stop the daemon
                log.exception("failed to load session %s: %s", sid, exc)

    def shutdown(self) -> None:
        for session in self.sessions.values():
            if session.engine.busy:
                session.engine.interrupt()
            session.save_messages()
            session.save_meta()
            session.close_files()
        if self._usage_file is not None:
            self._usage_file.close()

    # -- session management --------------------------------------------

    def _build_session(self, meta: dict, messages: list) -> Session:
        provider_id = meta["provider"]
        if provider_id not in PROVIDERS:
            raise ValueError(f"unknown provider: {provider_id}")
        resolved = auth.resolve_backend(provider_id)
        if resolved is None:
            raise ValueError(
                f"no credentials for {PROVIDERS[provider_id].label}; "
                f"run `kcoder --provider {provider_id}` in a terminal to set it up"
            )
        provider, backend = resolved
        sid = meta["id"]
        engine = Engine(
            provider=provider,
            backend=backend,
            model=meta.get("model") or provider.default_model,
            cwd=meta["cwd"],
            auto_approve=bool(meta.get("auto_approve", False)),
            messages=messages,
            emit=lambda ev, sid=sid: self.loop.call_soon_threadsafe(self._on_engine_event, sid, ev),
        )
        engine.last_input_tokens = int(meta.get("context_tokens", 0) or 0)
        session = Session(self, meta, engine)
        self.sessions[sid] = session
        return session

    def create(self, *, cwd: str, provider: str, model: str | None, name: str | None,
               auto_approve: bool) -> Session:
        cwd = os.path.abspath(os.path.expanduser(cwd))
        if not os.path.isdir(cwd):
            raise ValueError(f"no such directory: {cwd}")
        sid = uuid.uuid4().hex[:8]
        base = name or os.path.basename(cwd.rstrip("/")) or "session"
        name = self._unique_name(base)
        now = time.time()
        meta = {
            "id": sid,
            "name": name,
            "cwd": cwd,
            "provider": provider,
            "model": model,
            "auto_approve": auto_approve,
            "created": now,
            "last_activity": now,
            "usage": {"input": 0, "output": 0, "calls": 0, "turns": 0},
        }
        session = self._build_session(meta, [])
        session.save_meta()
        session.save_messages()
        self._record(session, {"t": "system", "ts": now, "text": f"session {name} created in {cwd}"})
        self.broadcast_sessions()
        return session

    def _unique_name(self, base: str) -> str:
        taken = {s.meta["name"] for s in self.sessions.values()}
        if base not in taken:
            return base
        n = 2
        while f"{base}-{n}" in taken:
            n += 1
        return f"{base}-{n}"

    def get(self, sid: str) -> Session:
        session = self.sessions.get(sid)
        if session is None:
            # allow unique prefix / name match for CLI convenience
            matches = [
                s for s in self.sessions.values()
                if s.id.startswith(sid) or s.meta["name"] == sid
            ]
            if len(matches) == 1:
                return matches[0]
            raise KeyError(f"no session {sid!r}" if not matches else f"ambiguous session {sid!r}")
        return session

    def close(self, sid: str, delete: bool = False) -> None:
        session = self.get(sid)
        if session.engine.busy:
            session.engine.interrupt()
        session.meta["status"] = "closed"
        session.meta["closed"] = True
        session.save_messages()
        # save_meta() would overwrite status with the engine's; write directly
        m = session.snapshot()
        m["status"] = "closed"
        m["closed"] = True
        _atomic_write(session.meta_path, json.dumps(m, indent=2))
        session.close_files()
        del self.sessions[session.id]
        if delete:
            import shutil
            shutil.rmtree(session.dir, ignore_errors=True)
        self.broadcast_sessions()

    # -- events --------------------------------------------------------

    def _on_engine_event(self, sid: str, event: dict) -> None:
        """Runs on the event loop (via call_soon_threadsafe)."""
        session = self.sessions.get(sid)
        if session is None:
            return
        t = event["t"]
        if t == "usage":
            u = session.meta.setdefault("usage", {"input": 0, "output": 0, "calls": 0, "turns": 0})
            u["input"] += event["input"]
            u["output"] += event["output"]
            u["calls"] += 1
            self._log_usage(session, event)
        elif t == "turn_end":
            session.meta.setdefault("usage", {}).setdefault("turns", 0)
            session.meta["usage"]["turns"] += 1
            session.save_messages()
        self._record(session, event)
        if t in ("status", "turn_start", "turn_end", "usage"):
            session.save_meta()
            self.broadcast_sessions()

    def _record(self, session: Session, event: dict) -> None:
        """Assign a sequence number, persist, and fan out to subscribers."""
        session.seq += 1
        event = dict(event)
        event["seq"] = session.seq
        session.meta["last_activity"] = event.get("ts", time.time())
        if event["t"] in PERSISTED_EVENTS:
            session.events.append(event)
            session.append_event(event)
        frame = json.dumps({"type": "event", "sid": session.id, "seq": session.seq, "ev": event})
        for client in list(self.clients):
            if client.wants(session.id):
                client.queue.put_nowait(frame)

    def record_user(self, session: Session, text: str, images: list) -> None:
        self._record(session, {
            "t": "user", "ts": time.time(), "text": text,
            "images": [os.path.basename(p) for p in images],
        })

    def _log_usage(self, session: Session, event: dict) -> None:
        try:
            if self._usage_file is None:
                self._usage_file = open(paths.USAGE_LOG_PATH, "a", encoding="utf-8")
            self._usage_file.write(json.dumps({
                "ts": event["ts"],
                "date": dt.datetime.fromtimestamp(event["ts"]).strftime("%Y-%m-%d"),
                "sid": session.id,
                "provider": session.meta["provider"],
                "model": event.get("model"),
                "input": event["input"],
                "output": event["output"],
            }) + "\n")
            self._usage_file.flush()
        except OSError as exc:
            log.warning("usage log write failed: %s", exc)

    def sessions_frame(self) -> str:
        return json.dumps({
            "type": "sessions",
            "sessions": [s.snapshot() for s in self.sessions.values()],
        })

    def broadcast_sessions(self) -> None:
        frame = self.sessions_frame()
        for client in list(self.clients):
            client.queue.put_nowait(frame)


# ----------------------------------------------------------------------
# request handling
# ----------------------------------------------------------------------

class RequestError(Exception):
    pass


async def _dispatch(manager: Manager, client: Client, req: dict) -> dict:
    t = req.get("type")

    if t == "ping":
        return {"pong": time.time(), "version": __version__}

    if t == "list":
        return {"sessions": [s.snapshot() for s in manager.sessions.values()]}

    if t == "create":
        provider = req.get("provider")
        if provider not in PROVIDERS:
            raise RequestError(f"unknown provider: {provider}")
        try:
            session = manager.create(
                cwd=req.get("cwd") or os.getcwd(),
                provider=provider,
                model=req.get("model"),
                name=req.get("name"),
                auto_approve=bool(req.get("auto_approve", False)),
            )
        except ValueError as exc:
            raise RequestError(str(exc))
        client.subs.add(session.id)
        return {"session": session.snapshot()}

    if t == "attach":
        sid = req.get("sid")
        if sid == "*":
            client.all = True
            return {"sessions": [s.snapshot() for s in manager.sessions.values()]}
        session = _session(manager, sid)
        client.subs.add(session.id)
        replay = int(req.get("replay", 0) or 0)
        events = list(session.events)[-replay:] if replay else []
        return {"session": session.snapshot(), "events": events}

    if t == "detach":
        sid = req.get("sid")
        if sid == "*":
            client.all = False
        else:
            client.subs.discard(sid)
        return {}

    session = _session(manager, req.get("sid"))
    engine = session.engine

    if t == "send":
        text = req.get("text") or ""
        images = [p for p in (req.get("images") or []) if os.path.isfile(p)]
        if not text.strip() and not images:
            raise RequestError("empty message")
        try:
            manager.record_user(session, text, images)
            engine.send(text, images)
        except EngineBusy:
            raise RequestError("session is busy; wait for the current turn to finish")
        return {}

    if t == "approve":
        ok = engine.approve(req.get("rid"), bool(req.get("approved")))
        if not ok:
            raise RequestError("no such pending approval")
        return {}

    if t == "interrupt":
        return {"interrupted": engine.interrupt()}

    if t == "set":
        changed = {}
        if "model" in req and req["model"]:
            engine.model = str(req["model"])
            session.meta["model"] = engine.model
            changed["model"] = engine.model
        if "cwd" in req and req["cwd"]:
            cwd = os.path.abspath(os.path.expanduser(req["cwd"]))
            if not os.path.isdir(cwd):
                raise RequestError(f"no such directory: {cwd}")
            engine.cwd = cwd
            session.meta["cwd"] = cwd
            changed["cwd"] = cwd
        if "auto_approve" in req:
            engine.auto_approve = bool(req["auto_approve"])
            changed["auto_approve"] = engine.auto_approve
        if "provider" in req and req["provider"]:
            pid = req["provider"]
            if pid not in PROVIDERS:
                raise RequestError(f"unknown provider: {pid}")
            resolved = auth.resolve_backend(pid)
            if resolved is None:
                raise RequestError(
                    f"no credentials for {PROVIDERS[pid].label}; "
                    f"run `kcoder --provider {pid}` in a terminal to set it up"
                )
            provider, backend = resolved
            had_history = bool(engine.messages)
            try:
                engine.switch_provider(provider, backend, req.get("model"))
            except EngineBusy as exc:
                raise RequestError(str(exc))
            session.meta["provider"] = pid
            session.meta["model"] = engine.model
            changed["provider"] = pid
            changed["model"] = engine.model
            changed["cleared"] = had_history
            if had_history:
                session.save_messages()
        session.save_meta()
        manager._record(session, {"t": "system", "ts": time.time(), "text": "settings changed", "changed": changed})
        manager.broadcast_sessions()
        return {"session": session.snapshot(), "changed": changed}

    if t == "clear":
        try:
            engine.clear()
        except EngineBusy as exc:
            raise RequestError(str(exc))
        session.save_messages()
        manager._record(session, {"t": "system", "ts": time.time(), "text": "conversation cleared"})
        return {}

    if t == "rename":
        name = (req.get("name") or "").strip()
        if not name:
            raise RequestError("empty name")
        session.meta["name"] = name
        session.save_meta()
        manager.broadcast_sessions()
        return {"session": session.snapshot()}

    if t in ("close", "delete"):
        manager.close(session.id, delete=(t == "delete"))
        return {}

    raise RequestError(f"unknown request type: {t}")


def _session(manager: Manager, sid) -> Session:
    if not sid:
        raise RequestError("missing sid")
    try:
        return manager.get(str(sid))
    except KeyError as exc:
        raise RequestError(str(exc))


# ----------------------------------------------------------------------
# server
# ----------------------------------------------------------------------

PLACEHOLDER_HTML = """<!doctype html>
<meta charset="utf-8"><title>kcoder</title>
<style>body{background:#0b0f14;color:#87CEFA;font-family:ui-monospace,Menlo,monospace;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
p{color:#8899aa}</style>
<div><pre>KCODER</pre><p>kcoderd %s is running. The web app arrives in phase 2.</p></div>
"""


def _make_process_request(token: str):
    def process_request(connection, request):
        # Non-WebSocket requests get the (placeholder) web app.
        if request.headers.get("Upgrade", "").lower() != "websocket":
            if request.path in ("/", "/index.html"):
                body = (PLACEHOLDER_HTML % __version__).encode()
                return Response(
                    200, "OK",
                    Headers([("Content-Type", "text/html; charset=utf-8"),
                             ("Content-Length", str(len(body))),
                             ("Cache-Control", "no-store")]),
                    body,
                )
            if request.path == "/health":
                return connection.respond(http.HTTPStatus.OK, "ok\n")
            return connection.respond(http.HTTPStatus.NOT_FOUND, "not found\n")
        return None
    return process_request


async def _client_sender(client: Client) -> None:
    while True:
        frame = await client.queue.get()
        await client.ws.send(frame)


async def _handle(ws, manager: Manager, token: str) -> None:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        hello = json.loads(raw)
        if hello.get("type") != "auth" or not secrets.compare_digest(str(hello.get("token", "")), token):
            await ws.send(json.dumps({"type": "reply", "id": hello.get("id"), "ok": False, "error": "unauthorized"}))
            await ws.close(4401, "unauthorized")
            return
    except (asyncio.TimeoutError, json.JSONDecodeError, Exception):  # noqa: BLE001
        await ws.close(4400, "expected auth frame")
        return

    client = Client(ws)
    manager.clients.add(client)
    sender = asyncio.create_task(_client_sender(client))
    await ws.send(json.dumps({"type": "reply", "id": hello.get("id"), "ok": True, "version": __version__}))
    client.queue.put_nowait(manager.sessions_frame())
    try:
        async for raw in ws:
            try:
                req = json.loads(raw)
            except json.JSONDecodeError:
                continue
            rid = req.get("id")
            if req.get("type") == "shutdown":
                await ws.send(json.dumps({"type": "reply", "id": rid, "ok": True}))
                manager.stop.set()
                continue
            try:
                result = await _dispatch(manager, client, req)
                reply = {"type": "reply", "id": rid, "ok": True, **result}
            except RequestError as exc:
                reply = {"type": "reply", "id": rid, "ok": False, "error": str(exc)}
            except Exception as exc:  # noqa: BLE001
                log.exception("request failed: %s", req.get("type"))
                reply = {"type": "reply", "id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
            await ws.send(json.dumps(reply))
    finally:
        manager.clients.discard(client)
        sender.cancel()


def _load_or_create_token() -> str:
    paths.ensure_data_dir()
    try:
        with open(paths.TOKEN_PATH, "r", encoding="utf-8") as f:
            token = f.read().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(32)
    with open(paths.TOKEN_PATH, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    os.chmod(paths.TOKEN_PATH, 0o600)
    return token


def read_daemon_info() -> dict | None:
    try:
        with open(paths.DAEMON_INFO_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _port_open(host: str, port: int) -> bool:
    """True if kcoderd answers /health on host:port (a real HTTP probe, so
    the server doesn't log a half-open handshake)."""
    try:
        with socket.create_connection((host, port), timeout=0.5) as s:
            s.sendall(f"GET /health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
            s.settimeout(1.0)
            data = s.recv(256)
        return data.startswith(b"HTTP/1.1 200")
    except OSError:
        return False


def already_running() -> dict | None:
    info = read_daemon_info()
    if info and _pid_alive(int(info.get("pid", 0))) and _port_open(info["host"], info["port"]):
        return info
    return None


async def _serve(host: str, port: int) -> None:
    loop = asyncio.get_running_loop()
    token = _load_or_create_token()
    manager = Manager(loop)
    manager.load_from_disk()

    stop = manager.stop
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (RuntimeError, NotImplementedError):
            pass  # not the main thread (embedded/tests) or Windows

    origins = [None, f"http://{host}:{port}", f"http://localhost:{port}"]
    async with serve(
        lambda ws: _handle(ws, manager, token),
        host, port,
        origins=origins,
        process_request=_make_process_request(token),
        max_size=64 * 1024 * 1024,
        server_header=None,
    ) as server:
        info = {"host": host, "port": port, "pid": os.getpid(), "started": time.time(), "version": __version__}
        _atomic_write(paths.DAEMON_INFO_PATH, json.dumps(info))
        os.chmod(paths.DAEMON_INFO_PATH, 0o600)
        log.info("kcoderd %s listening on ws://%s:%d/ws (pid %d)", __version__, host, port, os.getpid())
        await stop.wait()
        log.info("shutting down")
        manager.shutdown()
        server.close()
    try:
        os.remove(paths.DAEMON_INFO_PATH)
    except FileNotFoundError:
        pass


def main(argv: list | None = None) -> None:
    parser = argparse.ArgumentParser(prog="kcoderd", description="kcoder session daemon")
    parser.add_argument("--host", default=paths.DEFAULT_HOST, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=paths.DEFAULT_PORT)
    parser.add_argument("--log-file", default=None, help="log to this file instead of stderr")
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("kcoderd runs shell commands; it only binds to loopback addresses")

    paths.ensure_data_dir()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        filename=args.log_file,
    )
    running = already_running()
    if running:
        print(f"kcoderd is already running (pid {running['pid']}, port {running['port']})", file=sys.stderr)
        sys.exit(1)
    asyncio.run(_serve(args.host, args.port))


if __name__ == "__main__":
    main()
