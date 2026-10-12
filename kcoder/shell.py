"""Interactive shell per session: a pty running the user's shell in the
session's working directory, streamed to the browser (xterm.js) as
{"type": "shell", "sid": ..., "data": <base64>} frames."""

from __future__ import annotations

import base64
import collections
import json
import os
import signal
import struct
import threading
import time

if os.name != "nt":
    import fcntl
    import pty
    import termios

SCROLLBACK_BYTES = 200_000


class _ShellBase:
    """Scrollback and broadcasting shared by the POSIX pty and Windows ConPTY shells."""

    def _on_data(self, data: bytes) -> None:
        if not data:
            self._exited()
            return
        self.buffer.append(data)
        self.buffer_len += len(data)
        while self.buffer_len > SCROLLBACK_BYTES and len(self.buffer) > 1:
            self.buffer_len -= len(self.buffer.popleft())
        self.manager.broadcast_raw(json.dumps({
            "type": "shell", "sid": self.session.id, "data": base64.b64encode(data).decode(),
        }), sid=self.session.id)

    def _broadcast_exit(self) -> None:
        self.manager.broadcast_raw(json.dumps({"type": "shell", "sid": self.session.id, "data": "", "exit": self.exit_code}),
                                   sid=self.session.id)
        if self.session.shell is self:
            self.session.shell = None
        self.manager.broadcast_sessions()

    def scrollback(self) -> str:
        return base64.b64encode(b"".join(self.buffer)).decode()

    def detach(self) -> None:
        self.owner = None


class WindowsShell(_ShellBase):
    """PowerShell in a ConPTY (pywinpty), read on a thread: the Windows event
    loop has no add_reader for pipes."""

    def __init__(self, manager, session, cols: int, rows: int, owner):
        try:
            from winpty import PtyProcess  # type: ignore
        except ImportError:
            raise RuntimeError("the terminal view needs pywinpty on Windows: pip install pywinpty")
        self.manager = manager
        self.session = session
        self.owner = owner
        self.buffer: collections.deque = collections.deque()
        self.buffer_len = 0
        self.exit_code = None
        self._closed = False
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", KCODER_SESSION=session.id)
        env.pop("KCODER_DATA_DIR", None)
        shell = "pwsh.exe" if _which("pwsh.exe") else "powershell.exe"
        self.proc = PtyProcess.spawn([shell, "-NoLogo"], cwd=session.engine.cwd, env=env,
                                     dimensions=(max(2, int(rows)), max(2, int(cols))))
        self.pid = self.proc.pid
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        loop = self.manager.loop
        while True:
            try:
                text = self.proc.read(65536)
            except EOFError:
                text = ""
            except Exception:  # noqa: BLE001
                text = ""
            data = text.encode("utf-8", "replace") if isinstance(text, str) else (text or b"")
            if self._closed:
                return
            loop.call_soon_threadsafe(self._on_data, data)
            if not data and not self.proc.isalive():
                return
            if not data:
                time.sleep(0.05)

    def _exited(self) -> None:
        if self._closed:
            return
        if self.proc.isalive():
            return   # an empty read while still running; keep going
        self._closed = True
        self.exit_code = self.proc.exitstatus or 0
        self._broadcast_exit()

    def write(self, data: bytes) -> None:
        try:
            self.proc.write(data.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            pass

    def resize(self, cols: int, rows: int) -> None:
        try:
            self.proc.setwinsize(max(2, int(rows)), max(2, int(cols)))
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        self._closed = True
        try:
            self.proc.terminate(force=True)
        except Exception:  # noqa: BLE001
            pass
        if self.session.shell is self:
            self.session.shell = None


def _which(name: str) -> str | None:
    import shutil
    return shutil.which(name)


def make_shell(manager, session, cols: int, rows: int, owner):
    return (WindowsShell if os.name == "nt" else Shell)(manager, session, cols, rows, owner)


class Shell(_ShellBase):
    def __init__(self, manager, session, cols: int, rows: int, owner):
        self.manager = manager
        self.session = session
        self.owner = owner
        self.buffer: collections.deque = collections.deque()
        self.buffer_len = 0
        self.exit_code = None
        shell = os.environ.get("SHELL") or "/bin/zsh"
        if not os.path.exists(shell):
            shell = "/bin/sh"
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(session.engine.cwd)
            except OSError:
                pass
            env = dict(os.environ)
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            env["KCODER_SESSION"] = session.id
            env.pop("KCODER_DATA_DIR", None)
            try:
                os.execvpe(shell, [shell, "-l"], env)
            finally:
                os._exit(1)
        self.pid = pid
        self.fd = fd
        self.resize(cols, rows)
        manager.loop.add_reader(fd, self._on_readable)

    def _on_readable(self) -> None:
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        self._on_data(data)

    def _exited(self) -> None:
        try:
            self.manager.loop.remove_reader(self.fd)
        except Exception:  # noqa: BLE001
            pass
        try:
            _, status = os.waitpid(self.pid, os.WNOHANG)
            self.exit_code = os.waitstatus_to_exitcode(status) if status else 0
        except ChildProcessError:
            self.exit_code = 0
        try:
            os.close(self.fd)
        except OSError:
            pass
        self._broadcast_exit()

    def write(self, data: bytes) -> None:
        try:
            os.write(self.fd, data)
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, int(rows)), max(2, int(cols)), 0, 0))
        except OSError:
            pass

    def close(self) -> None:
        try:
            self.manager.loop.remove_reader(self.fd)
        except Exception:  # noqa: BLE001
            pass
        try:
            os.kill(self.pid, signal.SIGHUP)
            time.sleep(0.05)
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        if self.session.shell is self:
            self.session.shell = None


def handle_request(manager, session, t: str, req: dict) -> dict:
    from .errors import RequestError

    if t == "shell_open":
        cols, rows = int(req.get("cols") or 100), int(req.get("rows") or 30)
        if session.shell is None:
            session.shell = make_shell(manager, session, cols, rows, req.get("_client"))
            manager.broadcast_sessions()
            return {"opened": True}
        session.shell.resize(cols, rows)
        # replay scrollback to the (re)attaching client
        manager.broadcast_raw(json.dumps({"type": "shell", "sid": session.id, "data": session.shell.scrollback()}),
                              sid=session.id)
        return {"opened": False}
    if session.shell is None:
        if t == "shell_kill_tool":
            killed = session.engine.kill_tool()
            return {"killed": killed}
        if t == "shell_close":
            return {}
        raise RequestError("no shell open for this session")
    if t == "shell_input":
        session.shell.write(base64.b64decode(req.get("data") or ""))
        return {}
    if t == "shell_resize":
        session.shell.resize(int(req.get("cols") or 100), int(req.get("rows") or 30))
        return {}
    if t == "shell_close":
        session.shell.close()
        manager.broadcast_sessions()
        return {}
    if t == "shell_kill_tool":
        return {"killed": session.engine.kill_tool()}
    raise RequestError(f"unknown request type: {t}")
