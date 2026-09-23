"""kcoderd - the kcoder session daemon.

Owns every chat session, runs them concurrently, persists them to disk, and
streams their events to clients (the terminal CLI and the web app) over a
token-authenticated WebSocket bound to 127.0.0.1.

Wire protocol (JSON text frames):

  client -> daemon   {"type": <request>, "id": <n>, ...}
  daemon -> client   {"type": "reply", "id": <n>, "ok": true, ...}
                     {"type": "reply", "id": <n>, "ok": false, "error": "..."}
                     {"type": "event", "sid": <session>, "seq": <n>, "ev": {...}}
                     {"type": "sessions", "sessions": [<meta>, ...], "stats": {...}}
                     {"type": "chats", "chats": [<meta>, ...], "projects": [...]}
                     {"type": "shell", "sid": ..., "data": <base64>}   (phase 6)

The first frame a client sends must be {"type": "auth", "token": "..."}.

A "chat" is any session on disk (active or archived); a "session" is a chat
with a running engine. Archived chats are resumed on demand.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import datetime as dt
import http
import json
import logging
import mimetypes
import os
import secrets
import shutil
import signal
import socket
import sys
import time
import uuid

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from . import __version__, auth, chatlog, config, paths, pricing, projects
from .engine import DEFAULT_COMPACT_AT, TRUST_LEVELS, Engine, EngineBusy
from .providers import PROVIDERS

log = logging.getLogger("kcoderd")

EVENT_TAIL = 2000          # events kept in memory per session for replay
PERSISTED_EVENTS = {       # streamed text deltas are rebuilt from assistant_end
    "turn_start", "assistant_start", "assistant_end", "usage", "tool_call",
    "approval_request", "approval_result", "tool_result", "notice", "info",
    "error", "status", "turn_end", "user", "system", "retry", "compaction_start",
    "compaction", "history_reset", "queue", "git",
}
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def _today() -> str:
    return dt.date.today().strftime("%Y-%m-%d")


def _atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


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
        self.dir = session_dir(self.id)
        self._events_file = None
        self.shell = None   # phase 6: attached pty

    @property
    def meta_path(self) -> str:
        return os.path.join(self.dir, "meta.json")

    def snapshot(self) -> dict:
        """Public view of the session, sent to clients."""
        m = dict(self.meta)
        m["status"] = self.engine.status
        m["model"] = self.engine.model
        m["cwd"] = self.engine.cwd
        m["trust"] = self.engine.trust
        m["auto_approve"] = self.engine.auto_approve
        m["pending_approval"] = self.engine.pending_approval()
        m["seq"] = self.seq
        m["context_tokens"] = self.engine.last_input_tokens
        m["messages"] = len(self.engine.messages)
        m["archived"] = False
        m["queue"] = list(self.meta.get("queue") or [])
        m["shell"] = self.shell is not None
        return m

    def save_meta(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        data = self.snapshot()
        _atomic_write(self.meta_path, json.dumps(data, indent=2))
        self.manager.chats[self.id] = data

    def save_messages(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        _atomic_write(os.path.join(self.dir, "messages.json"), json.dumps(self.engine.messages))

    def append_event(self, event: dict) -> None:
        if event["t"] not in PERSISTED_EVENTS:
            return
        os.makedirs(self.dir, exist_ok=True)
        if self._events_file is None:
            self._events_file = open(os.path.join(self.dir, "events.jsonl"), "a", encoding="utf-8")
        self._events_file.write(json.dumps(event) + "\n")
        self._events_file.flush()

    def rewrite_events(self, events: list) -> None:
        """Replace the persisted event log (after an edit truncates history)."""
        self.close_files()
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, "events.jsonl"), "w", encoding="utf-8") as f:
            for e in events:
                if e["t"] in PERSISTED_EVENTS:
                    f.write(json.dumps(e) + "\n")
        self.events.clear()
        self.events.extend(events)

    def close_files(self) -> None:
        if self._events_file is not None:
            self._events_file.close()
            self._events_file = None

    def all_events(self) -> list:
        return load_events(self.dir, 1_000_000)


def session_dir(sid: str) -> str:
    return os.path.join(paths.SESSIONS_DIR, sid)


def load_events(sdir: str, limit: int) -> list:
    path = os.path.join(sdir, "events.jsonl")
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


def load_messages(sdir: str) -> list:
    try:
        with open(os.path.join(sdir, "messages.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


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
        self.sessions: dict[str, Session] = {}   # active (engine loaded)
        self.chats: dict[str, dict] = {}         # every chat's meta, incl. archived
        self.clients: set[Client] = set()
        self.stop = asyncio.Event()
        self._usage_file = None
        self.today = {"date": _today(), "input": 0, "output": 0, "cost": 0.0, "calls": 0}
        self.cfg = {}

    # -- lifecycle -----------------------------------------------------

    def load_from_disk(self) -> None:
        paths.ensure_data_dir()
        self.cfg = config.load()
        self._load_today()
        for sid in sorted(os.listdir(paths.SESSIONS_DIR)):
            sdir = session_dir(sid)
            meta_path = os.path.join(sdir, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                meta.setdefault("id", sid)
                if meta.get("deleted"):
                    continue
                if meta.get("closed"):          # v0.2 field
                    meta["archived"] = True
                if "project" not in meta:
                    meta["project"] = projects.project_info(projects.project_root(meta.get("cwd", os.getcwd())))
                if meta.get("archived"):
                    meta["status"] = "archived"
                    self.chats[sid] = meta
                    continue
                messages = load_messages(sdir)
                was_busy = meta.get("status") in ("working", "waiting")
                resume_text = None
                if messages and chatlog.is_user_turn(messages[-1]):
                    # the daemon died mid-turn: the last user message never got
                    # an answer. Never re-run it silently - offer a resume.
                    resume_text = chatlog.user_text(messages.pop())
                    was_busy = True
                session = self._build_session(meta, messages)
                session.events.extend(load_events(sdir, EVENT_TAIL))
                if was_busy:
                    session.meta["interrupted"] = True
                    session.meta["resume_text"] = resume_text or session.meta.get("resume_text")
                    self._record(session, {
                        "t": "system", "ts": time.time(), "kind": "interrupted",
                        "text": "kcoderd restarted while this session was working; the unfinished "
                                "turn was not re-run. Resume to send it again.",
                    })
                    session.save_messages()
                session.save_meta()
                log.info("loaded session %s (%s) in %s", sid, meta.get("name"), meta.get("cwd"))
            except Exception as exc:  # noqa: BLE001 - one bad session must not stop the daemon
                log.exception("failed to load session %s: %s", sid, exc)

    def _load_today(self) -> None:
        """Sum today's calls from usage.jsonl so fleet stats survive restarts."""
        today = _today()
        self.today = {"date": today, "input": 0, "output": 0, "cost": 0.0, "calls": 0}
        try:
            with open(paths.USAGE_LOG_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if row.get("date") != today:
                        continue
                    self.today["input"] += int(row.get("input", 0))
                    self.today["output"] += int(row.get("output", 0))
                    self.today["cost"] += float(row.get("cost", 0.0))
                    self.today["calls"] += 1
        except FileNotFoundError:
            pass

    def daily_cap(self) -> float:
        try:
            return float(self.cfg.get("daily_cap_usd") or 0)
        except (TypeError, ValueError):
            return 0.0

    def cap_reached(self) -> bool:
        cap = self.daily_cap()
        if self.today["date"] != _today():
            self._load_today()
        return cap > 0 and self.today["cost"] >= cap

    def stats(self) -> dict:
        if self.today["date"] != _today():
            self._load_today()
        by_status = collections.Counter(s.engine.status for s in self.sessions.values())
        pending = [
            {"sid": s.id, "name": s.meta["name"], "rid": s.engine.pending_approval()}
            for s in self.sessions.values() if s.engine.pending_approval()
        ]
        return {
            "sessions": len(self.sessions),
            "chats": len(self.chats),
            "working": by_status.get("working", 0),
            "waiting": by_status.get("waiting", 0),
            "idle": by_status.get("idle", 0),
            "error": by_status.get("error", 0),
            "pending_approvals": pending,
            "today": dict(self.today),
            "daily_cap_usd": self.daily_cap(),
            "cap_reached": self.cap_reached(),
        }

    def shutdown(self) -> None:
        for session in self.sessions.values():
            if session.engine.busy:
                session.engine.interrupt()
            if session.shell is not None:
                try:
                    session.shell.close()
                except Exception:  # noqa: BLE001
                    pass
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
        trust = meta.get("trust")
        if trust not in TRUST_LEVELS:
            trust = "auto" if meta.get("auto_approve") else "read"
        engine = Engine(
            provider=provider,
            backend=backend,
            model=meta.get("model") or provider.default_model,
            cwd=meta["cwd"],
            trust=trust,
            project_root=(meta.get("project") or {}).get("path") or meta["cwd"],
            messages=messages,
            emit=lambda ev, sid=sid: self._emit_threadsafe(sid, ev),
            compact_at=int(self.cfg.get("compact_at") or DEFAULT_COMPACT_AT),
        )
        engine.last_input_tokens = int(meta.get("context_tokens", 0) or 0)
        meta["archived"] = False
        session = Session(self, meta, engine)
        self.sessions[sid] = session
        self.chats[sid] = meta
        return session

    def create(self, *, cwd: str, provider: str, model: str | None, name: str | None,
               trust: str = "read", worktree: bool = False, title: str | None = None) -> Session:
        cwd = os.path.abspath(os.path.expanduser(cwd))
        if not os.path.isdir(cwd):
            raise ValueError(f"no such directory: {cwd}")
        sid = uuid.uuid4().hex[:8]
        base = name or os.path.basename(cwd.rstrip("/")) or "session"
        name = self._unique_name(base)
        now = time.time()
        root = projects.project_root(cwd)
        meta = {
            "id": sid,
            "name": name,
            "title": title or "",
            "cwd": cwd,
            "project": projects.project_info(root),
            "provider": provider,
            "model": model,
            "trust": trust if trust in TRUST_LEVELS else "read",
            "pinned": False,
            "archived": False,
            "created": now,
            "last_activity": now,
            "usage": {"input": 0, "output": 0, "cost": 0.0, "calls": 0, "turns": 0},
            "queue": [],
        }
        if worktree:
            from . import worktree as wt
            info = wt.create_worktree(root, name)
            meta["worktree"] = info
            meta["cwd"] = info["path"]
        session = self._build_session(meta, [])
        session.save_meta()
        session.save_messages()
        self._record(session, {"t": "system", "ts": now, "text": f"session {name} created in {meta['cwd']}"})
        self.broadcast_sessions()
        self.broadcast_chats()
        return session

    def _unique_name(self, base: str) -> str:
        taken = {m.get("name") for m in self.chats.values()}
        if base not in taken:
            return base
        n = 2
        while f"{base}-{n}" in taken:
            n += 1
        return f"{base}-{n}"

    def find_chat(self, ref: str) -> dict:
        """Chat meta by id, unique id prefix, or name (active or archived)."""
        if ref in self.chats:
            return self.chats[ref]
        matches = [m for m in self.chats.values() if m["id"].startswith(ref) or m.get("name") == ref]
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise KeyError(f"no session {ref!r}")
        active = [m for m in matches if not m.get("archived")]
        if len(active) == 1:
            return active[0]
        raise KeyError(f"ambiguous session {ref!r}")

    def get(self, ref: str) -> Session:
        """Active session by ref, resuming an archived chat if needed."""
        meta = self.find_chat(ref)
        session = self.sessions.get(meta["id"])
        if session is None:
            session = self.resume(meta["id"])
        return session

    def resume(self, sid: str) -> Session:
        meta = self.chats[sid]
        if sid in self.sessions:
            return self.sessions[sid]
        sdir = session_dir(sid)
        messages = load_messages(sdir)
        meta = dict(meta)
        meta["archived"] = False
        meta.pop("closed", None)
        cwd = meta.get("cwd") or os.getcwd()
        if not os.path.isdir(cwd):
            # worktree or folder gone: fall back to the project root
            root = (meta.get("project") or {}).get("path")
            meta["cwd"] = root if root and os.path.isdir(root) else os.path.expanduser("~")
        session = self._build_session(meta, messages)
        events = load_events(sdir, EVENT_TAIL)
        if not events and messages:
            events = chatlog.events_from_messages(messages, ts=meta.get("created"))
            session.rewrite_events(events)
        else:
            session.events.extend(events)
        session.save_meta()
        self._record(session, {"t": "system", "ts": time.time(), "text": "chat resumed"})
        self.broadcast_sessions()
        self.broadcast_chats()
        return session

    def archive(self, sid: str, delete: bool = False) -> None:
        session = self.sessions.get(sid)
        meta = self.chats.get(sid)
        if session is not None:
            if session.engine.busy:
                session.engine.interrupt()
            if session.shell is not None:
                try:
                    session.shell.close()
                except Exception:  # noqa: BLE001
                    pass
            session.save_messages()
            meta = session.snapshot()
            session.close_files()
            del self.sessions[sid]
        if meta is None:
            raise KeyError(f"no session {sid!r}")
        meta["archived"] = True
        meta["status"] = "archived"
        if delete:
            meta["deleted"] = True
            wt_info = meta.get("worktree")
            if wt_info:
                from . import worktree as wt
                try:
                    wt.remove_worktree(wt_info, delete_branch=True)
                except Exception as exc:  # noqa: BLE001
                    log.warning("worktree cleanup failed: %s", exc)
            shutil.rmtree(session_dir(sid), ignore_errors=True)
            self.chats.pop(sid, None)
        else:
            _atomic_write(os.path.join(session_dir(sid), "meta.json"), json.dumps(meta, indent=2))
            self.chats[sid] = meta
        self.broadcast_sessions()
        self.broadcast_chats()

    def update_chat_meta(self, sid: str, **fields) -> dict:
        session = self.sessions.get(sid)
        if session is not None:
            session.meta.update(fields)
            session.save_meta()
            meta = session.snapshot()
        else:
            meta = self.chats[sid]
            meta.update(fields)
            _atomic_write(os.path.join(session_dir(sid), "meta.json"), json.dumps(meta, indent=2))
        self.broadcast_chats()
        return meta

    # -- history / projects / search ------------------------------------

    def project_list(self) -> list:
        by_id: dict[str, dict] = {}
        for m in self.chats.values():
            p = m.get("project") or {}
            if not p.get("id"):
                continue
            entry = by_id.setdefault(p["id"], {**p, "chats": 0, "active": 0, "last_activity": 0})
            entry["chats"] += 1
            if not m.get("archived"):
                entry["active"] += 1
            entry["last_activity"] = max(entry["last_activity"], m.get("last_activity", 0))
        return sorted(by_id.values(), key=lambda p: p["last_activity"], reverse=True)

    def history(self, project: str | None = None, include_archived: bool = True, limit: int = 200) -> list:
        out = []
        for m in self.chats.values():
            if m.get("deleted"):
                continue
            if not include_archived and m.get("archived"):
                continue
            if project and (m.get("project") or {}).get("id") != project \
                    and (m.get("project") or {}).get("path") != project:
                continue
            out.append(self.chat_summary(m))
        out.sort(key=lambda m: (not m.get("pinned"), -m.get("last_activity", 0)))
        return out[:limit]

    def chat_summary(self, meta: dict) -> dict:
        session = self.sessions.get(meta["id"])
        m = session.snapshot() if session else dict(meta)
        m.setdefault("status", "archived")
        m["title"] = m.get("title") or m.get("name")
        return m

    def search(self, query: str, project: str | None = None, limit: int = 50) -> list:
        q = query.strip()
        if not q:
            return []
        results = []
        for m in self.chats.values():
            if m.get("deleted"):
                continue
            if project and (m.get("project") or {}).get("id") != project:
                continue
            sid = m["id"]
            session = self.sessions.get(sid)
            messages = session.engine.messages if session else load_messages(session_dir(sid))
            hits = chatlog.search_messages(messages, q)
            title_hit = q.lower() in (m.get("title") or m.get("name") or "").lower()
            if hits or title_hit:
                results.append({**self.chat_summary(m), "hits": hits})
            if len(results) >= limit:
                break
        results.sort(key=lambda r: -r.get("last_activity", 0))
        return results

    # -- events --------------------------------------------------------

    def _emit_threadsafe(self, sid: str, event: dict) -> None:
        try:
            self.loop.call_soon_threadsafe(self._on_engine_event, sid, event)
        except RuntimeError:
            pass  # loop already closed (daemon shutting down mid-turn)

    def _on_engine_event(self, sid: str, event: dict) -> None:
        """Runs on the event loop (via call_soon_threadsafe)."""
        session = self.sessions.get(sid)
        if session is None:
            return
        t = event["t"]
        if t == "usage":
            uncached = max(0, event["input"] - event.get("cache_read", 0) - event.get("cache_write", 0))
            event["cost"] = round(pricing.cost(
                event.get("model") or session.engine.model, uncached, event["output"],
                event.get("cache_read", 0), event.get("cache_write", 0),
            ), 6)
            u = session.meta.setdefault("usage", {"input": 0, "output": 0, "calls": 0, "turns": 0})
            u.setdefault("cost", 0.0)
            u["input"] += event["input"]
            u["output"] += event["output"]
            u["cost"] = round(u["cost"] + event["cost"], 6)
            u["calls"] += 1
            if self.today["date"] != _today():
                self._load_today()
            self.today["input"] += event["input"]
            self.today["output"] += event["output"]
            self.today["cost"] += event["cost"]
            self.today["calls"] += 1
            self._log_usage(session, event)
        elif t == "turn_start":
            session.meta.pop("interrupted", None)
            session.meta.pop("resume_text", None)
            session.save_messages()      # so a crash mid-turn keeps the user's message
        elif t == "turn_end":
            session.meta.setdefault("usage", {}).setdefault("turns", 0)
            session.meta["usage"]["turns"] += 1
            session.save_messages()
            if not session.meta.get("title"):
                session.meta["title"] = chatlog.auto_title(session.engine.messages, session.meta["name"])
        self._record(session, event)
        if t in ("status", "turn_start", "turn_end", "usage", "compaction"):
            session.save_meta()
            self.broadcast_sessions()
        if t == "turn_end":
            self.broadcast_chats()
            if event.get("result") == "ok":
                self.loop.call_later(0.2, self._advance_queue, sid)
            if self.cap_reached():
                self._record(session, {"t": "notice", "ts": time.time(),
                                       "text": f"daily spend cap of {pricing.fmt_usd(self.daily_cap())} reached; "
                                               "sessions are paused until the cap is raised or tomorrow"})

    def _advance_queue(self, sid: str) -> None:
        session = self.sessions.get(sid)
        if session is None or session.engine.busy:
            return
        queue = session.meta.get("queue") or []
        if not queue:
            return
        if self.cap_reached():
            return
        task = queue.pop(0)
        session.meta["queue"] = queue
        text = task.get("text") if isinstance(task, dict) else str(task)
        try:
            self.record_user(session, text, [])
            session.engine.send(text, [])
            self._record(session, {"t": "queue", "ts": time.time(), "remaining": len(queue), "started": text[:200]})
        except EngineBusy:
            queue.insert(0, task)
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
                "cache_read": event.get("cache_read", 0),
                "cache_write": event.get("cache_write", 0),
                "cost": event.get("cost", 0.0),
            }) + "\n")
            self._usage_file.flush()
        except OSError as exc:
            log.warning("usage log write failed: %s", exc)

    def sessions_frame(self) -> str:
        return json.dumps({
            "type": "sessions",
            "sessions": [s.snapshot() for s in self.sessions.values()],
            "stats": self.stats(),
        })

    def chats_frame(self) -> str:
        return json.dumps({"type": "chats", "chats": self.history(), "projects": self.project_list()})

    def broadcast_sessions(self) -> None:
        frame = self.sessions_frame()
        for client in list(self.clients):
            client.queue.put_nowait(frame)

    def broadcast_chats(self) -> None:
        frame = self.chats_frame()
        for client in list(self.clients):
            client.queue.put_nowait(frame)

    def broadcast_raw(self, frame: str, sid: str | None = None) -> None:
        for client in list(self.clients):
            if sid is None or client.wants(sid):
                client.queue.put_nowait(frame)


# ----------------------------------------------------------------------
# request handling
# ----------------------------------------------------------------------

class RequestError(Exception):
    pass


def _save_images(session: Session, images: list) -> list:
    """Accept image paths (local clients) or {name, data_url} uploads (browser)."""
    out = []
    updir = os.path.join(session.dir, "uploads")
    for img in images or []:
        if isinstance(img, str):
            if os.path.isfile(img):
                out.append(img)
            continue
        if isinstance(img, dict) and img.get("data_url", "").startswith("data:"):
            header, _, b64 = img["data_url"].partition(",")
            mime = header[5:].split(";")[0]
            ext = mimetypes.guess_extension(mime) or ".png"
            os.makedirs(updir, exist_ok=True)
            name = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}{ext}"
            path = os.path.join(updir, name)
            try:
                with open(path, "wb") as f:
                    f.write(base64.b64decode(b64))
                out.append(path)
            except (ValueError, OSError):
                continue
    return out


async def _dispatch(manager: Manager, client: Client, req: dict) -> dict:
    t = req.get("type")

    if t == "ping":
        return {"pong": time.time(), "version": __version__}

    if t == "list":
        return {"sessions": [s.snapshot() for s in manager.sessions.values()], "stats": manager.stats()}

    if t == "stats":
        return {"stats": manager.stats()}

    if t == "config":
        if "daily_cap_usd" in req:
            try:
                cap = max(0.0, float(req["daily_cap_usd"] or 0))
            except (TypeError, ValueError):
                raise RequestError("daily_cap_usd must be a number")
            manager.cfg["daily_cap_usd"] = cap
            config.save({"daily_cap_usd": cap})
            manager.broadcast_sessions()
        return {"config": {k: v for k, v in manager.cfg.items() if k != "pricing"}, "stats": manager.stats()}

    if t == "projects":
        return {"projects": manager.project_list()}

    if t == "history":
        return {"chats": manager.history(req.get("project"), not req.get("active_only"), int(req.get("limit") or 200)),
                "projects": manager.project_list()}

    if t == "search":
        return {"results": manager.search(req.get("q") or "", req.get("project"), int(req.get("limit") or 50))}

    if t == "create":
        provider = req.get("provider") or auth.load_config().get("default_provider")
        if provider not in PROVIDERS:
            raise RequestError(f"unknown provider: {provider}")
        if manager.cap_reached():
            raise RequestError("daily spend cap reached")
        trust = req.get("trust") or ("auto" if req.get("auto_approve") else "read")
        try:
            session = manager.create(
                cwd=req.get("cwd") or os.getcwd(),
                provider=provider,
                model=req.get("model"),
                name=req.get("name"),
                trust=trust,
                worktree=bool(req.get("worktree")),
                title=req.get("title"),
            )
        except ValueError as exc:
            raise RequestError(str(exc))
        except Exception as exc:  # noqa: BLE001 (git failures etc.)
            raise RequestError(f"{type(exc).__name__}: {exc}")
        client.subs.add(session.id)
        task = (req.get("task") or "").strip()
        if task:
            manager.record_user(session, task, [])
            session.engine.send(task, [])
        for extra in req.get("queue") or []:
            if str(extra).strip():
                session.meta.setdefault("queue", []).append({"text": str(extra).strip(), "added": time.time()})
        session.save_meta()
        return {"session": session.snapshot()}

    if t == "attach":
        sid = req.get("sid")
        if sid == "*":
            client.all = True
            return {"sessions": [s.snapshot() for s in manager.sessions.values()], "stats": manager.stats()}
        session = _session(manager, sid)
        client.subs.add(session.id)
        replay = int(req.get("replay", 0) or 0)
        if replay < 0:
            events = session.all_events()
        else:
            events = list(session.events)[-replay:] if replay else []
        return {"session": session.snapshot(), "events": events}

    if t == "detach":
        sid = req.get("sid")
        if sid == "*":
            client.all = False
        else:
            client.subs.discard(sid)
        return {}

    if t == "files":
        root = req.get("root")
        if not root:
            meta = manager.find_chat(str(req.get("sid")))
            root = (meta.get("project") or {}).get("path") or meta.get("cwd")
        if not root or not os.path.isdir(root):
            raise RequestError("no such project")
        allf = projects.list_files(root)
        return {"files": projects.fuzzy_filter(allf, req.get("q") or "", int(req.get("limit") or 30)), "total": len(allf)}

    if t == "instructions":
        meta = manager.find_chat(str(req.get("sid")))
        root = (meta.get("project") or {}).get("path") or meta.get("cwd")
        path = projects.instructions_path(root)
        return {"path": path, "text": projects.load_instructions(root, meta.get("cwd"))}

    if t == "export":
        meta = manager.find_chat(str(req.get("sid")))
        session = manager.sessions.get(meta["id"])
        messages = session.engine.messages if session else load_messages(session_dir(meta["id"]))
        return {"markdown": chatlog.export_markdown(manager.chat_summary(meta), messages),
                "title": meta.get("title") or meta.get("name")}

    if t in ("pin", "title", "rename", "archive", "unarchive", "delete", "close"):
        meta = manager.find_chat(str(req.get("sid")))
        sid = meta["id"]
        if t == "pin":
            return {"session": manager.update_chat_meta(sid, pinned=bool(req.get("pinned", True)))}
        if t == "title":
            title = (req.get("title") or "").strip()
            if not title:
                raise RequestError("empty title")
            return {"session": manager.update_chat_meta(sid, title=title)}
        if t == "rename":
            name = (req.get("name") or "").strip()
            if not name:
                raise RequestError("empty name")
            return {"session": manager.update_chat_meta(sid, name=name)}
        if t in ("archive", "close"):
            manager.archive(sid)
            return {}
        if t == "unarchive":
            return {"session": manager.resume(sid).snapshot()}
        if t == "delete":
            manager.archive(sid, delete=True)
            return {}

    if t == "resume":
        session = _session(manager, req.get("sid"))
        return {"session": session.snapshot()}

    # everything below needs an active session
    session = _session(manager, req.get("sid"))
    engine = session.engine

    if t == "send":
        text = req.get("text") or ""
        images = _save_images(session, req.get("images") or [])
        if not text.strip() and not images:
            raise RequestError("empty message")
        if manager.cap_reached():
            raise RequestError(f"daily spend cap of {pricing.fmt_usd(manager.daily_cap())} reached")
        if engine.busy:
            if req.get("queue_if_busy"):
                session.meta.setdefault("queue", []).append({"text": text, "added": time.time()})
                session.save_meta()
                manager.broadcast_sessions()
                return {"queued": True, "position": len(session.meta["queue"])}
            raise RequestError("session is busy; wait for the current turn to finish")
        try:
            manager.record_user(session, text, images)
            engine.send(text, images)
        except EngineBusy:
            raise RequestError("session is busy; wait for the current turn to finish")
        return {}

    if t == "resume_turn":
        text = session.meta.get("resume_text") or (req.get("text") or "")
        if not text.strip():
            raise RequestError("nothing to resume")
        if engine.busy:
            raise RequestError("session is busy")
        manager.record_user(session, text, [])
        engine.send(text, [])
        return {}

    if t == "approve":
        ok = engine.approve(req.get("rid"), bool(req.get("approved")))
        if not ok:
            raise RequestError("no such pending approval")
        return {}

    if t == "interrupt":
        return {"interrupted": engine.interrupt()}

    if t == "queue":
        action = req.get("action", "add")
        queue = session.meta.setdefault("queue", [])
        if action == "add":
            text = (req.get("text") or "").strip()
            if not text:
                raise RequestError("empty task")
            queue.append({"text": text, "added": time.time()})
        elif action == "remove":
            idx = int(req.get("index", -1))
            if 0 <= idx < len(queue):
                queue.pop(idx)
        elif action == "clear":
            queue.clear()
        session.save_meta()
        manager.broadcast_sessions()
        if not engine.busy:
            manager._advance_queue(session.id)
        return {"queue": session.meta["queue"]}

    if t == "edit":
        # edit-and-resend: drop everything from user turn `turn` on, then send
        turns = chatlog.user_turn_indices(engine.messages)
        k = int(req.get("turn", -1))
        if not (0 <= k < len(turns)):
            raise RequestError("no such turn")
        text = (req.get("text") or "").strip()
        if not text:
            raise RequestError("empty message")
        try:
            engine.truncate(turns[k])
        except EngineBusy as exc:
            raise RequestError(str(exc))
        _truncate_events(session, k)
        session.save_messages()
        manager._record(session, {"t": "history_reset", "ts": time.time(), "turn": k,
                                  "text": f"edited message {k + 1}; later history discarded"})
        manager.record_user(session, text, [])
        engine.send(text, [])
        return {}

    if t == "fork":
        turns = chatlog.user_turn_indices(engine.messages)
        k = int(req.get("turn", len(turns) - 1))
        if not turns:
            raise RequestError("nothing to fork")
        k = max(0, min(k, len(turns) - 1))
        end = turns[k + 1] if k + 1 < len(turns) else len(engine.messages)
        messages = json.loads(json.dumps(engine.messages[:end]))
        new = manager.create(
            cwd=engine.cwd, provider=session.meta["provider"], model=engine.model,
            name=f"{session.meta['name']}-fork", trust=engine.trust,
            title=f"{session.meta.get('title') or session.meta['name']} (fork)",
        )
        new.engine.messages[:] = messages
        new.engine.last_input_tokens = engine.last_input_tokens
        new.meta["forked_from"] = {"sid": session.id, "turn": k}
        new.rewrite_events(chatlog.events_from_messages(messages, ts=time.time()))
        new.seq = len(new.events)
        new.save_messages()
        new.save_meta()
        client.subs.add(new.id)
        manager.broadcast_chats()
        return {"session": new.snapshot()}

    if t == "compact":
        if engine.busy:
            raise RequestError("session is busy")
        import threading
        threading.Thread(target=_compact_thread, args=(session,), daemon=True).start()
        return {}

    if t == "set":
        changed = {}
        if req.get("model"):
            engine.model = str(req["model"])
            session.meta["model"] = engine.model
            changed["model"] = engine.model
        if req.get("cwd"):
            cwd = os.path.abspath(os.path.expanduser(req["cwd"]))
            if not os.path.isdir(cwd):
                raise RequestError(f"no such directory: {cwd}")
            engine.cwd = cwd
            session.meta["cwd"] = cwd
            if not session.meta.get("worktree"):
                root = projects.project_root(cwd)
                session.meta["project"] = projects.project_info(root)
                engine.project_root = root
            changed["cwd"] = cwd
        if "auto_approve" in req:
            engine.auto_approve = bool(req["auto_approve"])
            session.meta["trust"] = engine.trust
            changed["auto_approve"] = engine.auto_approve
            changed["trust"] = engine.trust
        if req.get("trust"):
            if req["trust"] not in TRUST_LEVELS:
                raise RequestError(f"trust must be one of {', '.join(TRUST_LEVELS)}")
            engine.trust = req["trust"]
            session.meta["trust"] = engine.trust
            changed["trust"] = engine.trust
        if req.get("provider"):
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
        session.rewrite_events([])
        manager._record(session, {"t": "history_reset", "ts": time.time(), "turn": 0, "text": "conversation cleared"})
        return {}

    if t in ("git", "merge", "pr", "discard", "commit"):
        from . import worktree as wt
        return wt.handle_request(manager, session, t, req)

    if t in ("shell_open", "shell_input", "shell_resize", "shell_close", "shell_kill_tool"):
        from . import shell
        return shell.handle_request(manager, session, t, req)

    raise RequestError(f"unknown request type: {t}")


def _compact_thread(session: Session) -> None:
    try:
        session.engine.compact()
    except Exception as exc:  # noqa: BLE001
        session.engine.emit("notice", text=f"compaction failed: {exc}")


def _truncate_events(session: Session, turn: int) -> None:
    """Keep persisted events up to (not including) user turn `turn`."""
    events = session.all_events()
    seen = 0
    cut = len(events)
    for i, e in enumerate(events):
        if e["t"] == "user":
            if seen == turn:
                cut = i
                break
            seen += 1
    # the turn_start right before the user event belongs to it too
    if cut > 0 and events[cut - 1]["t"] == "turn_start":
        cut -= 1
    session.rewrite_events(events[:cut])


def _session(manager: Manager, sid) -> Session:
    if not sid:
        raise RequestError("missing sid")
    try:
        return manager.get(str(sid))
    except KeyError as exc:
        raise RequestError(str(exc))
    except ValueError as exc:
        raise RequestError(str(exc))


# ----------------------------------------------------------------------
# server
# ----------------------------------------------------------------------

def _serve_static(request):
    path = request.path.split("?", 1)[0]
    if path in ("/", ""):
        path = "/index.html"
    if path == "/health":
        body = b"ok\n"
        return Response(200, "OK", Headers([("Content-Type", "text/plain"), ("Content-Length", str(len(body)))]), body)
    rel = os.path.normpath(path.lstrip("/"))
    if rel.startswith("..") or os.path.isabs(rel):
        return Response(404, "Not Found", Headers([("Content-Length", "0")]), b"")
    full = os.path.join(WEB_DIR, rel)
    if not os.path.isfile(full):
        return Response(404, "Not Found", Headers([("Content-Type", "text/plain"), ("Content-Length", "10")]), b"not found\n")
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    with open(full, "rb") as f:
        body = f.read()
    return Response(200, "OK", Headers([
        ("Content-Type", ctype), ("Content-Length", str(len(body))), ("Cache-Control", "no-cache"),
    ]), body)


def _make_process_request():
    def process_request(connection, request):
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return _serve_static(request)
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
    except Exception:  # noqa: BLE001
        await ws.close(4400, "expected auth frame")
        return

    client = Client(ws)
    manager.clients.add(client)
    sender = asyncio.create_task(_client_sender(client))
    await ws.send(json.dumps({"type": "reply", "id": hello.get("id"), "ok": True, "version": __version__}))
    client.queue.put_nowait(manager.sessions_frame())
    client.queue.put_nowait(manager.chats_frame())
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
            if rid is not None:
                await ws.send(json.dumps(reply))
    finally:
        manager.clients.discard(client)
        for session in manager.sessions.values():
            if session.shell is not None and getattr(session.shell, "owner", None) is client:
                session.shell.detach()
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
    """True if kcoderd answers /health on host:port."""
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
        process_request=_make_process_request(),
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
