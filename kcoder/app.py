"""The kcoder app: the web UI in its own window instead of a browser tab.

    kcoder app              open the app window (starts kcoderd if needed)
    kcoder app --install    macOS: put kcoder.app in ~/Applications so it is
                            in Spotlight, Launchpad and the Dock
    kcoder daemon install   macOS: run kcoderd as a login item (launchd)

How the window is opened, in order of preference:

1. pywebview, when it is installed (`pip install pywebview`): a native
   window.
2. A Chromium-family browser (Chrome, Brave, Edge, Chromium, Vivaldi) in
   `--app` mode with its own profile: a chromeless window with no tabs or
   address bar, separate from your normal browsing.
3. The default browser, as `kcoder ui` always did.
"""

from __future__ import annotations

import os
import platform
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import webbrowser

from . import __version__, paths

APP_NAME = "kcoder"
BUNDLE_ID = "com.kyersreserve.kcoder"
AGENT_LABEL = "com.kyersreserve.kcoderd"

PROFILE_DIR = os.path.join(paths.DATA_DIR, "app-profile")
APP_LOG_PATH = os.path.join(paths.DATA_DIR, "app.log")
BUNDLE_PATH = os.path.expanduser("~/Applications/kcoder.app")
AGENT_PLIST = os.path.expanduser(f"~/Library/LaunchAgents/{AGENT_LABEL}.plist")
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

_CHROMIUM_MAC = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
]
_CHROMIUM_BIN = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                 "brave-browser", "microsoft-edge", "vivaldi"]

# directories that must be on PATH for the daemon's tools (gh, claude, git)
# when it is launched from Finder or launchd rather than a shell
_EXTRA_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin",
               "/usr/sbin", "/sbin", os.path.dirname(sys.executable),
               os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.bun/bin"),
               os.path.expanduser("~/.claude/local"), os.path.expanduser("~/.cargo/bin")]


def full_path() -> str:
    """The current PATH plus the usual tool directories, deduplicated."""
    seen: list[str] = []
    for p in os.environ.get("PATH", "").split(os.pathsep) + _EXTRA_PATH:
        if p and p not in seen:
            seen.append(p)
    return os.pathsep.join(seen)


# ----------------------------------------------------------------------
# opening the window
# ----------------------------------------------------------------------

def chromium_binary() -> str | None:
    """A Chromium-family browser that supports --app mode, or None."""
    for p in _CHROMIUM_MAC + [os.path.expanduser("~" + p) for p in _CHROMIUM_MAC]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    for b in _CHROMIUM_BIN:
        found = shutil.which(b)
        if found:
            return found
    return None


def app_url(info: dict) -> str:
    """The UI URL with the daemon token attached (the page stores it)."""
    with open(paths.TOKEN_PATH, "r", encoding="utf-8") as f:
        token = f.read().strip()
    return f"http://{info['host']}:{info['port']}/#token={token}"


def native_available() -> bool:
    try:
        import webview  # type: ignore  # noqa: F401
    except ImportError:
        return False
    return True


def run_native_window(url: str) -> None:
    """Run the native window in this process (blocks until it is closed).
    On macOS the process gets the kcoder icon and name in the Dock and menu
    bar, so it looks like its own app however it was launched."""
    import webview  # type: ignore

    if sys.platform == "darwin":
        try:
            import AppKit  # type: ignore
            import Foundation  # type: ignore
            info = Foundation.NSBundle.mainBundle().infoDictionary()
            if info is not None:
                info["CFBundleName"] = APP_NAME
                info["CFBundleDisplayName"] = APP_NAME
            app = AppKit.NSApplication.sharedApplication()
            icon = AppKit.NSImage.alloc().initWithContentsOfFile_(os.path.join(WEB_DIR, "icon-1024.png"))
            if icon is not None:
                app.setApplicationIconImage_(icon)
        except Exception:  # noqa: BLE001 - cosmetics only
            pass
    storage = os.path.join(paths.DATA_DIR, "webview")
    os.makedirs(storage, exist_ok=True)
    webview.create_window(APP_NAME, url, width=1440, height=900, min_size=(900, 600))
    webview.start(private_mode=False, storage_path=storage)


def open_window(url: str, mode: str = "auto", foreground: bool = False) -> str:
    """Open the UI in its own window.

    mode: auto | native | chromium | browser. Returns the mode actually used.
    The native window runs in a detached process (so the terminal is free)
    unless `foreground` is set; the other modes always return at once.
    """
    if mode in ("auto", "native"):
        if native_available():
            if foreground:
                run_native_window(url)
            else:
                paths.ensure_data_dir()
                with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
                    subprocess.Popen(
                        [sys.executable, "-P", "-m", "kcoder.app", url],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        start_new_session=True, close_fds=True, cwd=os.path.expanduser("~"),
                    )
            return "native"
        if mode == "native":
            raise RuntimeError("pywebview is not installed (pip install pywebview)")

    if mode in ("auto", "chromium"):
        exe = chromium_binary()
        if exe:
            os.makedirs(PROFILE_DIR, exist_ok=True)
            subprocess.Popen(
                [exe, f"--app={url}", f"--user-data-dir={PROFILE_DIR}", "--no-first-run",
                 "--no-default-browser-check", "--window-size=1440,900", f"--class={APP_NAME}"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, close_fds=True,
            )
            return "chromium"
        if mode == "chromium":
            raise RuntimeError("no Chrome, Brave, Edge, Chromium or Vivaldi found")

    webbrowser.open(url)
    return "browser"


# ----------------------------------------------------------------------
# macOS app bundle: ~/Applications/kcoder.app
# ----------------------------------------------------------------------

def _require_mac(what: str) -> None:
    if sys.platform != "darwin":
        raise RuntimeError(f"{what} is macOS-only; on this system run `kcoder app` directly")


def _make_icns(dest: str) -> bool:
    """Build an .icns from web/icon-1024.png with the system tools. False if that fails."""
    src = os.path.join(WEB_DIR, "icon-1024.png")
    if not (os.path.isfile(src) and shutil.which("sips") and shutil.which("iconutil")):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "kcoder.iconset")
        os.makedirs(iconset)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                r = subprocess.run(["sips", "-z", str(px), str(px), src, "--out", os.path.join(iconset, name)],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    return False
        r = subprocess.run(["iconutil", "-c", "icns", iconset, "-o", dest], capture_output=True, text=True)
        return r.returncode == 0


def install_mac_app(path: str = BUNDLE_PATH) -> str:
    """Write (or refresh) the kcoder.app bundle. Returns its path."""
    _require_mac("the app bundle")
    contents = os.path.join(path, "Contents")
    macos = os.path.join(contents, "MacOS")
    resources = os.path.join(contents, "Resources")
    os.makedirs(macos, exist_ok=True)
    os.makedirs(resources, exist_ok=True)

    launcher = os.path.join(macos, APP_NAME)
    # LaunchServices may start a script-based bundle under Rosetta, and then a
    # universal Python loads x86_64 and its arm64-only wheels fail to import.
    # Pin the interpreter to the architecture this install is running on.
    machine = platform.machine()
    arch = f"arch -{machine} " if machine in ("arm64", "x86_64") and shutil.which("arch") else ""
    script = (
        "#!/bin/bash\n"
        "# kcoder.app launcher, generated by `kcoder app --install`\n"
        f"export PATH={shlex.quote(full_path())}\n"
        'export LANG="${LANG:-en_US.UTF-8}"\n'
        'cd "$HOME"\n'
        f"exec {arch}{shlex.quote(sys.executable)} -P -m kcoder.cli app >> {shlex.quote(APP_LOG_PATH)} 2>&1\n"
    )
    with open(launcher, "w", encoding="utf-8") as f:
        f.write(script)
    os.chmod(launcher, 0o755)

    has_icon = _make_icns(os.path.join(resources, "kcoder.icns"))
    info = {
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleVersion": __version__,
        "CFBundleShortVersionString": __version__,
        "CFBundleExecutable": APP_NAME,
        "CFBundlePackageType": "APPL",
        "CFBundleInfoDictionaryVersion": "6.0",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.developer-tools",
        "LSArchitecturePriority": [machine] + [a for a in ("arm64", "x86_64") if a != machine] if machine in ("arm64", "x86_64") else ["arm64", "x86_64"],
    }
    if has_icon:
        info["CFBundleIconFile"] = "kcoder"
    with open(os.path.join(contents, "Info.plist"), "wb") as f:
        plistlib.dump(info, f)
    with open(os.path.join(contents, "PkgInfo"), "w", encoding="ascii") as f:
        f.write("APPL????")

    # tell LaunchServices about it so Spotlight and Launchpad pick it up
    lsregister = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/"
                  "LaunchServices.framework/Support/lsregister")
    if os.path.isfile(lsregister):
        subprocess.run([lsregister, "-f", path], capture_output=True)
    os.utime(path, None)
    return path


def uninstall_mac_app(path: str = BUNDLE_PATH) -> bool:
    if os.path.isdir(path):
        shutil.rmtree(path)
        return True
    return False


def mac_app_installed(path: str = BUNDLE_PATH) -> bool:
    return os.path.isfile(os.path.join(path, "Contents", "MacOS", APP_NAME))


# ----------------------------------------------------------------------
# launchd agent: kcoderd as a login item
# ----------------------------------------------------------------------

def _gui_domain() -> str:
    return f"gui/{os.getuid()}"


def agent_installed() -> bool:
    return os.path.isfile(AGENT_PLIST)


def agent_loaded() -> bool:
    if sys.platform != "darwin" or not shutil.which("launchctl"):
        return False
    r = subprocess.run(["launchctl", "print", f"{_gui_domain()}/{AGENT_LABEL}"], capture_output=True)
    return r.returncode == 0


def install_launch_agent() -> str:
    """Write the LaunchAgent plist and load it. The caller stops any daemon
    that is already running first (two daemons cannot share the port)."""
    _require_mac("the login item")
    os.makedirs(os.path.dirname(AGENT_PLIST), exist_ok=True)
    paths.ensure_data_dir()
    plist = {
        "Label": AGENT_LABEL,
        "ProgramArguments": [sys.executable, "-P", "-m", "kcoder.daemon", "--log-file", paths.DAEMON_LOG_PATH],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},   # restart after a crash, stay down after `kcoder daemon stop`
        "WorkingDirectory": os.path.expanduser("~"),
        "EnvironmentVariables": {
            "PATH": full_path(),
            "HOME": os.path.expanduser("~"),
            "LANG": os.environ.get("LANG") or "en_US.UTF-8",
        },
        "StandardOutPath": paths.DAEMON_LOG_PATH,
        "StandardErrorPath": paths.DAEMON_LOG_PATH,
        "ProcessType": "Interactive",
    }
    if agent_loaded():
        agent_stop()
    with open(AGENT_PLIST, "wb") as f:
        plistlib.dump(plist, f)
    agent_start()
    return AGENT_PLIST


def uninstall_launch_agent() -> bool:
    if agent_loaded():
        agent_stop()
    if os.path.isfile(AGENT_PLIST):
        os.remove(AGENT_PLIST)
        return True
    return False


def agent_start() -> None:
    r = subprocess.run(["launchctl", "bootstrap", _gui_domain(), AGENT_PLIST], capture_output=True, text=True)
    if r.returncode != 0 and "already" not in (r.stderr + r.stdout).lower():
        # older launchctl, or the job is loaded but stopped
        r2 = subprocess.run(["launchctl", "kickstart", f"{_gui_domain()}/{AGENT_LABEL}"], capture_output=True, text=True)
        if r2.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or r2.stderr).strip() or "launchctl bootstrap failed")


def agent_stop() -> None:
    subprocess.run(["launchctl", "bootout", f"{_gui_domain()}/{AGENT_LABEL}"], capture_output=True, text=True)


def main(argv: list | None = None) -> None:
    """`python -m kcoder.app <url>`: the native window process."""
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        from .client import ensure_daemon
        url = app_url(ensure_daemon())
    else:
        url = argv[0]
    run_native_window(url)


if __name__ == "__main__":
    main()
