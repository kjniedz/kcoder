"""Provider sign-in, credential storage, and first-run setup for kcoder.

Credentials live in ~/.config/kcoder/credentials.json (chmod 600):

    {
      "default_provider": "deepseek",
      "providers": {
        "anthropic": {"auth": "api_key", "api_key": "sk-ant-..."},
        "deepseek":  {"auth": "api_key", "api_key": "sk-..."},
        "custom":    {"auth": "api_key", "api_key": "...",
                      "base_url": "http://localhost:11434/v1", "model": "qwen3:32b"}
      }
    }
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import webbrowser

import anthropic
import openai

from . import ui
from .providers import PROVIDERS, Provider, custom_provider, make_backend

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "kcoder"
)
CREDENTIALS_PATH = os.path.join(CONFIG_DIR, "credentials.json")


# --------------------------------------------------------------------------
# config file
# --------------------------------------------------------------------------

def load_config() -> dict:
    try:
        with open(CREDENTIALS_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"providers": {}}
    # migrate v1 format (single anthropic credential at top level)
    if "auth" in config and "providers" not in config:
        config = {"default_provider": "anthropic", "providers": {"anthropic": config}}
        save_config(config)
    config.setdefault("providers", {})
    return config


def save_config(config: dict) -> None:
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CREDENTIALS_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    os.chmod(CREDENTIALS_PATH, 0o600)


def delete_credentials() -> bool:
    """Remove all saved credentials. Returns True if something was deleted."""
    try:
        os.remove(CREDENTIALS_PATH)
        return True
    except FileNotFoundError:
        return False


def set_default_provider(provider_id: str) -> None:
    config = load_config()
    config["default_provider"] = provider_id
    save_config(config)


def _save_provider(provider_id: str, entry: dict) -> None:
    config = load_config()
    config["providers"][provider_id] = entry
    config.setdefault("default_provider", provider_id)
    save_config(config)


# --------------------------------------------------------------------------
# connecting to a provider
# --------------------------------------------------------------------------

def _resolve_provider(provider_id: str, saved: dict) -> Provider:
    """Build the Provider object, materializing 'custom' from saved config."""
    if provider_id == "custom" and saved.get("base_url"):
        return custom_provider(saved["base_url"], saved.get("model", ""))
    return PROVIDERS[provider_id]


def _prompt_for_key(provider: Provider, console, *, allow_empty: bool = False) -> str | None:
    if provider.key_url:
        console.print(
            f"\nGet a {provider.label} API key here: "
            f"[bold blue underline]{provider.key_url}[/bold blue underline]",
            highlight=False,
        )
        try:
            webbrowser.open(provider.key_url)
            console.print("[dim](opened in your browser)[/dim]")
        except Exception:
            pass
    hint = " (enter for none)" if allow_empty else ""
    key = console.input(
        f"\n[bold]Paste your {provider.label} API key{hint}[/bold] [dim](input hidden)[/dim]: ",
        password=True,
    ).strip().strip("'\"")
    if not key and not allow_empty:
        return None
    return key


def _connect_with_key(provider: Provider, key: str, console, base_url: str | None = None):
    backend = make_backend(provider, key, base_url)
    console.print("[dim]checking credentials...[/dim]")
    try:
        backend.validate()
    except (anthropic.AuthenticationError, openai.AuthenticationError):
        console.print("[red]That key was rejected by the API - try again.[/red]")
        return None
    except (anthropic.APIConnectionError, openai.APIConnectionError):
        console.print("[red]Couldn't reach the API - check your internet connection.[/red]")
        return None
    return backend


def _setup_custom(console):
    """Collect base URL + model + key for any OpenAI-compatible endpoint."""
    console.print(
        "\n[dim]Any OpenAI-compatible /chat/completions endpoint works here "
        "(hosted providers, or local servers like Ollama: http://localhost:11434/v1)[/dim]",
        highlight=False,
    )
    base_url = console.input("[bold]Base URL:[/bold] ").strip().rstrip("/")
    if not base_url:
        console.print("[red]A base URL is required.[/red]")
        return None
    model = console.input("[bold]Model name (e.g. deepseek-chat):[/bold] ").strip()
    if not model:
        console.print("[red]A model name is required.[/red]")
        return None
    provider = custom_provider(base_url, model)
    key = _prompt_for_key(provider, console, allow_empty=True)
    backend = _connect_with_key(provider, key or "EMPTY", console, base_url)
    if backend is None:
        return None
    _save_provider("custom", {
        "auth": "api_key",
        "api_key": key or "EMPTY",
        "base_url": base_url,
        "model": model,
    })
    console.print(f"[green]✓ Connected to {base_url}.[/green]\n")
    return provider, backend


def _ensure_ant_installed(console) -> bool:
    """Make sure the Anthropic CLI (`ant`) is available, offering to install it."""
    if shutil.which("ant"):
        return True

    console.print(
        "\n[yellow]Browser sign-in needs the Anthropic CLI (`ant`), which isn't installed.[/yellow]",
        highlight=False,
    )
    if not shutil.which("brew"):
        console.print(
            "Homebrew isn't available, so kcoder can't install it for you.\n"
            "Install Homebrew (https://brew.sh) and re-run, or pick the API-key option instead.",
            highlight=False,
        )
        return False

    if not ui.confirm(
        console,
        "Install it now with [bold]brew install anthropics/tap/ant[/bold]?",
        yes_label="Yes, install it",
        no_label="No, go back",
    ):
        return False

    console.print("[dim]Installing (this can take a minute)...[/dim]")
    if subprocess.run(["brew", "install", "anthropics/tap/ant"]).returncode != 0:
        console.print("[red]brew install failed - see the output above.[/red]")
        return False

    # macOS Gatekeeper quarantines the downloaded binary; clear the flag so
    # the first `ant` run isn't blocked. Harmless no-op if not quarantined.
    if sys.platform == "darwin":
        prefix = subprocess.run(
            ["brew", "--prefix"], capture_output=True, text=True
        ).stdout.strip()
        if prefix:
            subprocess.run(
                ["xattr", "-d", "com.apple.quarantine", os.path.join(prefix, "bin", "ant")],
                capture_output=True,
            )

    if not shutil.which("ant"):
        console.print("[red]`ant` still isn't on your PATH - open a new terminal and retry.[/red]")
        return False
    console.print("[green]✓ Anthropic CLI installed.[/green]")
    return True


def _setup_anthropic_browser(console):
    if not _ensure_ant_installed(console):
        console.print("[dim]You can pick the API-key option instead.[/dim]")
        return None
    console.print("\n[dim]Launching `ant auth login` - finish the sign-in in your browser...[/dim]")
    if subprocess.run(["ant", "auth", "login"]).returncode != 0:
        console.print("[red]Sign-in did not complete.[/red]")
        return None
    backend = make_backend(PROVIDERS["anthropic"], None)
    try:
        backend.validate()
    except Exception:
        console.print("[red]Signed in, but the credentials didn't work for API calls.[/red]")
        return None
    _save_provider("anthropic", {"auth": "profile"})
    console.print("[green]✓ Connected via your Anthropic account.[/green]\n")
    return backend


def connect(provider_id: str, console, *, interactive: bool = True):
    """Get a working backend for a provider, prompting for setup if needed.

    Returns (provider, backend) or None.
    Priority: provider env var > saved credentials > interactive setup.
    """
    config = load_config()
    saved = config["providers"].get(provider_id, {})
    provider = _resolve_provider(provider_id, saved)

    # 1. environment variable (custom needs a saved base_url for this to apply)
    env_key = os.environ.get(provider.key_env)
    if env_key and (provider.base_url or provider.kind == "anthropic"):
        return provider, make_backend(provider, env_key, saved.get("base_url"))
    if provider_id == "anthropic" and os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return provider, make_backend(provider, None)

    # 2. saved credentials
    if saved.get("auth") == "profile":
        return provider, make_backend(provider, None)
    if saved.get("api_key") and (provider.base_url or provider.kind == "anthropic"):
        return provider, make_backend(provider, saved["api_key"], saved.get("base_url"))

    # 3. interactive setup
    if not interactive or not sys.stdin.isatty():
        console.print(
            f"[red]No credentials for {provider.label}.[/red] "
            f"Set {provider.key_env}, or run kcoder in a terminal to sign in.",
            highlight=False,
        )
        return None

    if provider_id == "custom":
        return _setup_custom(console)

    if provider_id == "anthropic":
        while True:
            choice = ui.select(
                console,
                "Connect to Anthropic",
                ["Paste an API key", "Sign in with your browser"],
            )
            if choice is None:
                return None
            if choice == 1:
                backend = _setup_anthropic_browser(console)
                if backend is not None:
                    return provider, backend
                continue
            break

    for _ in range(3):
        key = _prompt_for_key(provider, console)
        if key is None:
            console.print("[red]Nothing entered.[/red]")
            continue
        backend = _connect_with_key(provider, key, console)
        if backend is not None:
            _save_provider(provider_id, {"auth": "api_key", "api_key": key})
            console.print(
                f"[green]✓ Connected to {provider.label}.[/green] "
                f"[dim]Saved to {CREDENTIALS_PATH}[/dim]\n",
                highlight=False,
            )
            return provider, backend
    console.print("[red]Too many failed attempts.[/red]")
    return None


# --------------------------------------------------------------------------
# pickers
# --------------------------------------------------------------------------

def pick_provider(console, current: str | None = None) -> str | None:
    config = load_config()
    ids = list(PROVIDERS)
    labels = []
    for pid in ids:
        provider = PROVIDERS[pid]
        markers = []
        if os.environ.get(provider.key_env) or pid in config["providers"]:
            markers.append("[green]✓[/green]")
        if pid == current:
            markers.append(f"[dim {ui.ACCENT}](current)[/]")
        suffix = ("  " + " ".join(markers)) if markers else ""
        labels.append(f"{provider.label}{suffix}")
    start = ids.index(current) if current in ids else 0
    choice = ui.select(console, "Providers", labels, index=start)
    return ids[choice] if choice is not None else None


def first_run(console):
    """First-time setup: pick a provider, then connect. Returns (provider, backend) or None."""
    if not sys.stdin.isatty():
        console.print(
            "[red]No credentials found and not running interactively.[/red]\n"
            "Set a provider API key env var (e.g. ANTHROPIC_API_KEY, DEEPSEEK_API_KEY), "
            "or run kcoder in a terminal to do first-time setup.",
            highlight=False,
        )
        return None
    console.print(
        "\n[bold]Welcome! Let's connect kcoder to a model provider.[/bold] [dim](one-time setup)[/dim]",
        highlight=False,
    )
    while True:
        pid = pick_provider(console)
        if pid is None:
            return None
        result = connect(pid, console)
        if result is not None:
            set_default_provider(pid)
            return result
