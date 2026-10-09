"""Filesystem locations used by kcoder (config + daemon data).

    ~/.config/kcoder/credentials.json      provider credentials (chmod 600)
    ~/.local/share/kcoder/token            daemon auth token (chmod 600)
    ~/.local/share/kcoder/kcoderd.sock     daemon Unix socket (user-only)
    ~/.local/share/kcoder/updates/         downloaded + verified releases
    ~/.local/share/kcoder/ui-state.json    window layout, synced from the app
    ~/.local/share/kcoder/daemon.json      host/port/pid of the running daemon
    ~/.local/share/kcoder/daemon.log       daemon log
    ~/.local/share/kcoder/usage.jsonl      one line per model call (fleet stats)
    ~/.local/share/kcoder/sessions/<id>/   meta.json, messages.json, events.jsonl

Override the data root with KCODER_DATA_DIR.
"""

from __future__ import annotations

import os

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "kcoder"
)
CREDENTIALS_PATH = os.path.join(CONFIG_DIR, "credentials.json")

DATA_DIR = os.environ.get("KCODER_DATA_DIR") or os.path.join(
    os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "kcoder"
)
SESSIONS_DIR = os.path.join(DATA_DIR, "sessions")
TOKEN_PATH = os.path.join(DATA_DIR, "token")
DAEMON_INFO_PATH = os.path.join(DATA_DIR, "daemon.json")
DAEMON_LOG_PATH = os.path.join(DATA_DIR, "daemon.log")
USAGE_LOG_PATH = os.path.join(DATA_DIR, "usage.jsonl")
SOCKET_PATH = os.environ.get("KCODER_SOCKET") or os.path.join(DATA_DIR, "kcoderd.sock")
UPDATES_DIR = os.path.join(DATA_DIR, "updates")
UPDATE_LOG_PATH = os.path.join(DATA_DIR, "update.log")
UI_STATE_PATH = os.path.join(DATA_DIR, "ui-state.json")
PLAN_LIMITS_PATH = os.path.join(DATA_DIR, "plan-limits.json")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("KCODER_PORT", "47321"))


def ensure_data_dir() -> None:
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    try:
        os.chmod(DATA_DIR, 0o700)
    except OSError:
        pass
