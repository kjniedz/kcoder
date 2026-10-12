"""Process and file helpers that work on macOS, Linux and Windows.

POSIX has process groups and signals; Windows has neither, and on Windows
`os.kill(pid, 0)` does not test a pid, it terminates the process. Everything
that starts, checks or stops a background process goes through here.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys

WINDOWS = sys.platform == "win32"

# Windows process creation flags (subprocess exposes them only on Windows)
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000


def detached() -> dict:
    """Popen kwargs for a background process that outlives this one and its
    terminal: a new session on POSIX, a detached windowless process on Windows."""
    if WINDOWS:
        return {"creationflags": _DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW}
    return {"start_new_session": True}


def own_group() -> dict:
    """Popen kwargs for a child (and its children) that can be stopped as one
    unit with kill_tree(), without detaching it from the console."""
    if WINDOWS:
        return {"creationflags": _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW}
    return {"start_new_session": True}


def pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    if WINDOWS:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        handle = kernel32.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5                    # access denied: it exists
        try:
            code = wintypes.DWORD()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == 259                  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def kill_tree(pid: int, force: bool = False) -> None:
    """Stop a process and everything it started. POSIX: SIGTERM (or SIGKILL)
    to its process group, falling back to the pid. Windows: taskkill /T."""
    if not pid:
        return
    if WINDOWS:
        args = ["taskkill", "/PID", str(int(pid)), "/T"] + (["/F"] if force else [])
        try:
            subprocess.run(args, capture_output=True, timeout=15, creationflags=_CREATE_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if force or not pid_alive(pid):
            return
        try:   # console apps ignore a polite taskkill; finish the job
            subprocess.run(args + ["/F"], capture_output=True, timeout=15, creationflags=_CREATE_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, sig)
        except OSError:
            pass


def terminate(pid: int) -> None:
    """Ask one process to exit (SIGTERM; on Windows, end it)."""
    if WINDOWS:
        kill_tree(pid, force=True)
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def try_lock(f) -> bool:
    """Non-blocking exclusive lock on an open file (released when it is closed)."""
    if WINDOWS:
        import msvcrt
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def hostname() -> str:
    import platform
    return platform.node() or "this computer"


def machine() -> str:
    import platform
    return (platform.machine() or "").lower()
