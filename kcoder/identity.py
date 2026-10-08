"""Commit identity: every commit kcoder makes, or an agent makes inside a
kcoder session, is authored and committed as the GitHub account signed into
`gh` on this machine. Never a kcoder or AI identity, never whatever the
machine's global git config happens to say.

Source of truth is gh's active account (~/.config/gh/hosts.yml, `user:`),
resolved to id / name / public email through `gh api user` and cached in
the data dir so it keeps working offline. The email defaults to the
account's GitHub noreply address so commits link to the profile without
exposing a personal address; `commit_email: "public"` in config.json uses
the account's public email instead when it has one.

When nobody is signed in, commits are blocked: kcoder's own git commits
refuse with a plain message, and agent shells get an empty git identity
(git then refuses to commit with "empty ident name") plus a system prompt
note pointing at the Connect GitHub step.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

from . import config, paths

GH_CONFIG_DIR = os.environ.get("GH_CONFIG_DIR") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "gh")
HOSTS_PATH = os.path.join(GH_CONFIG_DIR, "hosts.yml")
CACHE_PATH = os.path.join(paths.DATA_DIR, "identity.json")
HOST = "github.com"
REFRESH_SECONDS = 6 * 3600

BLOCKED_MESSAGE = ("Commits are blocked until GitHub is connected. In kcoder press ⌘K, choose "
                   "\"connect your AI\" and click Connect GitHub (or run `gh auth login` in a terminal).")


class IdentityError(Exception):
    pass


def gh_path() -> str | None:
    found = shutil.which("gh")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", os.path.expanduser("~/.local/bin/gh")):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


# ----------------------------------------------------------------------
# who is signed in (local, instant)
# ----------------------------------------------------------------------

def active_login() -> str | None:
    """The login gh would use for github.com right now, from hosts.yml."""
    try:
        with open(HOSTS_PATH, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    block, in_host, host_indent = [], False, 0
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if not in_host:
            if indent == 0 and line.strip().rstrip(":") == HOST:
                in_host, host_indent = True, indent
            continue
        if indent <= host_indent:
            break
        block.append(line)
    if not block:
        return None
    for line in block:
        m = re.match(r"^\s+user:\s*(\S+)\s*$", line)
        if m:
            return m.group(1).strip("'\"")
    users_at = next((i for i, ln in enumerate(block) if re.match(r"^\s+users:\s*$", ln)), None)
    if users_at is not None:
        for ln in block[users_at + 1:]:
            m = re.match(r"^(\s+)(\S+):\s*$", ln)
            if m:
                return m.group(2).strip("'\"")
    return None


def _hosts_sig():
    try:
        st = os.stat(HOSTS_PATH)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


_mem: dict = {"sig": None, "login": None, "account": None, "at": 0.0}


def _load_cache() -> dict:
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(data: dict) -> None:
    try:
        paths.ensure_data_dir()
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CACHE_PATH)
    except OSError:
        pass


def _gh_json(args: list, timeout: int = 20):
    gh = gh_path()
    if not gh:
        return None
    try:
        out = subprocess.run([gh, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def account(refresh: bool = False) -> dict | None:
    """The signed-in GitHub account: login, id, name, email (public), emails
    (verified, when the token allows), noreply. None when signed out."""
    login = active_login()
    if not login:
        _mem.update(sig=_hosts_sig(), login=None, account=None)
        return None
    sig = _hosts_sig()
    if not refresh and _mem["login"] == login and _mem["sig"] == sig and _mem["account"] \
            and time.time() - _mem["at"] < 60:
        return _mem["account"]
    cache = _load_cache()
    entry = cache.get(login) or {}
    stale = refresh or not entry.get("fetched") or time.time() - float(entry.get("fetched") or 0) > REFRESH_SECONDS
    if stale or not entry.get("id"):
        data = _gh_json(["api", "user"])
        if data and data.get("login"):
            emails = _gh_json(["api", "user/emails"]) or []
            verified = [e.get("email") for e in emails if isinstance(e, dict) and e.get("verified") and e.get("email")]
            entry = {"login": data["login"], "id": data.get("id"), "name": data.get("name") or "",
                     "email": data.get("email") or "", "emails": verified, "fetched": time.time(),
                     "setup_git": entry.get("setup_git", False)}
            cache[login] = entry
            _save_cache(cache)
        elif not entry:
            entry = {"login": login, "id": None, "name": "", "email": "", "emails": [], "fetched": 0, "setup_git": False}
    entry = dict(entry)
    entry["noreply"] = (f"{entry['id']}+{entry['login']}@users.noreply.github.com" if entry.get("id")
                        else f"{entry['login']}@users.noreply.github.com")
    _mem.update(sig=sig, login=login, account=entry, at=time.time())
    return entry


def account_emails(acct: dict | None = None) -> set:
    acct = acct or account()
    if not acct:
        return set()
    out = {acct["noreply"].lower(), f"{acct['login']}@users.noreply.github.com".lower()}
    if acct.get("id"):
        out.add(f"{acct['id']}+{acct['login']}@users.noreply.github.com".lower())
    if acct.get("email"):
        out.add(acct["email"].lower())
    for e in acct.get("emails") or []:
        out.add(str(e).lower())
    return out


# ----------------------------------------------------------------------
# what commits are signed as
# ----------------------------------------------------------------------

def commit_identity() -> dict | None:
    acct = account()
    if not acct:
        return None
    mode = (config.load().get("commit_email") or "noreply").lower()
    email = acct["email"] if mode == "public" and acct.get("email") else acct["noreply"]
    return {"name": acct.get("name") or acct["login"], "email": email, "login": acct["login"],
            "noreply": acct["noreply"], "public_email": acct.get("email") or ""}


def require() -> dict:
    ident = commit_identity()
    if not ident:
        raise IdentityError(BLOCKED_MESSAGE)
    return ident


def trailer() -> str:
    """Extra trailer for kcoder-made commits; empty (the default) means none."""
    t = config.load().get("ai_trailer") or ""
    return str(t).strip()


def with_trailer(message: str) -> str:
    t = trailer()
    return message if not t else message.rstrip("\n") + "\n\n" + t + "\n"


def git_env(base: dict | None = None) -> dict:
    """Environment for anything that may run `git commit`: author and
    committer pinned to the signed-in account, or an empty identity (which
    git refuses with "empty ident name") when nobody is signed in."""
    env = dict(os.environ if base is None else base)
    ident = commit_identity()
    if ident:
        env.update(GIT_AUTHOR_NAME=ident["name"], GIT_AUTHOR_EMAIL=ident["email"],
                   GIT_COMMITTER_NAME=ident["name"], GIT_COMMITTER_EMAIL=ident["email"])
        env["KCODER_GIT_IDENTITY"] = f"{ident['name']} <{ident['email']}>"
        env.pop("KCODER_GIT_BLOCKED", None)
    else:
        env.update(GIT_AUTHOR_NAME="", GIT_AUTHOR_EMAIL="", GIT_COMMITTER_NAME="", GIT_COMMITTER_EMAIL="")
        env["KCODER_GIT_BLOCKED"] = "1"
        env.pop("KCODER_GIT_IDENTITY", None)
    return env


def prompt_note() -> str:
    """Lines for the agent system prompt."""
    ident = commit_identity()
    if ident:
        lines = [f"Git commits are signed as {ident['name']} <{ident['email']}>, the user's GitHub account "
                 "(set through GIT_AUTHOR_* / GIT_COMMITTER_* in your environment). Never override user.name "
                 "or user.email, never use `git -c user.…`, and never commit as an AI or tool identity."]
        if not trailer():
            lines.append("Do not add Co-Authored-By, Generated-by or similar trailers to commit messages.")
        return "\n".join(lines)
    return ("GitHub is not connected on this machine, so git commits are blocked (git will refuse with an empty "
            "identity). Do not work around it. If a commit is needed, stop and tell the user: " + BLOCKED_MESSAGE)


# ----------------------------------------------------------------------
# push credentials
# ----------------------------------------------------------------------

def credential_helper_ready() -> bool:
    try:
        out = subprocess.run(["git", "config", "--global", "--get-all", f"credential.https://{HOST}.helper"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "gh auth git-credential" in (out.stdout or "")


def ensure_credential_helper() -> bool:
    """Make git push over https use gh's token for the active account
    (`gh auth setup-git`). Idempotent; False if it could not be done."""
    gh = gh_path()
    if not gh or not active_login():
        return False
    if credential_helper_ready():
        return True
    try:
        out = subprocess.run([gh, "auth", "setup-git", "--hostname", HOST], capture_output=True, text=True, timeout=20)
        return out.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


# ----------------------------------------------------------------------
# status for the app
# ----------------------------------------------------------------------

def status(refresh: bool = False) -> dict:
    acct = account(refresh=refresh)
    cfg = config.load()
    ident = commit_identity() if acct else None
    return {
        "gh_installed": gh_path() is not None,
        "connected": acct is not None,
        "login": acct["login"] if acct else None,
        "name": (acct.get("name") or "") if acct else "",
        "public_email": (acct.get("email") or "") if acct else "",
        "noreply": acct["noreply"] if acct else None,
        "commit_email": (cfg.get("commit_email") or "noreply"),
        "commit_as": f"{ident['name']} <{ident['email']}>" if ident else None,
        "ai_trailer": cfg.get("ai_trailer") or "",
        "push_ready": credential_helper_ready() if acct else False,
        "blocked_message": None if acct else BLOCKED_MESSAGE,
    }


def matches(author_email: str | None, login: str | None, acct: dict | None = None) -> bool:
    """Does a commit belong to the signed-in account?"""
    acct = acct or account()
    if not acct:
        return False
    if login and login == acct["login"]:
        return True
    return bool(author_email) and author_email.lower() in account_emails(acct)
