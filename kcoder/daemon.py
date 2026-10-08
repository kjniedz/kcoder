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
import subprocess
import sys
import threading
import time
import uuid

from websockets.asyncio.server import serve, unix_serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from . import __version__, auth, chatlog, config, identity, paths, pricing, projects, repos, setup, stats, updater
from . import uninstall as uninstaller
from . import worktree as wt
from .errors import RequestError
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
mimetypes.add_type("application/manifest+json", ".webmanifest")


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
        m["status"] = "paused" if (self.meta.get("interrupted") and self.engine.status == "idle") else self.engine.status
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
        m["plan"] = self.engine.provider.kind == "claude"
        info = self.meta.get("worktree")
        m["worktree_attached"] = bool(info and wt.is_attached(info))
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
        self.restarting = False

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
                was_busy = meta.get("status") in ("working", "waiting", "paused") or bool(meta.get("interrupted"))
                resume_text = None
                if messages and chatlog.is_user_turn(messages[-1]):
                    # the daemon died mid-turn: the last user message never got
                    # an answer. Never re-run it silently - offer a resume.
                    resume_text = chatlog.user_text(messages.pop())
                    was_busy = True
                orphan = meta.pop("turn_pid", None)
                if orphan:
                    self._kill_orphan(int(orphan), meta.get("name"))
                info = meta.get("worktree")
                if info and not wt.is_attached(info):
                    try:
                        meta["worktree"] = wt.reattach_worktree(info)
                        meta["cwd"] = info["path"]
                    except wt.GitError as exc:
                        log.warning("session %s: worktree not reattached: %s", sid, exc)
                        if not os.path.isdir(meta.get("cwd") or ""):
                            meta["cwd"] = info.get("root") if os.path.isdir(info.get("root") or "") else os.path.expanduser("~")
                session = self._build_session(meta, messages)
                session.events.extend(load_events(sdir, EVENT_TAIL))
                if was_busy:
                    session.meta["interrupted"] = True
                    session.meta["resume_text"] = resume_text or session.meta.get("resume_text")
                    if not session.meta.get("paused_noted"):
                        self._record(session, {
                            "t": "system", "ts": time.time(), "kind": "interrupted",
                            "text": "kcoderd restarted while this session was working; the unfinished "
                                    "turn was not re-run. It is paused - resume to send it again.",
                        })
                        session.meta["paused_noted"] = True
                    session.save_messages()
                session.save_meta()
                log.info("loaded session %s (%s) in %s", sid, meta.get("name"), meta.get("cwd"))
            except Exception as exc:  # noqa: BLE001 - one bad session must not stop the daemon
                log.exception("failed to load session %s: %s", sid, exc)

    def start_backfill(self) -> None:
        """Fill usage/commit history from session logs so stats never start at zero."""
        def run():
            try:
                if identity.account():
                    identity.ensure_credential_helper()
            except Exception as exc:  # noqa: BLE001
                log.warning("git credential setup failed: %s", exc)
            try:
                stats.backfill_all()
            except Exception as exc:  # noqa: BLE001
                log.warning("stats backfill failed: %s", exc)
            self._hdr_at = 0
        threading.Thread(target=run, name="stats-backfill", daemon=True).start()

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

    def _header_stats(self) -> dict:
        now = time.time()
        if now - getattr(self, "_hdr_at", 0) > 5:
            try:
                self._hdr = stats.header_stats()
            except Exception as exc:  # noqa: BLE001
                log.warning("header stats failed: %s", exc)
                self._hdr = {}
            self._hdr_at = now
        return getattr(self, "_hdr", {})

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
            **self._header_stats(),
            "daily_cap_usd": self.daily_cap(),
            "cap_reached": self.cap_reached(),
            "version": __version__,
            "update": self._update_summary(),
            "restarting": self.restarting,
        }

    def _update_summary(self) -> dict:
        now = time.time()
        if now - getattr(self, "_upd_at", 0) > 5:
            try:
                self._upd = updater.status_summary()
            except Exception as exc:  # noqa: BLE001
                log.warning("update status failed: %s", exc)
                self._upd = {}
            self._upd_at = now
        return getattr(self, "_upd", {})

    def all_idle(self) -> bool:
        return not any(s.engine.busy for s in self.sessions.values())

    def clients_idle(self) -> bool:
        return not any(s.engine.pending_approval() for s in self.sessions.values())

    def busy_names(self) -> list:
        return [s.meta["name"] for s in self.sessions.values() if s.engine.busy]

    def _kill_orphan(self, pid: int, name: str | None = None) -> None:
        """A turn's subprocess (the claude CLI or a shell) that outlived the
        previous daemon. Kill it so it cannot keep editing files unattended."""
        if not _pid_alive(pid):
            return
        try:
            cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            cmd = ""
        if not any(k in cmd for k in ("claude", "kcoder", "/bin/sh", "bash", "zsh")):
            log.warning("pid %d (noted for %s) is now %r; not touching it", pid, name, cmd.strip()[:60])
            return
        log.warning("killing orphaned turn process %d of %s: %s", pid, name, cmd.strip()[:80])
        for sig_ in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig_)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, sig_)
                except OSError:
                    return
            for _ in range(20):
                if not _pid_alive(pid):
                    return
                time.sleep(0.1)

    def _note_proc(self, sid: str, pid: int | None) -> None:
        session = self.sessions.get(sid)
        if session is None:
            return
        if pid:
            session.meta["turn_pid"] = pid
        else:
            session.meta.pop("turn_pid", None)
        session.save_meta()

    def shutdown(self) -> None:
        busy = [s for s in self.sessions.values() if s.engine.busy]
        for session in busy:
            # come back paused, with the turn's text ready to resend
            session.meta["interrupted"] = True
            text = session.engine.current_user_text
            if text:
                session.meta["resume_text"] = text
            session.engine.interrupt()
        deadline = time.monotonic() + 4.0
        for session in busy:
            t = session.engine._thread
            if t is not None and t.is_alive():
                t.join(max(0.05, deadline - time.monotonic()))
            session.meta.pop("turn_pid", None)
        for session in self.sessions.values():
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
        engine.on_proc = lambda p, sid=sid: self.loop.call_soon_threadsafe(self._note_proc, sid, getattr(p, "pid", None))
        if hasattr(backend, "session_id"):
            backend.session_id = meta.get("claude_session")
        meta["archived"] = False
        session = Session(self, meta, engine)
        self.sessions[sid] = session
        self.chats[sid] = meta
        return session

    def create(self, *, cwd: str, provider: str, model: str | None, name: str | None,
               trust: str = "read", worktree: bool | None = None, title: str | None = None,
               start: str | None = None) -> Session:
        """`worktree` None means the default: a worktree whenever the folder
        is a git repo (config `worktrees`). `start` is the branch/commit the
        session branch begins from (forks pass the parent's branch)."""
        cwd = os.path.abspath(os.path.expanduser(cwd))
        if not os.path.isdir(cwd):
            raise ValueError(f"no such directory: {cwd}")
        sid = uuid.uuid4().hex[:8]
        base = name or os.path.basename(cwd.rstrip("/")) or "session"
        name = self._unique_name(base)
        now = time.time()
        root = projects.project_root(cwd)
        is_git = projects.git_toplevel(root) == root
        if worktree is None:
            worktree = bool(self.cfg.get("worktrees", True)) and is_git
        worktree = bool(worktree) and is_git
        wt_note = None
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
            try:
                info = wt.create_worktree(root, name, start)
                meta["worktree"] = info
                meta["cwd"] = info["path"]
            except wt.GitError as exc:
                wt_note = f"no worktree for this session ({exc}); working directly in {cwd}"
                log.warning("session %s: %s", name, wt_note)
        session = self._build_session(meta, [])
        session.save_meta()
        session.save_messages()
        where = f"{meta['cwd']} (branch {meta['worktree']['branch']})" if meta.get("worktree") else meta["cwd"]
        self._record(session, {"t": "system", "ts": now, "text": f"session {name} created in {where}"})
        if wt_note:
            self._record(session, {"t": "notice", "ts": now, "text": wt_note})
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
        info = meta.get("worktree")
        note = None
        if info and not wt.is_attached(info):
            try:
                meta["worktree"] = wt.reattach_worktree(info)
                meta["cwd"] = cwd = info["path"]
                note = f"worktree restored from branch {info['branch']}"
            except wt.GitError as exc:
                note = f"worktree could not be restored ({exc})"
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
        self._record(session, {"t": "system", "ts": time.time(), "text": "chat resumed" + (f"; {note}" if note else "")})
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
        wt_info = meta.get("worktree")
        if wt_info and not delete:
            # free the checkout; the branch (with a checkpoint of any
            # uncommitted work) stays and comes back on resume
            try:
                meta["worktree"] = wt.detach_worktree(wt_info)
            except Exception as exc:  # noqa: BLE001
                log.warning("worktree for %s left in place: %s", sid, exc)
        if delete:
            meta["deleted"] = True
            if wt_info:
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
            if "cost" not in event:
                event["cost"] = round(pricing.cost(
                    event.get("model") or session.engine.model, uncached, event["output"],
                    event.get("cache_read", 0), event.get("cache_write", 0),
                ), 6)
            if session.engine.provider.kind == "claude":
                # covered by the user's Claude plan: keep the API-equivalent for
                # reference, but it is not money spent
                event["api_equivalent"] = event["cost"]
                event["cost"] = 0.0
                event["plan"] = True
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
            if (session.meta.get("project") or {}).get("git") or session.meta.get("worktree"):
                session.head_at_turn_start = stats.head(session.engine.cwd)
        elif t == "turn_end":
            session.meta.pop("turn_pid", None)
            session.meta.setdefault("usage", {}).setdefault("turns", 0)
            session.meta["usage"]["turns"] += 1
            if hasattr(session.engine.backend, "session_id"):
                session.meta["claude_session"] = session.engine.backend.session_id
            session.save_messages()
            if not session.meta.get("title"):
                session.meta["title"] = chatlog.auto_title(session.engine.messages, session.meta["name"])
        self._record(session, event)
        if t in ("status", "turn_start", "turn_end", "usage", "compaction"):
            session.save_meta()
            self.broadcast_sessions()
        if t == "turn_end":
            self.broadcast_chats()
            if (session.meta.get("project") or {}).get("git") or session.meta.get("worktree"):
                self.loop.run_in_executor(None, self._track_commits, session)
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

    def _track_commits(self, session: Session) -> None:
        """Runs in a worker thread after a turn (and after explicit git actions)."""
        try:
            rows = stats.record_new_commits(session.id, session.engine.cwd,
                                            getattr(session, "head_at_turn_start", None), session.meta)
            session.head_at_turn_start = stats.head(session.engine.cwd)
        except Exception as exc:  # noqa: BLE001
            log.warning("commit tracking failed for %s: %s", session.id, exc)
            return
        if rows:
            def announce():
                for r in rows:
                    self._record(session, {"t": "git", "ts": time.time(), "commit": r["sha"][:7],
                                           "text": f"commit {r['sha'][:7]}: {r['subject']}"})
                self._hdr_at = 0
                self.broadcast_sessions()
            self.loop.call_soon_threadsafe(announce)

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
                "api_equivalent": event.get("api_equivalent", 0.0),
                "plan": bool(event.get("plan")),
            }) + "\n")
            self._usage_file.flush()
            self._hdr_at = 0
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
        if req.get("default_trust") in TRUST_LEVELS:
            manager.cfg["default_trust"] = req["default_trust"]
            config.save({"default_trust": req["default_trust"]})
        if "auto_publish" in req:
            manager.cfg["auto_publish"] = bool(req["auto_publish"])
            config.save({"auto_publish": bool(req["auto_publish"])})
        if req.get("commit_email") in ("noreply", "public"):
            manager.cfg["commit_email"] = req["commit_email"]
            config.save({"commit_email": req["commit_email"]})
        if "ai_trailer" in req:
            manager.cfg["ai_trailer"] = str(req["ai_trailer"] or "").strip()[:200]
            config.save({"ai_trailer": manager.cfg["ai_trailer"]})
        return {"config": {k: v for k, v in manager.cfg.items() if k != "pricing"}, "stats": manager.stats()}

    if t == "projects":
        return {"projects": manager.project_list()}

    if t == "repos":
        return {"local": repos.local_repos(), "github": repos.github_repos() if req.get("github", True) else [],
                "projects_dir": repos.projects_dir()}

    if t == "clone":
        spec = repos.parse_spec(req.get("spec") or "")
        if not spec:
            raise RequestError("expected owner/name or a GitHub URL")
        try:
            path = await asyncio.get_running_loop().run_in_executor(None, repos.clone, spec, req.get("dest_dir"))
        except Exception as exc:  # noqa: BLE001
            raise RequestError(f"clone failed: {exc}")
        return {"path": path, "spec": spec}

    if t == "providers":
        loop = asyncio.get_running_loop()
        return {"providers": await loop.run_in_executor(None, setup.providers_info),
                "github": await loop.run_in_executor(None, setup.github_status)}

    if t == "github":
        return {"github": await asyncio.get_running_loop().run_in_executor(None, setup.github_status, bool(req.get("refresh")))}

    if t == "connect":
        # first-run sign-in from the app: API key providers are validated and
        # saved here; Claude Code install / sign-in run in the user's Terminal
        pid = str(req.get("provider") or "")
        action = str(req.get("action") or "")
        loop = asyncio.get_running_loop()
        try:
            if pid == "github":
                if action in ("login", "switch"):
                    cmd = setup.gh_login_command() if action == "login" else setup.gh_switch_command()
                    if await loop.run_in_executor(None, setup.open_terminal, cmd):
                        msg = "A Terminal window opened and your browser will follow. Sign in there, then click Check again."
                    else:
                        msg = f"Could not open a terminal. Run this yourself: {cmd}"
                    return {"message": msg}
                st = await loop.run_in_executor(None, setup.github_status, True)
                if st["connected"]:
                    await loop.run_in_executor(None, identity.ensure_credential_helper)
                    st = await loop.run_in_executor(None, setup.github_status, False)
                return {"message": f"GitHub connected as @{st['login']}" if st["connected"] else "GitHub is not connected yet", "github": st}
            if pid == "claude" and action in ("install", "login"):
                cmd = setup.claude_install_command() if action == "install" else setup.claude_login_command()
                if await loop.run_in_executor(None, setup.open_terminal, cmd):
                    msg = "A Terminal window opened. Follow the steps there, then click Check again."
                else:
                    msg = f"Could not open a terminal. Run this yourself: {cmd}"
                return {"message": msg}
            if action == "default":
                setup.make_default(pid)
                msg = f"{PROVIDERS[pid].label} is now the default provider" if pid in PROVIDERS else "unknown provider"
            elif pid == "claude":
                msg = await loop.run_in_executor(None, setup.use_claude)
            else:
                msg = await loop.run_in_executor(None, setup.connect_api_key, pid, str(req.get("api_key") or ""))
        except ValueError as exc:
            raise RequestError(str(exc))
        return {"message": msg, "providers": await loop.run_in_executor(None, setup.providers_info)}

    if t == "stats_full":
        return await asyncio.get_running_loop().run_in_executor(None, stats.full, int(req.get("days") or 30))

    if t == "notify":
        # a desktop notification on behalf of a client that has no Notification
        # API of its own (the native window); macOS only, best effort
        title = str(req.get("title") or "kcoder")[:120]
        body = str(req.get("body") or "")[:240]
        if sys.platform == "darwin":
            script = 'display notification "%s" with title "%s"' % (
                body.replace("\\", "\\\\").replace('"', '\\"'), title.replace("\\", "\\\\").replace('"', '\\"'))
            await asyncio.get_running_loop().run_in_executor(
                None, lambda: subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10))
            return {"sent": True}
        return {"sent": False}

    if t == "ui_state":
        # the app's layout (panes, order, view), so it survives a wiped
        # browser profile and follows the user to another window
        if "state" in req:
            data = req["state"]
            if not isinstance(data, dict):
                raise RequestError("state must be an object")
            text = json.dumps(data)
            if len(text) > 200_000:
                raise RequestError("ui state too large")
            _atomic_write(paths.UI_STATE_PATH, text)
            return {"saved": True}
        try:
            with open(paths.UI_STATE_PATH, "r", encoding="utf-8") as f:
                return {"state": json.load(f)}
        except (FileNotFoundError, json.JSONDecodeError):
            return {"state": None}

    if t == "update":
        action = req.get("action") or "status"
        if action == "check":
            await asyncio.get_running_loop().run_in_executor(None, updater.check_and_download)
            manager._upd_at = 0
            manager.broadcast_sessions()
        elif action == "apply":
            return _begin_restart(manager, apply=True, force=bool(req.get("force")))
        return {"update": updater.status_summary()}

    if t == "restart":
        return _begin_restart(manager, force=bool(req.get("force")))

    if t == "uninstall":
        busy = manager.busy_names()
        if busy and not req.get("force"):
            raise RequestError(f"{len(busy)} session(s) are still working ({', '.join(busy[:3])})")
        uninstaller.run(bool(req.get("delete_history")), bool(req.get("delete_keys")), wait_pid=os.getpid())
        manager.restarting = True
        manager.loop.call_later(0.5, manager.stop.set)
        return {"uninstalling": True, "delete_history": bool(req.get("delete_history")), "delete_keys": bool(req.get("delete_keys"))}

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
        default_trust = manager.cfg.get("default_trust") if manager.cfg.get("default_trust") in TRUST_LEVELS else "auto"
        trust = req.get("trust") or ("auto" if req.get("auto_approve") else default_trust)
        cwd = req.get("cwd") or os.getcwd()
        spec = repos.parse_spec(cwd)
        pulled = None
        if spec:  # a GitHub repo: clone it, or reuse the existing clone and pull it
            try:
                cwd = await asyncio.get_running_loop().run_in_executor(None, repos.clone, spec, None)
            except Exception as exc:  # noqa: BLE001
                raise RequestError(f"clone failed: {exc}")
            if req.get("pull", True):
                pulled = await asyncio.get_running_loop().run_in_executor(None, repos.update, cwd)
        # a local folder: make it a git repo now (every session works in its
        # own worktree) and, with gh signed in, create + push the GitHub repo
        # in the background
        publish_root = None
        if not spec:
            root = projects.project_root(cwd)
            if not projects.git_toplevel(root) and manager.cfg.get("worktrees", True):
                try:
                    await asyncio.get_running_loop().run_in_executor(None, repos.init_repo, root)
                except Exception as exc:  # noqa: BLE001
                    log.warning("not initialising a repo in %s: %s", root, exc)
            if manager.cfg.get("auto_publish", True) and shutil.which("gh") and projects.git_toplevel(root) and not repos.github_spec(root):
                publish_root = root
        try:
            session = manager.create(
                cwd=cwd,
                provider=provider,
                model=req.get("model"),
                name=req.get("name"),
                trust=trust,
                worktree=None if req.get("worktree") is None else bool(req.get("worktree")),
                title=req.get("title"),
            )
        except ValueError as exc:
            raise RequestError(str(exc))
        except Exception as exc:  # noqa: BLE001 (git failures etc.)
            raise RequestError(f"{type(exc).__name__}: {exc}")
        client.subs.add(session.id)
        if pulled:
            manager._record(session, {"t": "git", "ts": time.time(), "text": f"{spec}: {pulled}"})
        if publish_root:
            asyncio.get_running_loop().create_task(_auto_publish(manager, session, publish_root))
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
        if req.get("discard"):
            session.meta.pop("interrupted", None)
            session.meta.pop("resume_text", None)
            session.meta.pop("paused_noted", None)
            session.save_meta()
            manager._record(session, {"t": "system", "ts": time.time(), "text": "interrupted turn discarded"})
            manager.broadcast_sessions()
            return {}
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
            if hasattr(engine.backend, "session_id"):
                engine.backend.session_id = None   # Claude Code can't rewind; it restarts from our history summary
                session.meta.pop("claude_session", None)
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
        parent_wt = session.meta.get("worktree")
        if parent_wt and not engine.busy:
            try:
                wt.checkpoint(parent_wt["path"], f"kcoder: checkpoint before forking {parent_wt['branch']}")
            except Exception as exc:  # noqa: BLE001
                log.warning("fork: parent checkpoint skipped: %s", exc)
        new = manager.create(
            cwd=parent_wt["root"] if parent_wt else engine.cwd, provider=session.meta["provider"], model=engine.model,
            name=f"{session.meta['name']}-fork", trust=engine.trust,
            title=f"{session.meta.get('title') or session.meta['name']} (fork)",
            start=parent_wt["branch"] if parent_wt else None,
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
            if hasattr(engine.backend, "session_id"):
                engine.backend.session_id = None
                session.meta.pop("claude_session", None)
        except EngineBusy as exc:
            raise RequestError(str(exc))
        session.save_messages()
        session.rewrite_events([])
        manager._record(session, {"t": "history_reset", "ts": time.time(), "turn": 0, "text": "conversation cleared"})
        return {}

    if t in ("git", "pull", "merge", "pr", "discard", "commit"):
        from . import worktree as wt
        result = wt.handle_request(manager, session, t, req)
        if t in ("git", "merge", "commit", "pr"):
            asyncio.get_running_loop().run_in_executor(None, manager._track_commits, session)
        return result


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

async def _auto_publish(manager, session, root: str) -> None:
    """Create a private GitHub repo for `root` and push it; report in the session log."""
    try:
        spec = await asyncio.get_running_loop().run_in_executor(None, repos.publish, root)
    except Exception as exc:  # noqa: BLE001
        log.warning("auto-publish failed for %s: %s", root, exc)
        manager._record(session, {"t": "system", "ts": time.time(), "text": f"GitHub publish skipped: {exc}"})
        return
    session.meta["project"] = projects.project_info(root)
    session.meta["github"] = spec
    session.save_meta()
    manager._record(session, {"t": "system", "ts": time.time(), "text": f"published to https://github.com/{spec} (private)"})
    manager.broadcast_sessions()


def _begin_restart(manager: Manager, *, apply: bool = False, force: bool = False) -> dict:
    """Hand off to the detached updater helper and stop. The helper waits for
    this process to exit, installs (apply) and starts a fresh daemon, then
    health-checks it and rolls back if that fails."""
    busy = manager.busy_names()
    if busy and not force:
        raise RequestError(f"{len(busy)} session(s) are working ({', '.join(busy[:3])}); "
                           "they would be interrupted - wait, or choose update now")
    st = updater.status_summary()
    if apply and st.get("failed") and not force:
        raise RequestError(f"{st.get('latest')} failed its health check earlier ({st['failed']}); use update now / --force to retry it")
    try:
        if apply:
            if st.get("dev"):
                updater.spawn_helper("apply", previous=__version__)          # git pull --ff-only
                target = st.get("latest") or "latest"
            else:
                if not st.get("ready"):
                    raise RequestError("no verified update has been downloaded yet")
                updater.spawn_helper("apply", tarball=updater.load_state().get("ready"), expect=st["latest"], previous=__version__)
                target = st["latest"]
        else:
            updater.spawn_helper("restart")
            target = st.get("installed")
    except updater.UpdateError as exc:
        raise RequestError(str(exc))
    manager.restarting = True
    log.info("restarting kcoderd (%s -> %s)", "apply" if apply else "restart", target)
    manager.broadcast_sessions()
    manager.loop.call_later(0.5, manager.stop.set)
    return {"restarting": True, "version": target, "apply": apply}


# every static response: never framed, never sniffed, never shared cross-origin
_SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-cache"),
]


def _response(status: int, reason: str, body: bytes, ctype: str = "text/plain; charset=utf-8") -> Response:
    return Response(status, reason, Headers([("Content-Type", ctype), ("Content-Length", str(len(body)))] + _SECURITY_HEADERS), body)


def _serve_static(request):
    path = request.path.split("?", 1)[0]
    if path in ("/", ""):
        path = "/index.html"
    if path == "/health":
        return _response(200, "OK", b"ok\n")
    rel = os.path.normpath(path.lstrip("/"))
    if rel.startswith("..") or os.path.isabs(rel):
        return _response(404, "Not Found", b"not found\n")
    full = os.path.join(WEB_DIR, rel)
    if not os.path.isfile(full):
        return _response(404, "Not Found", b"not found\n")
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    with open(full, "rb") as f:
        body = f.read()
    return _response(200, "OK", body, ctype)


def allowed_hosts(port: int) -> set:
    return {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}


def allowed_origins(port: int) -> set:
    return {f"http://{h}" for h in allowed_hosts(port)}


def _make_process_request(port: int):
    """The loopback listener. Anything on this machine can open a TCP
    connection to it, so every request must look like it came from our own
    page: a loopback Host (no DNS rebinding) and, for browsers, our own
    Origin. Non-browser clients send no Origin and prove themselves with the
    token in their first frame."""
    hosts = allowed_hosts(port)
    origins = allowed_origins(port)

    def process_request(connection, request):
        host = request.headers.get("Host", "")
        if host not in hosts:
            log.warning("refused request with Host %r", host[:80])
            return _response(403, "Forbidden", b"forbidden\n")
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return _serve_static(request)
        origin = request.headers.get("Origin")
        if origin is not None and origin not in origins:
            log.warning("refused websocket from Origin %r", origin[:80])
            return _response(403, "Forbidden", b"forbidden\n")
        return None
    return process_request


def _unix_process_request(connection, request):
    # the socket file is user-only; still, only websocket upgrades are served here
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return _response(404, "Not Found", b"websocket only\n")
    return None


async def _client_sender(client: Client) -> None:
    while True:
        frame = await client.queue.get()
        await client.ws.send(frame)


async def _handle(ws, manager: Manager, token: str) -> None:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        hello = json.loads(raw)
        if hello.get("type") != "auth" or not secrets.compare_digest(str(hello.get("token", "")), token):
            await asyncio.sleep(0.5)   # no fast guessing
            await ws.send(json.dumps({"type": "reply", "id": hello.get("id"), "ok": False, "error": "unauthorized"}))
            await ws.close(4401, "unauthorized")
            return
    except Exception:  # noqa: BLE001
        await ws.close(4400, "expected auth frame")
        return

    client = Client(ws)
    manager.clients.add(client)
    sender = asyncio.create_task(_client_sender(client))
    await ws.send(json.dumps({"type": "reply", "id": hello.get("id"), "ok": True, "version": __version__,
                              "installed": updater.installed_version(), "dev": updater.is_dev_install()}))
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
            s.sendall(f"GET /health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n".encode())
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
    manager.start_backfill()

    stop = manager.stop
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (RuntimeError, NotImplementedError):
            pass  # not the main thread (embedded/tests) or Windows

    origins = [None] + sorted(allowed_origins(port))
    sock_path = paths.SOCKET_PATH
    try:
        os.remove(sock_path)
    except FileNotFoundError:
        pass
    old_umask = os.umask(0o177)   # the socket is created user-only
    try:
        unix_server = await unix_serve(
            lambda ws: _handle(ws, manager, token), path=sock_path,
            process_request=_unix_process_request, max_size=64 * 1024 * 1024, server_header=None,
        ).__aenter__()
    finally:
        os.umask(old_umask)
    try:
        os.chmod(sock_path, 0o600)
    except OSError:
        pass
    async with serve(
        lambda ws: _handle(ws, manager, token),
        host, port,
        origins=origins,
        process_request=_make_process_request(port),
        max_size=64 * 1024 * 1024,
        server_header=None,
    ) as server:
        info = {"host": host, "port": port, "pid": os.getpid(), "started": time.time(), "version": __version__,
                "socket": sock_path}
        _atomic_write(paths.DAEMON_INFO_PATH, json.dumps(info))
        os.chmod(paths.DAEMON_INFO_PATH, 0o600)
        log.info("kcoderd %s listening on ws://%s:%d/ws and %s (pid %d)", __version__, host, port, sock_path, os.getpid())
        updates = asyncio.create_task(_update_loop(manager))
        await stop.wait()
        log.info("shutting down")
        updates.cancel()
        manager.shutdown()
        server.close()
        unix_server.close()
    for p in (paths.DAEMON_INFO_PATH, sock_path):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


async def _update_loop(manager: Manager) -> None:
    """Check for releases on start and daily; download + verify in the
    background; install when everything is idle (config auto_update)."""
    loop = asyncio.get_running_loop()
    await asyncio.sleep(float(os.environ.get("KCODER_UPDATE_DELAY", "20")))
    while not manager.stop.is_set():
        delay = updater.CHECK_INTERVAL
        try:
            before = updater.status_summary()
            summary = await loop.run_in_executor(None, updater.check_and_download)
            if summary != before:
                manager._upd_at = 0
                manager.broadcast_sessions()
            if summary.get("ready") and not summary.get("dev") and not summary.get("failed"):
                if manager.cfg.get("auto_update", True) and manager.all_idle() and manager.clients_idle():
                    log.info("update %s is verified and everything is idle: installing", summary.get("latest"))
                    _begin_restart(manager, apply=True)
                    return
                delay = 600   # waiting for an idle moment
        except Exception as exc:  # noqa: BLE001
            log.warning("update check failed: %s", exc)
        try:
            await asyncio.wait_for(manager.stop.wait(), timeout=delay)
            return
        except asyncio.TimeoutError:
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
