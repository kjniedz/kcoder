"""Auto-update: check GitHub Releases, download + verify in the background,
install when every session is idle (or on "update now"), restart kcoderd,
and roll back when the new version fails its health check.

Trust model: a release is a tarball plus SHA256SUMS plus SHA256SUMS.sig.
The signature is an OpenSSH signature (ssh-keygen -Y) made with the kcoder
release key; its public half is embedded below. Nothing is installed
unless the signature verifies and the tarball's sha256 matches.

Two kinds of install are handled:

* a normal pip install: the verified tarball is pip-installed over it
* a developer checkout (the package lives inside a git repo): nothing is
  pip-installed; "update" means `git pull --ff-only` in that checkout

The daemon never upgrades itself in-process. It spawns this module as a
detached helper (`python -m kcoder.updater apply|restart ...`), replies to
the client, and exits. The helper waits for it to be gone, installs, starts
a fresh daemon, checks its health, and rolls back if that fails.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from . import __version__, paths

REPO = os.environ.get("KCODER_UPDATE_REPO", "kjniedz/kcoder")
API = "https://api.github.com"
SIGN_NAMESPACE = "kcoder-release"
RELEASE_PUBKEY = os.environ.get(
    "KCODER_RELEASE_PUBKEY",   # test override only; the default is the real release key
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMN7G9fstGha1AyCuFp+buDqAZMjZPeapKp9bZiUuIA6",
)
STATE_PATH = os.path.join(paths.UPDATES_DIR, "state.json")
LOCK_PATH = os.path.join(paths.UPDATES_DIR, "helper.lock")
CHECK_INTERVAL = 24 * 3600
HEALTH_TIMEOUT = 45.0


class UpdateError(Exception):
    pass


# ----------------------------------------------------------------------
# what is installed
# ----------------------------------------------------------------------

def package_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def checkout_root() -> str | None:
    """The git checkout this package is imported from, if it is one."""
    root = os.path.dirname(package_dir())
    return root if os.path.isdir(os.path.join(root, ".git")) else None


def is_dev_install() -> bool:
    return checkout_root() is not None


def installed_version() -> str:
    """The version on disk (differs from __version__ after an upgrade until
    the daemon restarts)."""
    try:
        with open(os.path.join(package_dir(), "__init__.py"), "r", encoding="utf-8") as f:
            m = re.search(r'__version__\s*=\s*"([^"]+)"', f.read())
        return m.group(1) if m else __version__
    except OSError:
        return __version__


def _vtuple(v: str) -> tuple:
    parts = []
    for p in re.split(r"[.\-+]", str(v or "0")):
        parts.append(int(p) if p.isdigit() else -1)
    return tuple(parts)


def newer(a: str, b: str) -> bool:
    """True if version a is newer than b."""
    return _vtuple(a) > _vtuple(b)


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
    """The few fields the UI shows."""
    s = load_state()
    latest = s.get("latest")
    available = bool(latest and newer(latest, __version__))
    failed = (s.get("failed") or {}).get(latest or "")
    return {
        "running": __version__,
        "installed": installed_version(),
        "dev": is_dev_install(),
        "latest": latest,
        "available": available,
        "ready": bool(available and s.get("ready") and s.get("ready_version") == latest and os.path.isfile(s.get("ready") or "")),
        # a version that failed its health check once is never installed
        # automatically again; "update now" can still force it
        "failed": failed,
        "checked": s.get("checked"),
        "error": s.get("error"),
        "notes": (s.get("notes") or "")[:2000],
        "url": s.get("url"),
        "last_result": s.get("last_result"),
    }


# ----------------------------------------------------------------------
# GitHub
# ----------------------------------------------------------------------

_token_cache: dict = {}


def _token() -> str | None:
    if "t" in _token_cache:
        return _token_cache["t"]
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not tok and shutil.which("gh"):
        try:
            out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
            tok = out.stdout.strip() if out.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            tok = None
    _token_cache["t"] = tok or None
    return _token_cache["t"]


def _get(url: str, accept: str = "application/vnd.github+json", timeout: int = 60) -> bytes:
    if url.startswith("file://") or os.path.isabs(url):
        path = url[7:] if url.startswith("file://") else url
        with open(path, "rb") as f:
            return f.read()
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": f"kcoder/{__version__}"})
    tok = _token()
    if tok and "github" in url:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as exc:
        raise UpdateError(f"HTTP {exc.code} fetching {url.split('?')[0]}")
    except (urllib.error.URLError, OSError) as exc:
        raise UpdateError(f"could not reach {url.split('/')[2] if '//' in url else url}: {exc}")


def latest_release() -> dict | None:
    """{"version", "tag", "url", "notes", "assets": {name: download_url}} or None."""
    src = os.environ.get("KCODER_UPDATE_URL")   # tests: a release.json on disk or any URL
    data = json.loads(_get(src or f"{API}/repos/{REPO}/releases/latest").decode("utf-8", "replace"))
    if not isinstance(data, dict) or not data.get("tag_name"):
        return None
    assets = {}
    for a in data.get("assets") or []:
        # the API url + Accept: application/octet-stream works for private repos too
        assets[a.get("name")] = a.get("url") or a.get("browser_download_url")
    return {
        "version": str(data["tag_name"]).lstrip("v"),
        "tag": data["tag_name"],
        "url": data.get("html_url"),
        "notes": data.get("body") or "",
        "assets": assets,
    }


def check() -> dict:
    """Look for a newer release. Never raises; errors land in state."""
    try:
        rel = latest_release()
    except (UpdateError, ValueError) as exc:
        return _update(checked=time.time(), error=str(exc))
    if not rel:
        return _update(checked=time.time(), error="no releases yet")
    return _update(checked=time.time(), error=None, latest=rel["version"], tag=rel["tag"],
                   url=rel["url"], notes=rel["notes"], assets=rel["assets"])


# ----------------------------------------------------------------------
# download + verify
# ----------------------------------------------------------------------

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_release_dir(d: str, tarball_name: str) -> None:
    """Raise UpdateError unless SHA256SUMS is signed by the release key and
    lists the tarball with its actual sha256."""
    sums = os.path.join(d, "SHA256SUMS")
    sig = os.path.join(d, "SHA256SUMS.sig")
    tar = os.path.join(d, tarball_name)
    for p in (sums, sig, tar):
        if not os.path.isfile(p):
            raise UpdateError(f"release is missing {os.path.basename(p)}")
    if not shutil.which("ssh-keygen"):
        raise UpdateError("ssh-keygen is not available to verify the release signature")
    with tempfile.NamedTemporaryFile("w", suffix=".allowed", delete=False) as f:
        f.write(f'kcoder namespaces="{SIGN_NAMESPACE}" {RELEASE_PUBKEY}\n')
        allowed = f.name
    try:
        with open(sums, "rb") as data:
            r = subprocess.run(["ssh-keygen", "-Y", "verify", "-f", allowed, "-I", "kcoder", "-n", SIGN_NAMESPACE, "-s", sig],
                               stdin=data, capture_output=True, text=True, timeout=30)
    finally:
        os.unlink(allowed)
    if r.returncode != 0:
        raise UpdateError("release signature did not verify: " + (r.stderr or r.stdout).strip()[-300:])
    expected = None
    with open(sums, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[-1].lstrip("*") == tarball_name:
                expected = parts[0].lower()
    if not expected:
        raise UpdateError(f"{tarball_name} is not listed in the signed SHA256SUMS")
    actual = _sha256(tar)
    if actual != expected:
        raise UpdateError(f"sha256 mismatch for {tarball_name}: expected {expected[:12]}…, got {actual[:12]}…")


def download(state: dict | None = None) -> dict:
    """Fetch and verify the latest release's assets. Returns the state."""
    state = state or load_state()
    ver = state.get("latest")
    assets = state.get("assets") or {}
    if not ver:
        raise UpdateError("no release known; check first")
    tarball_name = f"kcoder-{ver}.tar.gz"
    missing = [n for n in (tarball_name, "SHA256SUMS", "SHA256SUMS.sig") if n not in assets]
    if missing:
        raise UpdateError(f"release {ver} lacks {', '.join(missing)}; it was not made with `kcoder release`")
    d = os.path.join(paths.UPDATES_DIR, ver)
    os.makedirs(d, exist_ok=True)
    for name in (tarball_name, "SHA256SUMS", "SHA256SUMS.sig"):
        dest = os.path.join(d, name)
        if name == tarball_name and os.path.isfile(dest) and state.get("ready") == dest:
            continue
        data = _get(assets[name], accept="application/octet-stream", timeout=600)
        with open(dest + ".part", "wb") as f:
            f.write(data)
        os.replace(dest + ".part", dest)
    try:
        verify_release_dir(d, tarball_name)
    except UpdateError:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return _update(ready=os.path.join(d, tarball_name), ready_version=ver, verified=time.time(), error=None)


def check_and_download() -> dict:
    """The daily job. Returns status_summary()."""
    state = check()
    try:
        if state.get("latest") and newer(state["latest"], __version__) and not is_dev_install():
            if not (state.get("ready_version") == state["latest"] and os.path.isfile(state.get("ready") or "")):
                download(state)
    except UpdateError as exc:
        _update(error=str(exc))
    return status_summary()


def prune(keep: set) -> None:
    """Drop downloaded releases other than `keep` (versions)."""
    try:
        for name in os.listdir(paths.UPDATES_DIR):
            p = os.path.join(paths.UPDATES_DIR, name)
            if os.path.isdir(p) and name not in keep:
                shutil.rmtree(p, ignore_errors=True)
    except FileNotFoundError:
        pass


# ----------------------------------------------------------------------
# the detached helper
# ----------------------------------------------------------------------

def _try_lock():
    """Only one helper (install / restart / rollback) may run at a time.
    Returns the open lock file, or None when another helper holds it."""
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


def spawn_helper(action: str, *, tarball: str | None = None, expect: str | None = None,
                 previous: str | None = None, wait_pid: int | None = None) -> None:
    """Start `python -m kcoder.updater <action>` detached from the daemon."""
    paths.ensure_data_dir()
    if helper_running():
        raise UpdateError("an update or restart is already in progress")
    args = [sys.executable, "-P", "-m", "kcoder.updater", action]
    if tarball:
        args += ["--tarball", tarball]
    if expect:
        args += ["--expect", expect]
    if previous:
        args += ["--previous", previous]
    args += ["--wait-pid", str(wait_pid or os.getpid())]
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


def _pip_install(target: str) -> None:
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--upgrade", target]
    _log("$ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise UpdateError("pip install failed: " + (r.stderr or r.stdout).strip()[-800:])


def _git_pull(root: str) -> None:
    for args in (["fetch", "--quiet"], ["pull", "--ff-only", "--quiet"]):
        r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise UpdateError(f"git {args[0]} failed: " + (r.stderr or r.stdout).strip()[-500:])


def _isolated() -> bool:
    """Running against a non-default data dir / port (tests): never touch launchd."""
    return bool(os.environ.get("KCODER_DATA_DIR") or os.environ.get("KCODER_PORT"))


# The helper keeps running after pip has replaced the package on disk, so
# from here on it must not import anything lazily: a broken new release would
# break the helper and defeat the rollback. Everything it needs from the
# package is imported up front in helper_main(); health checking is
# self-contained.

def _daemon_info() -> dict | None:
    try:
        with open(paths.DAEMON_INFO_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _running_daemon() -> dict | None:
    """daemon.json if that pid is alive and answers /health (no package imports)."""
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
    """Import (old, working) package modules before the install replaces them."""
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


def _health(expect: str | None, timeout: float = HEALTH_TIMEOUT) -> str:
    """Wait for a daemon that answers /health; return its version. Raises on timeout / wrong version."""
    deadline = time.monotonic() + timeout
    seen = None
    while time.monotonic() < deadline:
        info = _running_daemon()
        if info:
            seen = info.get("version")
            if not expect or seen == expect:
                return seen or ""
        time.sleep(0.3)
    if seen:
        raise UpdateError(f"kcoderd came up as {seen}, expected {expect}")
    raise UpdateError("kcoderd did not answer its health check")


def _previous_target(previous: str | None) -> str | None:
    if not previous:
        return None
    local = os.path.join(paths.UPDATES_DIR, previous, f"kcoder-{previous}.tar.gz")
    if os.path.isfile(local):
        return local
    return f"kcoder @ https://github.com/{REPO}/archive/refs/tags/v{previous}.tar.gz"


def helper_main(argv: list) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="python -m kcoder.updater")
    p.add_argument("action", choices=["restart", "apply"])
    p.add_argument("--tarball")
    p.add_argument("--expect")
    p.add_argument("--previous")
    p.add_argument("--wait-pid", type=int)
    a = p.parse_args(argv)
    lock = _try_lock()
    if lock is None:
        _log(f"helper: another helper is running; not starting {a.action}")
        return 2
    _log(f"helper: {a.action} tarball={a.tarball} expect={a.expect} previous={a.previous} wait_pid={a.wait_pid}")
    _preload()
    try:
        if a.wait_pid:
            _wait_for_exit(a.wait_pid)
        if a.action == "apply":
            root = checkout_root()
            if root:
                _log(f"developer checkout at {root}: git pull --ff-only")
                _git_pull(root)
            elif a.tarball:
                _pip_install(a.tarball)
            else:
                raise UpdateError("apply needs --tarball for a pip install")
        _start_daemon()
        ver = _health(a.expect if a.action == "apply" else None)
        _log(f"kcoderd {ver} is healthy")
        _update(last_result={"ok": True, "version": ver, "ts": time.time(), "action": a.action}, error=None)
        if a.action == "apply" and a.expect:
            prune({a.expect, a.previous or ""})
        return 0
    except Exception as exc:  # noqa: BLE001
        _log(f"FAILED: {exc}")
        result = {"ok": False, "error": str(exc), "ts": time.time(), "action": a.action}
        if a.action == "apply" and a.expect:
            failed = dict(load_state().get("failed") or {})
            failed[a.expect] = str(exc)[:300]
            _update(failed=failed)
        if a.action == "apply" and not checkout_root():
            target = _previous_target(a.previous)
            if target:
                _log(f"rolling back to {a.previous}")
                try:
                    # kill a half-working new daemon before reinstalling
                    info = _running_daemon()
                    if info:
                        os.kill(int(info["pid"]), 15)
                        _wait_for_exit(int(info["pid"]), 30)
                    _pip_install(target)
                    _start_daemon()
                    ver = _health(a.previous)
                    _log(f"rolled back; kcoderd {ver} is healthy")
                    result["rolled_back"] = ver
                except Exception as exc2:  # noqa: BLE001
                    _log(f"rollback failed: {exc2}")
                    result["rollback_error"] = str(exc2)
        else:
            try:
                _start_daemon()
                _health(None)
                _log("kcoderd restarted on the previous code")
            except Exception as exc2:  # noqa: BLE001
                _log(f"could not restart kcoderd: {exc2}")
        _update(last_result=result, error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(helper_main(sys.argv[1:]))
