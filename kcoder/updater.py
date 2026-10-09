"""Updates for a private, single-user checkout: git, not releases.

kcoder runs from a git checkout (pip install -e). On launch and once a day
the daemon fetches the upstream branch and counts new commits. The app
offers them; when accepted, a detached helper (python -m kcoder.updater
apply) waits for the daemon to exit, runs `git pull --ff-only`, reinstalls
when pyproject.toml changed, rebuilds kcoder.app when its files changed,
checks that the new code imports, starts a fresh daemon and health-checks
it. If any of that fails it resets the checkout to the previous commit and
starts the daemon on the old code.

Nothing is signed or notarized: the source of truth is your own GitHub repo
over your own git credentials.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

from . import __version__, paths

STATE_PATH = os.path.join(paths.UPDATES_DIR, "state.json")
LOCK_PATH = os.path.join(paths.UPDATES_DIR, "helper.lock")
CHECK_INTERVAL = 24 * 3600
HEALTH_TIMEOUT = 45.0
REBUILD_APP_PATHS = ("kcoder/app.py", "kcoder/web/icon", "kcoder/web/menubar")


class UpdateError(Exception):
    pass


# ----------------------------------------------------------------------
# the checkout
# ----------------------------------------------------------------------

def package_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def checkout_root() -> str | None:
    """The git checkout kcoder runs from (KCODER_CHECKOUT overrides, for tests)."""
    root = os.environ.get("KCODER_CHECKOUT") or os.path.dirname(package_dir())
    return root if os.path.exists(os.path.join(root, ".git")) else None


def is_dev_install() -> bool:
    return checkout_root() is not None


def installed_version() -> str:
    """The version on disk (differs from __version__ after a pull until the daemon restarts)."""
    try:
        with open(os.path.join(package_dir(), "__init__.py"), "r", encoding="utf-8") as f:
            m = re.search(r'__version__\s*=\s*"([^"]+)"', f.read())
        return m.group(1) if m else __version__
    except OSError:
        return __version__


def _git(root: str, *args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=timeout)


def _out(root: str, *args: str) -> str:
    r = _git(root, *args)
    if r.returncode != 0:
        raise UpdateError(f"git {args[0]}: " + (r.stderr or r.stdout).strip()[-400:])
    return r.stdout.strip()


def head(root: str | None = None) -> str | None:
    root = root or checkout_root()
    if not root:
        return None
    r = _git(root, "rev-parse", "HEAD")
    return r.stdout.strip() if r.returncode == 0 else None


# ----------------------------------------------------------------------
# state
# ----------------------------------------------------------------------

def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(paths.UPDATES_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def _update(**fields) -> dict:
    state = load_state()
    state.update(fields)
    save_state(state)
    return state


def status_summary() -> dict:
    s = load_state()
    here = head()
    behind = int(s.get("behind") or 0) if s.get("head") == here else 0   # stale after a manual pull
    last = s.get("last_result") or {}
    # the upstream commit a rolled-back apply tried, while upstream still points at it
    failed = last if behind and not last.get("ok") and last.get("tried") and last.get("tried") == s.get("upstream_head") else None
    return {
        "running": __version__,
        "installed": installed_version(),
        "dev": is_dev_install(),
        "upstream": s.get("upstream"),
        "behind": behind,
        "ahead": int(s.get("ahead") or 0),
        "commits": (s.get("commits") or [])[:20] if behind else [],
        "available": behind > 0,
        "dirty": bool(s.get("dirty")),
        "checked": s.get("checked"),
        "error": s.get("error"),
        "last_result": s.get("last_result"),
        "failed": failed,
    }


# ----------------------------------------------------------------------
# checking
# ----------------------------------------------------------------------

def check() -> dict:
    """Fetch the upstream branch and count new commits. Never raises; returns status_summary()."""
    root = checkout_root()
    if not root:
        _update(checked=time.time(), error="kcoder is not running from a git checkout", behind=0)
        return status_summary()
    try:
        upstream = _git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").stdout.strip() or "origin/main"
        remote = upstream.split("/", 1)[0]
        r = _git(root, "fetch", "--quiet", remote, timeout=120)
        if r.returncode != 0:
            raise UpdateError("git fetch: " + (r.stderr or r.stdout).strip()[-300:])
        behind = int(_out(root, "rev-list", "--count", f"HEAD..{upstream}") or 0)
        ahead = int(_out(root, "rev-list", "--count", f"{upstream}..HEAD") or 0)
        commits = _out(root, "log", "--format=%h %s", "-n", "20", f"HEAD..{upstream}").splitlines() if behind else []
        dirty = bool(_out(root, "status", "--porcelain", "--untracked-files=no"))
        _update(checked=time.time(), error=None, upstream=upstream, behind=behind, ahead=ahead,
                commits=commits, dirty=dirty, head=head(root), upstream_head=_out(root, "rev-parse", upstream))
    except (UpdateError, subprocess.TimeoutExpired, ValueError) as exc:
        _update(checked=time.time(), error=str(exc)[:300])
    return status_summary()


def can_apply() -> str | None:
    """None when an update can be applied, else the reason it can't."""
    st = status_summary()
    if not st["dev"]:
        return "kcoder is not running from a git checkout"
    if not st["available"]:
        return "already up to date"
    if st["dirty"]:
        return "the kcoder checkout has uncommitted changes; commit or stash them first"
    if st["ahead"]:
        return f"the kcoder checkout has {st['ahead']} local commit(s) not on {st['upstream']}; push or rebase first"
    return None


# ----------------------------------------------------------------------
# the detached helper
# ----------------------------------------------------------------------

def _try_lock():
    """Only one helper (pull / restart / rollback) at a time. The open lock file, or None."""
    import fcntl
    os.makedirs(paths.UPDATES_DIR, exist_ok=True)
    f = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    f.seek(0); f.truncate(); f.write(str(os.getpid())); f.flush()
    return f


def helper_running() -> bool:
    lock = _try_lock()
    if lock is None:
        return True
    lock.close()
    return False


def spawn_helper(action: str, *, previous: str | None = None, wait_pid: int | None = None) -> None:
    """Start `python -m kcoder.updater <action>` detached from the daemon."""
    paths.ensure_data_dir()
    if helper_running():
        raise UpdateError("an update or restart is already in progress")
    args = [sys.executable, "-P", "-m", "kcoder.updater", action, "--wait-pid", str(wait_pid or os.getpid())]
    if previous:
        args += ["--previous", previous]
    log = open(paths.UPDATE_LOG_PATH, "a")
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     start_new_session=True, close_fds=True, cwd=os.path.expanduser("~"))


def _log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _wait_for_exit(pid: int, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    nudged = False
    while _pid_alive(pid):
        if time.monotonic() > deadline:
            raise UpdateError(f"kcoderd (pid {pid}) did not exit")
        if not nudged and time.monotonic() > deadline - 30:
            _log(f"kcoderd {pid} still running; sending SIGTERM")
            try:
                os.kill(pid, 15)
            except OSError:
                pass
            nudged = True
        time.sleep(0.2)


def _isolated() -> bool:
    """A non-default data dir / port (tests): never touch launchd or the real app bundle."""
    return bool(os.environ.get("KCODER_DATA_DIR") or os.environ.get("KCODER_PORT"))


# After the pull the package on disk is new code. The helper must not import
# from it lazily (a broken commit would break the helper and its rollback),
# so what it needs is imported up front and health checks are self-contained.

def _daemon_info() -> dict | None:
    try:
        with open(paths.DAEMON_INFO_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _running_daemon() -> dict | None:
    import socket
    info = _daemon_info()
    if not info or not _pid_alive(int(info.get("pid", 0))):
        return None
    try:
        with socket.create_connection((info["host"], info["port"]), timeout=0.5) as s:
            s.sendall(f"GET /health HTTP/1.1\r\nHost: {info['host']}:{info['port']}\r\nConnection: close\r\n\r\n".encode())
            s.settimeout(1.0)
            ok = s.recv(256).startswith(b"HTTP/1.1 200")
    except OSError:
        return None
    return info if ok else None


_preloaded: dict = {}


def _preload() -> None:
    from . import app as appmod
    from . import client
    _preloaded["app"] = appmod
    _preloaded["client"] = client


def _start_daemon() -> None:
    appmod, client = _preloaded["app"], _preloaded["client"]
    if sys.platform == "darwin" and appmod.agent_installed() and not _isolated():
        try:
            appmod.agent_start()
            return
        except RuntimeError as exc:
            _log(f"launchctl start failed ({exc}); starting kcoderd directly")
    client.spawn_daemon()


def _health(timeout: float = HEALTH_TIMEOUT) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = _running_daemon()
        if info:
            return info.get("version") or ""
        time.sleep(0.3)
    raise UpdateError("kcoderd did not answer its health check")


def _changed(root: str, old: str, new: str) -> list:
    r = _git(root, "diff", "--name-only", old, new)
    return r.stdout.split() if r.returncode == 0 else []


def _rebuild(root: str, changed: list) -> None:
    """Reinstall / rebuild what the new commits need, then prove the code imports."""
    if "pyproject.toml" in changed:
        cmd = [sys.executable, "-m", "pip", "install", "--quiet", "-e", root]
        _log("$ " + " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise UpdateError("pip install -e failed: " + (r.stderr or r.stdout).strip()[-600:])
    r = subprocess.run([sys.executable, "-P", "-c", "import kcoder.daemon, kcoder.cli, kcoder.app"],
                       capture_output=True, text=True, timeout=120, cwd=os.path.expanduser("~"),
                       env=dict(os.environ, PYTHONPATH=root))
    if r.returncode != 0:
        raise UpdateError("the new code does not import: " + (r.stderr or r.stdout).strip()[-600:])
    appmod = _preloaded["app"]
    if any(c.startswith(REBUILD_APP_PATHS) for c in changed) and appmod.mac_app_installed() and not _isolated():
        _log("rebuilding kcoder.app")
        r = subprocess.run([sys.executable, "-P", "-m", "kcoder.cli", "app", "--install"],
                           capture_output=True, text=True, timeout=600, cwd=os.path.expanduser("~"))
        if r.returncode != 0:
            _log("kcoder.app rebuild failed (the daemon is fine): " + (r.stderr or r.stdout).strip()[-300:])


def helper_main(argv: list) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="python -m kcoder.updater")
    p.add_argument("action", choices=["restart", "apply"])
    p.add_argument("--previous", help="the commit to roll back to")
    p.add_argument("--wait-pid", type=int)
    a = p.parse_args(argv)
    lock = _try_lock()
    if lock is None:
        _log(f"helper: another helper is running; not starting {a.action}")
        return 2
    _log(f"helper: {a.action} previous={a.previous} wait_pid={a.wait_pid}")
    _preload()
    root = checkout_root()
    old = a.previous or head(root)
    try:
        if a.wait_pid:
            _wait_for_exit(a.wait_pid)
        if a.action == "apply":
            if not root:
                raise UpdateError("kcoder is not running from a git checkout")
            r = _git(root, "pull", "--ff-only", "--quiet", timeout=300)
            if r.returncode != 0:
                raise UpdateError("git pull --ff-only: " + (r.stderr or r.stdout).strip()[-500:])
            new = head(root)
            changed = _changed(root, old, new) if old and new else []
            _log(f"pulled {old[:7] if old else '?'}..{new[:7] if new else '?'} ({len(changed)} file(s))")
            _rebuild(root, changed)
        _start_daemon()
        ver = _health()
        _log(f"kcoderd {ver} is healthy at {(head(root) or '?')[:7]}")
        _update(last_result={"ok": True, "action": a.action, "head": head(root), "version": ver, "ts": time.time()},
                error=None, behind=0, commits=[], head=head(root))
        return 0
    except Exception as exc:  # noqa: BLE001
        _log(f"FAILED: {exc}")
        result = {"ok": False, "action": a.action, "error": str(exc)[:500], "ts": time.time()}
        if a.action == "apply" and root and old and head(root) != old:
            _log(f"rolling back to {old[:7]}")
            try:
                info = _running_daemon()
                if info:
                    os.kill(int(info["pid"]), 15)
                    _wait_for_exit(int(info["pid"]), 30)
                new = head(root)
                result["tried"] = new
                _out(root, "reset", "--hard", "--quiet", old)
                if "pyproject.toml" in _changed(root, old, new or old):
                    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "-e", root], capture_output=True, timeout=900)
                result["rolled_back"] = old
            except Exception as exc2:  # noqa: BLE001
                _log(f"rollback failed: {exc2}")
                result["rollback_error"] = str(exc2)[:300]
        try:
            if not _running_daemon():
                _start_daemon()
                ver = _health()
                _log(f"kcoderd {ver} restarted on {(head(root) or '?')[:7]}")
        except Exception as exc3:  # noqa: BLE001
            _log(f"could not restart kcoderd: {exc3}")
        _update(last_result=result, error=str(exc)[:300], head=head(root))
        return 1


if __name__ == "__main__":
    sys.exit(helper_main(sys.argv[1:]))
