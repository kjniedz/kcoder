"""First-run setup used by the app: which providers are ready, connecting an
API key without a terminal, and getting Claude Code installed and signed in
for people who use their Claude plan.

The daemon never has a terminal of its own, so anything interactive (the
Claude Code installer, `claude auth login`) is opened in the user's Terminal
app where they can see it and follow along."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys

from . import auth, identity
from .providers import PROVIDERS, claude_path, make_backend

CLAUDE_INSTALL_URL = "https://claude.ai/install.sh"


def claude_status() -> dict:
    """Is the Claude Code CLI installed, and is it signed in?"""
    path = claude_path()
    info = {"installed": path is not None, "logged_in": False, "email": None, "path": path}
    if not path:
        return info
    try:
        out = subprocess.run([path, "auth", "status", "--json"], capture_output=True, text=True, timeout=20)
        data = json.loads(out.stdout or "{}")
        info["logged_in"] = bool(data.get("loggedIn"))
        info["email"] = data.get("email")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        pass
    return info


def providers_info() -> list:
    """What the app shows in the provider pickers and the setup dialog."""
    default = auth.load_config().get("default_provider")
    rows = []
    for p in PROVIDERS.values():
        from . import routing
        row = {"id": p.id, "label": p.label, "kind": p.kind, "key_url": p.key_url, "models": p.models,
               "default_model": p.default_model, "configured": auth.has_credentials(p.id), "default": p.id == default,
               "auto": routing.has_tiers(p), "tiers": routing.tiers_for(p)}
        if p.kind == "claude":
            st = claude_status()
            row.update(installed=st["installed"], logged_in=st["logged_in"], email=st["email"])
            row["configured"] = st["installed"] and st["logged_in"]
        rows.append(row)
    return rows


def connect_api_key(provider_id: str, key: str) -> str:
    """Validate `key` against the provider and save it. Returns a message;
    raises ValueError with a plain-language reason when it does not work."""
    import anthropic
    import openai

    provider = PROVIDERS.get(provider_id)
    if provider is None:
        raise ValueError(f"unknown provider: {provider_id}")
    if provider.kind == "claude":
        raise ValueError("Claude Code signs in with your Claude account, not an API key")
    key = (key or "").strip().strip("'\"")
    if not key:
        raise ValueError("paste the API key first")
    try:
        make_backend(provider, key).validate()
    except (anthropic.AuthenticationError, openai.AuthenticationError):
        raise ValueError(f"{provider.label} rejected that key. Check it and try again.")
    except (anthropic.APIConnectionError, openai.APIConnectionError):
        raise ValueError("could not reach the API. Check your internet connection and try again.")
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{provider.label} returned an error: {str(exc)[:200]}")
    auth._save_provider(provider_id, {"auth": "api_key", "api_key": key})
    return f"Connected to {provider.label}."


def use_claude() -> str:
    st = claude_status()
    if not st["installed"]:
        raise ValueError("Claude Code is not installed yet")
    if not st["logged_in"]:
        raise ValueError("Claude Code is installed but not signed in yet")
    cfg = auth.load_config()
    if not cfg.get("default_provider"):
        auth.set_default_provider("claude")
    return f"Using your Claude plan{(' (' + st['email'] + ')') if st.get('email') else ''}."


def make_default(provider_id: str) -> None:
    if provider_id in PROVIDERS:
        auth.set_default_provider(provider_id)


# ----------------------------------------------------------------------
# running interactive steps in the user's terminal app
# ----------------------------------------------------------------------

def open_terminal(command: str, title: str = "kcoder setup") -> bool:
    """Run `command` in a new terminal window the user can see. False when
    no terminal app could be opened (the caller shows the command instead)."""
    if sys.platform == "darwin":
        script = f'tell application "Terminal"\n  activate\n  do script {_as_quote(command)}\nend tell'
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=20)
        return r.returncode == 0
    for term in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm"):
        exe = shutil.which(term)
        if exe:
            try:
                subprocess.Popen([exe, "-e", f"bash -lc {shlex.quote(command + '; exec bash')}"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
                return True
            except OSError:
                continue
    return False


def _as_quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def claude_install_command() -> str:
    """Install Claude Code with Anthropic's installer, then sign in."""
    claude = os.path.expanduser("~/.local/bin/claude")
    return (f"clear; echo 'Installing Claude Code...'; curl -fsSL {CLAUDE_INSTALL_URL} | bash && "
            f"echo && echo 'Claude Code is installed. Signing you in: a browser window will open.' && "
            f"{shlex.quote(claude)} auth login; echo; echo 'Done. Go back to the kcoder app and click Check again.'")


def github_status(refresh: bool = False) -> dict:
    return identity.status(refresh=refresh)


def gh_login_command() -> str:
    """Install gh if needed (Homebrew, else the release zip), sign in with the
    browser, and point git's https credentials at that account."""
    arch = "arm64" if os.uname().machine == "arm64" else "amd64"
    install = (
        "if ! command -v gh >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/gh ] && [ ! -x \"$HOME/.local/bin/gh\" ]; then "
        "echo 'Installing the GitHub CLI...'; "
        "if command -v brew >/dev/null 2>&1; then brew install gh; else "
        "mkdir -p \"$HOME/.local/bin\" && cd /tmp && "
        f"URL=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep browser_download_url | grep 'macOS_{arch}.zip' | head -1 | cut -d '\"' -f 4) && "
        "curl -fsSL \"$URL\" -o gh.zip && rm -rf gh-cli && unzip -q -o gh.zip -d gh-cli && cp gh-cli/*/bin/gh \"$HOME/.local/bin/gh\" && chmod +x \"$HOME/.local/bin/gh\"; "
        "fi; fi; "
    )
    pick = "GH=$(command -v gh 2>/dev/null); [ -x \"$GH\" ] || GH=/opt/homebrew/bin/gh; [ -x \"$GH\" ] || GH=\"$HOME/.local/bin/gh\"; "
    return ("clear; echo 'Connecting GitHub: your browser will open to sign in.'; " + install + pick +
            "\"$GH\" auth login --hostname github.com --git-protocol https --web --scopes user:email && \"$GH\" auth setup-git --hostname github.com && "
            "echo && echo 'GitHub connected. Go back to the kcoder app and click Check again.'")


def gh_switch_command() -> str:
    return ("clear; echo 'Switching GitHub account: your browser will open to sign in.'; "
            "gh auth login --hostname github.com --git-protocol https --web --scopes user:email && gh auth setup-git --hostname github.com && "
            "echo && echo 'Done. Go back to the kcoder app and click Check again.'")


def claude_login_command() -> str:
    path = claude_path() or "claude"
    return (f"clear; echo 'Signing in to Claude: a browser window will open.'; {shlex.quote(path)} auth login; "
            f"echo; echo 'Done. Go back to the kcoder app and click Check again.'")
