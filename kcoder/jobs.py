"""Background jobs: long-running commands a session starts and gets back to.

A shell tool call is killed after ten minutes. Builds, test suites, installs
and deploys can outlive that, so an agent runs them as `kcoder job run --
<command>` instead. The daemon starts the command in the session's folder,
streams its output to the pane (with a stop button), and either returns the
result to the waiting `kcoder job` call or, when the agent has moved on,
sends the session a message with the result when the job ends.

Jobs live on the Session (`session.jobs`), their logs under
<session dir>/jobs/<id>.log, and a persisted `job` event marks each start
and end so the transcript shows them.
"""

from __future__ import annotations

import collections
import json
import os
import subprocess
import threading
import time

from . import compat

TAIL_BYTES = 64_000
KEEP_JOBS = 20


class Job:
    def __init__(self, manager, session, jid: int, cmd: str, name: str, cwd: str, env: dict):
        self.manager = manager
        self.session = session
        self.id = jid
        self.cmd = cmd
        self.name = name or cmd[:60]
        self.cwd = cwd
        self.env = env
        self.started = time.time()
        self.ended: float | None = None
        self.exit: int | None = None
        self.status = "running"
        self.pid: int | None = None
        self.proc = None
        self.tail: collections.deque = collections.deque()
        self.tail_len = 0
        self.waiters: list = []            # asyncio futures from job_wait
        self.notify = False                # a waiter gave up: message the session when it ends
        os.makedirs(os.path.join(session.dir, "jobs"), exist_ok=True)
        self.log_path = os.path.join(session.dir, "jobs", f"{jid}.log")

    def start(self) -> None:
        log = open(self.log_path, "ab")
        log.write(f"$ {self.cmd}\n".encode())
        log.flush()
        self.proc = subprocess.Popen(self.cmd, shell=True, cwd=self.cwd, env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **compat.own_group())
        self.pid = self.proc.pid
        threading.Thread(target=self._pump, args=(log,), daemon=True).start()

    def _pump(self, log) -> None:
        out = self.proc.stdout
        try:
            while True:
                chunk = out.read1(65536) if hasattr(out, "read1") else out.read(65536)
                if not chunk:
                    break
                log.write(chunk)
                log.flush()
                self.tail.append(chunk)
                self.tail_len += len(chunk)
                while self.tail_len > TAIL_BYTES and len(self.tail) > 1:
                    self.tail_len -= len(self.tail.popleft())
                self.manager.loop.call_soon_threadsafe(self.manager._record, self.session,
                                                       {"t": "job_output", "ts": time.time(), "id": self.id, "delta": chunk.decode("utf-8", "replace")[-8000:]})
        except (OSError, ValueError):
            pass
        code = self.proc.wait()
        log.close()
        self.manager.loop.call_soon_threadsafe(self._finished, code)

    def _finished(self, code: int) -> None:
        self.ended = time.time()
        self.exit = code
        self.status = "stopped" if self.status == "stopping" else ("done" if code == 0 else "failed")
        self.manager.on_job_end(self.session, self)

    def stop(self) -> None:
        if self.status != "running" or not self.pid:
            return
        self.status = "stopping"
        compat.kill_tree(self.pid)
        pid = self.pid

        def later():
            time.sleep(5)
            if compat.pid_alive(pid):
                compat.kill_tree(pid, force=True)
        threading.Thread(target=later, daemon=True).start()

    def tail_text(self, lines: int = 60) -> str:
        text = b"".join(self.tail).decode("utf-8", "replace")
        return "\n".join(text.splitlines()[-max(1, lines):])

    def info(self) -> dict:
        now = time.time()
        return {"id": self.id, "name": self.name, "cmd": self.cmd, "status": self.status, "exit": self.exit, "pid": self.pid,
                "started": self.started, "ended": self.ended, "seconds": round((self.ended or now) - self.started, 1),
                "log": self.log_path}


def jobs_info(session) -> list:
    jobs = getattr(session, "jobs", None) or {}
    return [j.info() for j in sorted(jobs.values(), key=lambda j: j.id)][-KEEP_JOBS:]


def mark_lost(meta: dict) -> None:
    """After a daemon restart the processes of running jobs are gone (or orphans
    we cannot see): mark them in the saved list so the UI does not show them live."""
    for j in meta.get("jobs") or []:
        if j.get("status") in ("running", "stopping"):
            j["status"] = "lost"
            j["ended"] = j.get("ended") or time.time()
