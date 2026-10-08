"""Live preview: a dev server per session, started inside its worktree on its
own port so parallel sessions never collide, shown in a pane. Also takes the
desktop + mobile screenshots attached to pull requests.

Detection order: .kcoder/preview.json {"command": "...", "cwd": "...",
"url": "http://127.0.0.1:{port}/"} > package.json scripts (dev, then start)
> Django manage.py > Flask app > a static index.html.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import signal
import socket
import subprocess
import tempfile
import time

from . import app as appmod

PORT_RANGE = (4300, 4399)
IGNORED = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".nuxt", ".cache", ".kcoder", "target"}


class PreviewError(Exception):
    pass


def detect(cwd: str) -> dict | None:
    """How to start this project's dev server, or None for non-web projects."""
    custom = os.path.join(cwd, ".kcoder", "preview.json")
    if os.path.isfile(custom):
        try:
            with open(custom, "r", encoding="utf-8") as f:
                d = json.load(f)
            if d.get("command"):
                return {"kind": "custom", "command": d["command"], "cwd": os.path.join(cwd, d.get("cwd") or "."),
                        "label": d.get("label") or d["command"][:40], "hmr": bool(d.get("hmr", False))}
        except (OSError, json.JSONDecodeError):
            pass
    pkg = os.path.join(cwd, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, "r", encoding="utf-8") as f:
                scripts = (json.load(f).get("scripts") or {})
        except (OSError, json.JSONDecodeError):
            scripts = {}
        for name in ("dev", "start", "serve", "preview"):
            script = scripts.get(name)
            if not script:
                continue
            extra = ""
            if "next dev" in script or script.startswith("next"):
                extra = " -- -p {port}"
            elif any(k in script for k in ("vite", "astro", "remix", "svelte-kit", "ng serve", "webpack serve", "parcel")):
                extra = " -- --port {port}"
            runner = "npm run" if not os.path.isfile(os.path.join(cwd, "pnpm-lock.yaml")) else "pnpm run"
            if os.path.isfile(os.path.join(cwd, "yarn.lock")):
                runner = "yarn"
            return {"kind": f"npm-{name}", "command": f"{runner} {name}{extra}", "cwd": cwd, "label": f"{runner} {name}",
                    "hmr": name == "dev" and any(k in script for k in ("vite", "next", "astro", "nuxt", "remix", "webpack", "parcel", "svelte"))}
    if os.path.isfile(os.path.join(cwd, "manage.py")):
        return {"kind": "django", "command": "python3 manage.py runserver 127.0.0.1:{port}", "cwd": cwd, "label": "django runserver", "hmr": False}
    for name in ("app.py", "wsgi.py", "application.py"):
        p = os.path.join(cwd, name)
        if os.path.isfile(p):
            try:
                head = open(p, "r", encoding="utf-8", errors="replace").read(4000)
            except OSError:
                head = ""
            if "flask" in head.lower():
                return {"kind": "flask", "command": f"python3 -m flask --app {name} run -p {{port}}", "cwd": cwd, "label": "flask run", "hmr": False}
    for sub in (".", "public", "site", "docs", "www"):
        d = os.path.join(cwd, sub)
        if os.path.isfile(os.path.join(d, "index.html")):
            return {"kind": "static", "command": "python3 -m http.server {port} --bind 127.0.0.1", "cwd": d, "label": f"static ({sub})", "hmr": False}
    return None


def free_port(taken: set) -> int:
    for port in range(PORT_RANGE[0], PORT_RANGE[1] + 1):
        if port in taken:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise PreviewError("no free preview port between %d and %d" % PORT_RANGE)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


class Preview:
    def __init__(self, cwd: str, spec: dict, port: int, log_path: str):
        self.cwd, self.spec, self.port, self.log_path = cwd, spec, port, log_path
        self.proc = None
        self.started = 0.0
        self.url = f"http://127.0.0.1:{port}/"

    def start(self) -> None:
        cmd = self.spec["command"].format(port=self.port)
        env = dict(os.environ, PORT=str(self.port), HOST="127.0.0.1", BROWSER="none", CI="1", FORCE_COLOR="0")
        env["PATH"] = appmod.full_path()
        env.pop("KCODER_DATA_DIR", None)
        log = open(self.log_path, "a")
        log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} kcoder preview: {cmd} (port {self.port})\n")
        log.flush()
        self.proc = subprocess.Popen(cmd, shell=True, cwd=self.spec.get("cwd") or self.cwd, env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        self.started = time.time()

    def wait_ready(self, timeout: float = 60.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                return False
            if port_open(self.port):
                return True
            time.sleep(0.3)
        return port_open(self.port)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        for _ in range(30):
            if self.proc.poll() is not None:
                break
            time.sleep(0.1)
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except OSError:
                pass
        self.proc = None

    def info(self) -> dict:
        return {"port": self.port, "url": self.url, "kind": self.spec["kind"], "label": self.spec["label"],
                "hmr": bool(self.spec.get("hmr")), "running": self.alive(), "started": self.started, "log": self.log_path}


def tail_log(path: str, n: int = 40) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""


def tree_signature(cwd: str, limit: int = 4000) -> str:
    """A cheap fingerprint of file mtimes, so the pane can reload on change."""
    h = hashlib.sha1()
    n = 0
    for dirpath, dirnames, filenames in os.walk(cwd):
        dirnames[:] = [d for d in dirnames if d not in IGNORED and not d.startswith(".")]
        for name in filenames:
            try:
                st = os.stat(os.path.join(dirpath, name))
            except OSError:
                continue
            h.update(f"{name}{st.st_mtime_ns}{st.st_size}".encode())
            n += 1
            if n >= limit:
                return h.hexdigest()
    return h.hexdigest()


def screenshot(url: str, path: str, width: int, height: int, timeout: int = 60, profile_dir: str | None = None) -> bool:
    """Headless Chromium screenshot of `url`. False when no browser is available or it fails.
    The browser profile lives in `profile_dir` (never inside the repo)."""
    exe = appmod.chromium_binary()
    if not exe:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    profile_dir = profile_dir or os.path.join(tempfile.gettempdir(), "kcoder-shot-profile")
    args = [exe, "--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
            f"--window-size={width},{height}", f"--screenshot={path}", "--virtual-time-budget=4000",
            f"--user-data-dir={profile_dir}", url]
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    # headless Chrome writes the file within seconds and then may linger (or
    # exit non-zero): wait for a stable file, then kill the whole process group
    try:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    deadline = time.monotonic() + timeout
    last = -1
    stable = 0
    try:
        while time.monotonic() < deadline:
            size = os.path.getsize(path) if os.path.isfile(path) else -1
            if size > 0 and size == last:
                stable += 1
                if stable >= 2:
                    break
            else:
                stable = 0
            last = size
            if proc.poll() is not None and size > 0:
                break
            time.sleep(0.5)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    return os.path.isfile(path) and os.path.getsize(path) > 0
