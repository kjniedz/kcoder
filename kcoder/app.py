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

import json
import os
import platform
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from urllib.parse import urlsplit

from . import __version__, compat, paths

APP_NAME = "kcoder"
BUNDLE_ID = "com.kyersreserve.kcoder"
AGENT_LABEL = "com.kyersreserve.kcoderd"

PROFILE_DIR = os.path.join(paths.DATA_DIR, "app-profile")
APP_LOG_PATH = os.path.join(paths.DATA_DIR, "app.log")
BUNDLE_PATH = os.environ.get("KCODER_APP_BUNDLE") or os.path.expanduser("~/Applications/kcoder.app")
AGENT_PLIST = os.environ.get("KCODER_AGENT_PLIST") or os.path.expanduser(f"~/Library/LaunchAgents/{AGENT_LABEL}.plist")
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

_CHROMIUM_MAC = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
]
_CHROMIUM_WIN = [os.path.join(base, *rel) for base in filter(None, (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"),
                                                                 os.environ.get("LOCALAPPDATA")))
                 for rel in (("Microsoft", "Edge", "Application", "msedge.exe"), ("Google", "Chrome", "Application", "chrome.exe"),
                             ("BraveSoftware", "Brave-Browser", "Application", "brave.exe"))] if os.name == "nt" else []
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
    for p in _CHROMIUM_MAC + [os.path.expanduser("~" + p) for p in _CHROMIUM_MAC] + _CHROMIUM_WIN:
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
            icon = AppKit.NSImage.alloc().initWithContentsOfFile_(os.path.join(WEB_DIR, "icon-macos-1024.png"))
            if icon is not None:
                app.setApplicationIconImage_(icon)
        except Exception:  # noqa: BLE001 - cosmetics only
            pass
    storage = os.path.join(paths.DATA_DIR, "webview")
    os.makedirs(storage, exist_ok=True)
    try:   # a stray a[download] link downloads through the save panel instead of showing the file in the window
        webview.settings["ALLOW_DOWNLOADS"] = True
    except Exception:  # noqa: BLE001
        pass
    api = WindowApi()
    api.home_url = url
    install_navigation_guard(url)
    api.window = webview.create_window(APP_NAME, url, width=1440, height=900, min_size=(900, 600), js_api=api)
    api.window.events.loaded += api.guard_page
    if sys.platform == "darwin":
        api.status_item = install_status_item(api, url)
    webview.start(private_mode=False, storage_path=storage)


# ----------------------------------------------------------------------
# the window only ever shows the app
# ----------------------------------------------------------------------

def page_allowed(url: str, home: str) -> bool:
    """True for the app itself (same scheme, host and port as `home`) and the
    blank page; everything else (files, blob: URLs, GitHub, any other site)
    belongs in the default browser."""
    u = str(url or "")
    if not u or u.startswith("about:"):
        return True
    try:
        a, b = urlsplit(u), urlsplit(home)
        return (a.scheme, a.hostname, a.port or _default_port(a.scheme)) == (b.scheme, b.hostname, b.port or _default_port(b.scheme))
    except ValueError:
        return False


def _default_port(scheme: str) -> int | None:
    return {"http": 80, "https": 443}.get(scheme)


def open_external(url: str) -> bool:
    """Open a URL outside the window: web links in the default browser,
    file: URLs with whatever opens that file. Other schemes are refused."""
    u = str(url or "").strip()
    if urlsplit(u).scheme not in ("http", "https", "mailto", "file"):
        return False
    return bool(webbrowser.open(u))


def install_navigation_guard(home: str) -> bool:
    """macOS: a subclass of pywebview's WKNavigationDelegate (installed before
    the window is made) cancels any main-frame navigation away from the app
    and opens it in the default browser instead. pywebview only does that for
    target=_blank links; a plain link (markdown in a transcript, a PR link),
    window.open() or a blob: URL would replace the app with the page. Frames
    (the preview pane) are not touched."""
    if sys.platform != "darwin":
        return False
    try:
        from webview.platforms import cocoa  # type: ignore
        import objc  # type: ignore
    except Exception:  # noqa: BLE001
        return False
    base = cocoa.BrowserView.BrowserDelegate
    if getattr(base, "_kcoder_home", None) is not None:
        base._kcoder_home = home
        return True
    try:
        class GuardedDelegate(base):          # the class body keeps PyObjC's block metadata for the handler
            _kcoder_home = home

            def webView_decidePolicyForNavigationAction_decisionHandler_(self, webview, action, handler):
                try:
                    url = str(action.request().URL().absoluteString() or "")
                    frame = action.targetFrame()
                    main = frame is None or bool(frame.isMainFrame())
                except Exception:  # noqa: BLE001
                    url, main = "", False
                if main and not page_allowed(url, type(self)._kcoder_home):
                    handler(0)        # WKNavigationActionPolicyCancel
                    try:
                        open_external(url)
                    except Exception:  # noqa: BLE001
                        pass
                    return
                objc.super(GuardedDelegate, self).webView_decidePolicyForNavigationAction_decisionHandler_(webview, action, handler)

        cocoa.BrowserView.BrowserDelegate = GuardedDelegate
        return True
    except Exception as exc:  # noqa: BLE001 - the page-level bar still works
        with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
            log.write(f"navigation guard unavailable: {exc}\n")
        return False


# Shown on any page that is not the app (should the guard above ever miss one):
# a bar at the top with "back to kcoder"; Esc and Cmd+[ go back too.
BACK_BAR_JS = """(function () {
  if (document.getElementById('kc-back')) return;
  var home = %s;
  var go = function () {
    try { if (window.pywebview && window.pywebview.api && window.pywebview.api.go_home) { window.pywebview.api.go_home(); return; } } catch (e) {}
    location.replace(home);
  };
  var bar = document.createElement('div'); bar.id = 'kc-back';
  bar.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:12px;padding:8px 14px;background:#0C0E12;color:#E6E8EC;font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;border-bottom:1px solid #2A2F3A;box-shadow:0 2px 12px rgba(0,0,0,.4)');
  var b = document.createElement('button'); b.textContent = '\u2190 back to kcoder';
  b.setAttribute('style', 'background:#3B82F6;color:#fff;border:0;border-radius:4px;padding:5px 10px;font:inherit;font-weight:600;cursor:pointer');
  b.onclick = go;
  var t = document.createElement('span'); t.textContent = 'This is not the kcoder app. Esc or \u2318[ goes back.';
  t.setAttribute('style', 'opacity:.8');
  bar.appendChild(b); bar.appendChild(t);
  (document.body || document.documentElement).appendChild(bar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === '[')) { e.preventDefault(); go(); }
  }, true);
})();"""


def install_status_item(api, url: str):
    """A monochrome "k" in the menu bar (a template image, so it follows the
    menu bar's light/dark appearance) with a small menu. Returns the status
    item so it is not garbage-collected, or None when AppKit is unavailable."""
    try:
        import AppKit  # type: ignore
        import Foundation  # type: ignore
        import objc  # type: ignore
    except ImportError:
        return None
    try:
        class _MenuTarget(Foundation.NSObject):
            def initWithApi_url_(self, api_, url_):
                self = objc.super(_MenuTarget, self).init()
                self.api, self.url = api_, url_
                return self

            def showWindow_(self, sender):
                try:
                    w = self.api.window
                    w.restore()
                    w.show()
                    AppKit.NSApp.activateIgnoringOtherApps_(True)
                except Exception:  # noqa: BLE001
                    pass

            def openBrowser_(self, sender):
                webbrowser.open(self.url)

            def newSession_(self, sender):
                self.showWindow_(sender)
                try:
                    self.api.window.evaluate_js("openNewSession()")
                except Exception:  # noqa: BLE001
                    pass

            def quit_(self, sender):
                AppKit.NSApp.terminate_(None)

            def about_(self, sender):
                """kcoder > About kcoder: the About panel inside the app, not the stock one."""
                self.showWindow_(sender)
                try:
                    self.api.window.evaluate_js("aboutDialog()")
                except Exception:  # noqa: BLE001
                    pass

            def patchAbout_(self, sender):
                """Point the application menu's About item at about: (main thread only)."""
                try:
                    main = AppKit.NSApp.mainMenu()
                    first = main.itemArray()[0].submenu() if main and main.itemArray() else None
                    for mi in (first.itemArray() if first else []):
                        if str(mi.action() or "") == "orderFrontStandardAboutPanel:":
                            mi.setTitle_("About kcoder")
                            mi.setTarget_(self)
                            mi.setAction_("about:")
                except Exception:  # noqa: BLE001
                    pass

        target = _MenuTarget.alloc().initWithApi_url_(api, url)
        bar = AppKit.NSStatusBar.systemStatusBar()
        item = bar.statusItemWithLength_(AppKit.NSVariableStatusItemLength)
        image = AppKit.NSImage.alloc().initWithContentsOfFile_(os.path.join(WEB_DIR, "menubar-kTemplate.png"))
        if image is not None:
            image.setTemplate_(True)
            image.setSize_(Foundation.NSMakeSize(18, 18))
            item.button().setImage_(image)
        item.button().setToolTip_("kcoder")
        menu = AppKit.NSMenu.alloc().initWithTitle_("kcoder")
        for title, sel, key in (("Open kcoder", "showWindow:", "o"), ("New session", "newSession:", "n"), ("Open in browser", "openBrowser:", "b"),
                                (None, None, None), ("About kcoder", "about:", ""), ("Quit kcoder", "quit:", "q")):
            if title is None:
                menu.addItem_(AppKit.NSMenuItem.separatorItem())
                continue
            mi = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, sel, key)
            mi.setTarget_(target)
            menu.addItem_(mi)
        item.setMenu_(menu)
        api.status_target = target       # keep the ObjC target alive (the item only holds a weak reference)
        try:   # the application menu exists once the window is shown; re-point its About item then
            api.window.events.shown += lambda: target.performSelectorOnMainThread_withObject_waitUntilDone_("patchAbout:", None, False)
        except Exception:  # noqa: BLE001
            pass
        return item
    except Exception as exc:  # noqa: BLE001 - the window works without a menu bar item
        with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
            log.write(f"menu bar item unavailable: {exc}\n")
        return None


# ----------------------------------------------------------------------
# dictation: on-device speech recognition (macOS Speech framework). The audio
# never leaves the machine: the request asks for on-device recognition and
# refuses to start if the locale cannot do it. Results stream into the page
# through window.kcoderDictation({text, final, error, done}); the page only
# puts the words in the composer and never sends anything by itself.
# ----------------------------------------------------------------------

DEV_TERMS = [
    "kcoder", "kcoderd", "git", "commit", "push", "pull", "rebase", "merge", "branch", "worktree", "checkout", "stash",
    "PR", "pull request", "CI", "GitHub", "repo", "README", "pyproject", "npm", "pnpm", "yarn", "bun", "pip", "venv",
    "Python", "TypeScript", "JavaScript", "JSON", "YAML", "SQL", "Postgres", "SQLite", "Redis", "Docker", "Cloudflare",
    "Worker", "Workers", "Pages", "wrangler", "Supabase", "Railway", "Vercel", "Next.js", "React", "Vite", "Tailwind",
    "pytest", "lint", "linter", "refactor", "regex", "async", "await", "daemon", "websocket", "endpoint", "API", "token",
    "Claude", "Opus", "Sonnet", "Haiku", "Fable", "config", "env", "dotenv", "localhost", "stack trace", "traceback",
    "null", "undefined", "boolean", "integer", "string", "enum", "struct", "tuple", "dict", "list", "array", "map",
    "diff", "patch", "hunk", "checkpoint", "undo", "rollback", "deploy", "staging", "production", "preview", "screenshot",
    "Markdown", "CSS", "HTML", "SVG", "PNG", "CSV", "UUID", "SHA", "HTTP", "HTTPS", "URL", "CLI", "TUI", "UI", "UX",
]


class Dictation:
    def __init__(self, api):
        self.api = api
        self.active = False
        self._engine = None
        self._request = None
        self._task = None
        self._recognizer = None
        self._lock = threading.Lock()

    @staticmethod
    def available() -> bool:
        if sys.platform != "darwin":
            return False
        try:
            import AVFoundation  # type: ignore  # noqa: F401
            import Speech  # type: ignore  # noqa: F401
        except ImportError:
            return False
        return True

    def info(self, lang: str = "") -> dict:
        if not self.available():
            return {"available": False, "reason": "the Speech framework is not installed (pip install pyobjc-framework-Speech pyobjc-framework-AVFoundation)"}
        import Foundation  # type: ignore
        import Speech  # type: ignore
        rec = Speech.SFSpeechRecognizer.alloc().initWithLocale_(Foundation.NSLocale.localeWithLocaleIdentifier_(lang or "en-US")) if lang else Speech.SFSpeechRecognizer.alloc().init()
        on_device = bool(rec and rec.supportsOnDeviceRecognition())
        return {"available": bool(rec), "on_device": on_device, "auth": int(Speech.SFSpeechRecognizer.authorizationStatus()), "active": self.active,
                "locale": str(rec.locale().localeIdentifier()) if rec else None}

    def _push(self, **fields) -> None:
        try:
            self.api.window.evaluate_js("window.kcoderDictation && kcoderDictation(%s)" % json.dumps(fields))
        except Exception as exc:  # noqa: BLE001
            with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
                log.write(f"dictation push: {exc}\n")

    def _authorize(self) -> str | None:
        """Ask for speech recognition and microphone access once; a reason when refused."""
        import AVFoundation  # type: ignore
        import Speech  # type: ignore
        if Speech.SFSpeechRecognizer.authorizationStatus() == 0:      # not determined: the system asks
            done = threading.Event()
            Speech.SFSpeechRecognizer.requestAuthorization_(lambda st: done.set())
            done.wait(120)
        if Speech.SFSpeechRecognizer.authorizationStatus() != 3:
            return "speech recognition is not allowed for kcoder: System Settings → Privacy & Security → Speech Recognition"
        if AVFoundation.AVCaptureDevice.authorizationStatusForMediaType_(AVFoundation.AVMediaTypeAudio) == 0:
            done = threading.Event()
            AVFoundation.AVCaptureDevice.requestAccessForMediaType_completionHandler_(AVFoundation.AVMediaTypeAudio, lambda ok: done.set())
            done.wait(120)
        if AVFoundation.AVCaptureDevice.authorizationStatusForMediaType_(AVFoundation.AVMediaTypeAudio) != 3:
            return "microphone access is not allowed for kcoder: System Settings → Privacy & Security → Microphone"
        return None

    def start(self, context: list | None = None, lang: str = "") -> dict:
        if not self.available():
            return {"ok": False, "error": "on-device dictation needs the macOS Speech framework"}
        with self._lock:
            if self.active:
                return {"ok": True, "already": True}
            reason = self._authorize()
            if reason:
                return {"ok": False, "error": reason}
            import AVFoundation  # type: ignore
            import Foundation  # type: ignore
            import Speech  # type: ignore
            rec = Speech.SFSpeechRecognizer.alloc().initWithLocale_(Foundation.NSLocale.localeWithLocaleIdentifier_(lang)) if lang else Speech.SFSpeechRecognizer.alloc().init()
            if rec is None or not rec.isAvailable():
                return {"ok": False, "error": "speech recognition is not available for this language right now"}
            if not rec.supportsOnDeviceRecognition():
                return {"ok": False, "error": "on-device recognition is not available for this language, so dictation stays off (audio would leave the machine)"}
            req = Speech.SFSpeechAudioBufferRecognitionRequest.alloc().init()
            req.setShouldReportPartialResults_(True)
            req.setRequiresOnDeviceRecognition_(True)
            words = []
            for w in list(context or []) + DEV_TERMS:
                w = str(w or "").strip()
                if w and w not in words:
                    words.append(w)
            req.setContextualStrings_(words[:300])
            try:
                req.setTaskHint_(1)      # SFSpeechRecognitionTaskHintDictation
            except Exception:  # noqa: BLE001
                pass
            engine = AVFoundation.AVAudioEngine.alloc().init()
            node = engine.inputNode()
            fmt = node.outputFormatForBus_(0)
            node.installTapOnBus_bufferSize_format_block_(0, 1024, fmt, lambda buf, when: req.appendAudioPCMBuffer_(buf))
            engine.prepare()
            ok, err = engine.startAndReturnError_(None)
            if not ok:
                node.removeTapOnBus_(0)
                return {"ok": False, "error": f"the microphone could not be opened: {err}"}
            self._engine, self._request, self._recognizer = engine, req, rec
            self.active = True

            def handler(result, error):
                text = str(result.bestTranscription().formattedString()) if result is not None else ""
                final = bool(result is not None and result.isFinal())
                if result is not None:
                    self._push(text=text, final=final)
                if error is not None or final:
                    msg = str(error.localizedDescription()) if error is not None else ""
                    if error is not None and getattr(error, "code", lambda: 0)() in (216, 301, 1110) or "cancel" in msg.lower():
                        msg = ""          # 216/301: cancelled or stopped by us; 1110: no speech detected
                    self._teardown()
                    self._push(done=True, error=msg or None)

            self._task = rec.recognitionTaskWithRequest_resultHandler_(req, handler)
            return {"ok": True, "on_device": True, "terms": len(words)}

    def _teardown(self) -> None:
        self.active = False
        eng, self._engine = self._engine, None
        self._request = None
        self._task = None
        if eng is not None:
            try:
                eng.inputNode().removeTapOnBus_(0)
                eng.stop()
            except Exception:  # noqa: BLE001
                pass

    def stop(self) -> dict:
        with self._lock:
            if not self.active:
                return {"ok": True, "already": True}
            req, eng = self._request, self._engine
            try:
                if eng is not None:
                    eng.inputNode().removeTapOnBus_(0)
                    eng.stop()
                if req is not None:
                    req.endAudio()       # the task delivers its final result, then the handler tears down
            except Exception as exc:  # noqa: BLE001
                self._teardown()
                return {"ok": False, "error": str(exc)}
            self._engine = None
            return {"ok": True}


class WindowApi:
    """Exposed to the page as window.pywebview.api.* in the native window."""

    window = None
    home_url = ""

    def __init__(self):
        self.dictation = Dictation(self)

    def is_native(self) -> bool:
        return True

    def dictate_info(self, lang: str = "") -> dict:
        """Can this window dictate on-device, and is it allowed to?"""
        try:
            return self.dictation.info(str(lang or ""))
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "reason": str(exc)}

    def dictate_start(self, context=None, lang: str = "") -> dict:
        """Start on-device dictation; words arrive through window.kcoderDictation.
        `context` biases recognition (repo names, branch names, the dev terms are added)."""
        try:
            return self.dictation.start(list(context or []), str(lang or ""))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    def dictate_stop(self) -> dict:
        try:
            return self.dictation.stop()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    def save_file(self, name: str, content: str) -> dict:
        """Save text through the native save dialog (Downloads by default).
        {"path", "name"} once written, {"cancelled": true}, or {"error"}."""
        import webview  # type: ignore
        name = os.path.basename(str(name or "")).strip() or "export.txt"
        downloads = os.path.expanduser("~/Downloads")
        if not os.path.isdir(downloads):
            downloads = os.path.expanduser("~")
        try:
            res = self.window.create_file_dialog(webview.FileDialog.SAVE, directory=downloads, save_filename=name)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"save dialog: {exc}"}
        if not res:
            return {"cancelled": True}
        path = str(res[0] if isinstance(res, (list, tuple)) else res)
        try:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(str(content or ""))
        except OSError as exc:
            return {"error": str(exc)}
        return {"path": path, "name": os.path.basename(path)}

    def reveal(self, path: str) -> bool:
        """Show a saved file in Finder (Explorer on Windows, the folder elsewhere)."""
        path = str(path or "")
        if not path or not os.path.exists(path):
            return False
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", "-R", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            elif os.name == "nt":
                subprocess.Popen(["explorer", "/select,", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path) or "."], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            return False

    def open_external(self, url: str) -> bool:
        """A link that must not replace the app: the default browser gets it."""
        return open_external(url)

    def go_home(self) -> bool:
        """Back to the app (the "back to kcoder" bar, Esc, Cmd+[)."""
        try:
            self.window.load_url(self.home_url)
            return True
        except Exception:  # noqa: BLE001
            return False

    def guard_page(self) -> None:
        """After every page load: if the window shows anything but the app,
        put the "back to kcoder" bar on it (runs on pywebview's event thread)."""
        def check():
            try:
                cur = self.window.get_current_url() or ""
                if page_allowed(cur, self.home_url):
                    return
                self.window.evaluate_js(BACK_BAR_JS % json.dumps(self.home_url))
            except Exception as exc:  # noqa: BLE001
                with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
                    log.write(f"back bar: {exc}\n")
        threading.Thread(target=check, daemon=True).start()

    def start_daemon(self) -> str:
        """The page found kcoderd down (stopped, crashed, or a restart that never
        came back): start it. 'running' when it is already up."""
        from . import client
        from .daemon import already_running
        if already_running():
            return "running"
        try:
            if sys.platform == "darwin" and agent_installed() and agent_loaded():
                agent_start()
            else:
                client.spawn_daemon()
            return "started"
        except Exception as exc:  # noqa: BLE001
            return f"failed: {exc}"

    def toggle_fullscreen(self) -> bool:
        """Native macOS full screen (the green-button kind)."""
        try:
            self.window.toggle_fullscreen()
            return True
        except Exception:  # noqa: BLE001
            return False

    def notify(self, title: str, body: str = "") -> bool:
        """A macOS notification from the kcoder.app process (so it carries
        the kcoder name and icon); falls back to osascript elsewhere."""
        title, body = str(title or "kcoder")[:120], str(body or "")[:240]
        if sys.platform == "darwin":
            try:
                import Foundation  # type: ignore
                n = Foundation.NSUserNotification.alloc().init()
                n.setTitle_(title)
                if body:
                    n.setInformativeText_(body)
                Foundation.NSUserNotificationCenter.defaultUserNotificationCenter().deliverNotification_(n)
                return True
            except Exception:  # noqa: BLE001
                pass
            script = 'display notification "%s" with title "%s"' % (
                body.replace("\\", "\\\\").replace('"', '\\"'), title.replace("\\", "\\\\").replace('"', '\\"'))
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
            return True
        return False


def _open_bundle() -> bool:
    """Launch (or refresh, then launch) ~/Applications/kcoder.app. Launching
    through the bundle is what gives the window the kcoder name and icon in
    the Dock and makes it pinnable. False if the bundle can't be used."""
    try:
        if not mac_app_current():
            install_mac_app()
        r = subprocess.run(["open", BUNDLE_PATH], capture_output=True, text=True, timeout=30)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


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
            elif sys.platform == "darwin" and _open_bundle():
                pass
            else:
                paths.ensure_data_dir()
                with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
                    subprocess.Popen(
                        [_gui_python(), "-P", "-m", "kcoder.app", url],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        close_fds=True, cwd=os.path.expanduser("~"), **compat.detached(),
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
                close_fds=True, **compat.detached(),
            )
            return "chromium"
        if mode == "chromium":
            raise RuntimeError("no Chrome, Brave, Edge, Chromium or Vivaldi found")

    webbrowser.open(url)
    return "browser"


# ----------------------------------------------------------------------
# macOS app bundle: ~/Applications/kcoder.app
# ----------------------------------------------------------------------

def _gui_python() -> str:
    """pythonw.exe next to python.exe on Windows (no console window), else sys.executable."""
    if os.name == "nt":
        w = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        if os.path.isfile(w):
            return w
    return sys.executable


# ----------------------------------------------------------------------
# Windows: Start Menu and Desktop shortcuts
# ----------------------------------------------------------------------

def windows_shortcuts() -> list:
    start = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Microsoft", "Windows", "Start Menu", "Programs", "kcoder.lnk")
    desktop = os.path.join(os.path.expanduser("~"), "Desktop", "kcoder.lnk")
    return [start, desktop]


def install_windows_app() -> str:
    """Start Menu + Desktop shortcuts that open the kcoder app (no console window)."""
    if os.name != "nt":
        raise RuntimeError("Windows shortcuts can only be made on Windows")
    icon = os.path.join(WEB_DIR, "icon.ico")
    made = []
    for lnk in windows_shortcuts():
        os.makedirs(os.path.dirname(lnk), exist_ok=True)
        ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:KC_LNK); "
              "$s.TargetPath = $env:KC_TARGET; $s.Arguments = '-m kcoder.cli app'; "
              "$s.WorkingDirectory = $env:USERPROFILE; $s.IconLocation = $env:KC_ICON; "
              "$s.Description = 'kcoder'; $s.Save()")
        env = dict(os.environ, KC_LNK=lnk, KC_TARGET=_gui_python(), KC_ICON=icon)
        r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                           capture_output=True, text=True, timeout=60, env=env)
        if r.returncode != 0:
            raise RuntimeError("could not create the shortcut: " + (r.stderr or r.stdout).strip()[-300:])
        made.append(lnk)
    return made[0]


def uninstall_windows_app() -> bool:
    removed = False
    for lnk in windows_shortcuts():
        try:
            os.remove(lnk)
            removed = True
        except OSError:
            pass
    return removed


def _require_mac(what: str) -> None:
    if sys.platform != "darwin":
        raise RuntimeError(f"{what} is macOS-only; on this system run `kcoder app` directly")


def _make_icns(dest: str) -> bool:
    """Build an .icns from web/icon-macos-1024.png (the logo inside the macOS
    icon template: margins + corner radius) with the system tools."""
    src = os.path.join(WEB_DIR, "icon-macos-1024.png")
    if not os.path.isfile(src):
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


def _real_interpreter() -> str:
    """The interpreter binary that actually runs (python.org framework builds
    exec Python.app/Contents/MacOS/Python behind bin/python3)."""
    cand = os.path.join(sys.base_prefix, "Resources", "Python.app", "Contents", "MacOS", "Python")
    if os.path.isfile(cand):
        return cand
    return os.path.realpath(sys.executable)


def _bundle_interpreter(macos_dir: str) -> str | None:
    """Copy the interpreter into the bundle, re-sign it ad hoc and check it
    still imports kcoder. Returns its path, or None to fall back to the
    framework interpreter (Dock will say "Python" then)."""
    dest = os.path.join(macos_dir, f"{APP_NAME}-python")
    try:
        shutil.copy2(_real_interpreter(), dest)
        os.chmod(dest, 0o755)
        if shutil.which("codesign"):
            subprocess.run(["codesign", "--force", "--sign", "-", dest], capture_output=True)
        r = subprocess.run([dest, "-P", "-c", "import kcoder, webview"], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[-300:] or f"exit {r.returncode}")
        return dest
    except Exception as exc:  # noqa: BLE001
        try:
            os.remove(dest)
        except OSError:
            pass
        with open(APP_LOG_PATH, "a", encoding="utf-8") as log:
            log.write(f"bundled interpreter unavailable, using {sys.executable}: {exc}\n")
        return None


def bundle_version(path: str = BUNDLE_PATH) -> str | None:
    try:
        with open(os.path.join(path, "Contents", "Info.plist"), "rb") as f:
            return str(plistlib.load(f).get("CFBundleVersion") or "")
    except (OSError, plistlib.InvalidFileException):
        return None


def mac_app_current(path: str = BUNDLE_PATH) -> bool:
    """Installed, built by this kcoder version, with its own interpreter."""
    return (mac_app_installed(path) and bundle_version(path) == __version__
            and os.path.isfile(os.path.join(path, "Contents", "MacOS", f"{APP_NAME}-python")))


def install_mac_app(path: str = BUNDLE_PATH) -> str:
    """Write (or refresh) the kcoder.app bundle. Returns its path."""
    _require_mac("the app bundle")
    contents = os.path.join(path, "Contents")
    macos = os.path.join(contents, "MacOS")
    resources = os.path.join(contents, "Resources")
    os.makedirs(macos, exist_ok=True)
    os.makedirs(resources, exist_ok=True)

    launcher = os.path.join(macos, APP_NAME)
    # The Dock names a window after the bundle that owns the running
    # executable. A script that execs the framework's Python is owned by
    # Python.app, so the Dock says "Python" and pinning pins Python. Running
    # a copy of the interpreter from inside this bundle makes the window
    # "kcoder" in the Dock and pinnable. The copy is re-signed ad hoc because
    # the original's hardened-runtime signature is killed outside its bundle.
    bundled = _bundle_interpreter(macos)
    interpreter = f'"$DIR/{os.path.basename(bundled)}"' if bundled else shlex.quote(sys.executable)
    # LaunchServices may start a script-based bundle under Rosetta, and then a
    # universal Python loads x86_64 and its arm64-only wheels fail to import.
    # Pin the interpreter to the architecture this install is running on.
    machine = platform.machine()
    arch = f"arch -{machine} " if machine in ("arm64", "x86_64") and shutil.which("arch") else ""
    script = (
        "#!/bin/bash\n"
        "# kcoder.app launcher, generated by `kcoder app --install`\n"
        'DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        f"export PATH={shlex.quote(full_path())}\n"
        'export LANG="${LANG:-en_US.UTF-8}"\n'
        'cd "$HOME"\n'
        f"exec {arch}{interpreter} -P -m kcoder.cli app --foreground >> {shlex.quote(APP_LOG_PATH)} 2>&1\n"
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
        # on-device dictation into the composer (Speech framework + microphone); the audio never leaves the Mac
        "NSMicrophoneUsageDescription": "kcoder dictates into the message box with on-device speech recognition. Audio never leaves this Mac.",
        "NSSpeechRecognitionUsageDescription": "kcoder turns your voice into text on this Mac. Nothing is sent to a server.",
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
