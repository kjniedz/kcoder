"""Finding projects to work on: local git repos near home, and GitHub repos
via the gh CLI (cloned on demand into the projects directory)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

from . import config, identity

SEARCH_ROOTS = ["~", "~/Desktop", "~/Documents", "~/projects", "~/Projects", "~/code", "~/src",
                "~/dev", "~/repos", "~/work", "~/github", "~/kcoder-projects"]
SKIP = {"Library", "Applications", "Music", "Movies", "Pictures", "node_modules", ".Trash"}


def projects_dir() -> str:
    d = config.load().get("projects_dir") or "~/kcoder-projects"
    return os.path.abspath(os.path.expanduser(d))


def local_repos(max_depth: int = 2, limit: int = 200) -> list:
    """Git repos found up to `max_depth` below the usual places."""
    found: dict[str, dict] = {}
    roots = [os.path.expanduser(r) for r in SEARCH_ROOTS]
    roots.append(projects_dir())
    for root in roots:
        if not os.path.isdir(root):
            continue
        _walk(root, 0, max_depth, found, limit)
    out = list(found.values())
    out.sort(key=lambda r: -r["mtime"])
    return out[:limit]


def _walk(path: str, depth: int, max_depth: int, found: dict, limit: int) -> None:
    if len(found) >= limit:
        return
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name)
    except OSError:
        return
    for e in entries:
        if not e.is_dir(follow_symlinks=False) or e.name.startswith(".") or e.name in SKIP:
            continue
        full = e.path
        if os.path.isdir(os.path.join(full, ".git")):
            if full not in found:
                try:
                    mtime = os.stat(os.path.join(full, ".git")).st_mtime
                except OSError:
                    mtime = 0
                found[full] = {"path": full, "name": e.name, "mtime": mtime, "remote": _remote(full)}
            continue
        if depth + 1 < max_depth:
            _walk(full, depth + 1, max_depth, found, limit)


def _remote(path: str) -> str:
    try:
        out = subprocess.run(["git", "-C", path, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=2)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def github_repos(limit: int = 100) -> list:
    if not shutil.which("gh"):
        return []
    try:
        out = subprocess.run(
            ["gh", "repo", "list", "--json", "nameWithOwner,url,updatedAt,isPrivate,description", "-L", str(limit)],
            capture_output=True, text=True, timeout=20,
        )
        if out.returncode != 0:
            return []
        rows = json.loads(out.stdout or "[]")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []
    local = {r["remote"]: r["path"] for r in local_repos() if r.get("remote")}
    result = []
    for r in rows:
        spec = r.get("nameWithOwner", "")
        path = _find_clone(spec, local)
        result.append({"spec": spec, "url": r.get("url"), "updated": r.get("updatedAt"),
                       "private": r.get("isPrivate"), "description": r.get("description") or "", "path": path})
    return result


def _find_clone(spec: str, local_by_remote: dict) -> str | None:
    for remote, path in local_by_remote.items():
        if _normalise(remote) == spec.lower():
            return path
    candidate = os.path.join(projects_dir(), spec.split("/")[-1])
    return candidate if os.path.isdir(os.path.join(candidate, ".git")) else None


def _normalise(remote: str) -> str:
    m = re.search(r"github\.com[:/]([^/]+/[^/\s]+?)(?:\.git)?/?$", remote or "")
    return m.group(1).lower() if m else ""


GITHUB_SPEC = re.compile(r"^(?:https?://github\.com/|git@github\.com:)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")


def parse_spec(text: str) -> str | None:
    """'owner/name', a GitHub URL, or a git@ URL -> 'owner/name'."""
    text = (text or "").strip()
    if not text or os.path.exists(os.path.expanduser(text)) or text.startswith(("/", "~", ".")):
        return None
    m = GITHUB_SPEC.match(text)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def clone(spec: str, dest_dir: str | None = None) -> str:
    """Clone owner/name into the projects dir (or reuse an existing clone)."""
    spec = parse_spec(spec) or spec
    dest_dir = dest_dir or projects_dir()
    os.makedirs(dest_dir, exist_ok=True)
    existing = _find_clone(spec, {r["remote"]: r["path"] for r in local_repos() if r.get("remote")})
    if existing:
        return existing
    path = os.path.join(dest_dir, spec.split("/")[-1])
    if os.path.isdir(path):
        if os.path.isdir(os.path.join(path, ".git")):
            return path
        raise RuntimeError(f"{path} exists and is not a git repo")
    if shutil.which("gh"):
        cmd = ["gh", "repo", "clone", spec, path]
    else:
        cmd = ["git", "clone", f"https://github.com/{spec}.git", path]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[-800:] or "clone failed")
    return path


def update(path: str) -> str | None:
    """Best-effort `git pull --ff-only` of an existing clone. Returns a short
    message, or None when nothing was pulled (dirty tree, no upstream,
    offline). Never raises."""
    from . import worktree as wt
    try:
        msg = wt.pull(path)
    except Exception as exc:  # noqa: BLE001
        return f"not pulled: {str(exc).splitlines()[0][:200]}" if str(exc) else None
    return None if msg.startswith("already up to date") else msg


# ----------------------------------------------------------------------
# publishing local folders to GitHub
# ----------------------------------------------------------------------

DEFAULT_GITIGNORE = ".env\n.env.*\n!.env.example\nnode_modules/\n__pycache__/\n*.pyc\n.DS_Store\n.venv/\ndist/\nbuild/\n"
_NO_PUBLISH = {"", "/", os.path.expanduser("~")} | {
    os.path.expanduser(f"~/{d}") for d in ("Desktop", "Documents", "Downloads", "Library", "Applications")
}


def github_spec(path: str) -> str | None:
    """'owner/name' of the origin remote when it points at GitHub, else None."""
    return _normalise(_remote(path)) or None


def _git(path: str, *args: str, timeout: int = 60):
    return subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=timeout)


def init_repo(path: str) -> None:
    """Make `path` a git repo with at least one commit. No-op when it already is."""
    path = os.path.abspath(os.path.expanduser(path))
    if path in _NO_PUBLISH:
        raise RuntimeError(f"refusing to publish {path}: pick a project folder, not a top-level one")
    top = _git(path, "rev-parse", "--show-toplevel")
    if top.returncode == 0:
        if os.path.realpath(top.stdout.strip()) != os.path.realpath(path):
            raise RuntimeError(f"{path} is inside the git repo {top.stdout.strip()}")
    else:
        r = _git(path, "init", "-b", "main")
        if r.returncode != 0:
            r = _git(path, "init")
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip()[-400:] or "git init failed")
    if _git(path, "rev-parse", "--verify", "HEAD").returncode == 0:
        return
    try:
        identity.require()
    except identity.IdentityError as exc:
        raise RuntimeError(str(exc))
    gi = os.path.join(path, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w", encoding="utf-8") as f:
            f.write(DEFAULT_GITIGNORE)
    _git(path, "add", "-A")
    r = subprocess.run(["git", "-C", path, "commit", "-q", "-m", identity.with_trailer("Initial commit")],
                       capture_output=True, text=True, timeout=120, env=identity.git_env())
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-400:] or "initial commit failed (empty folder?)")


def publish(path: str, private: bool = True) -> str:
    """Ensure `path` is a git repo with a GitHub origin, creating the repo with
    `gh` and pushing when there is none. Returns 'owner/name'."""
    path = os.path.abspath(os.path.expanduser(path))
    if not shutil.which("gh"):
        raise RuntimeError("the gh CLI is not installed")
    try:
        identity.require()
    except identity.IdentityError as exc:
        raise RuntimeError(str(exc))
    identity.ensure_credential_helper()
    init_repo(path)
    remote = _remote(path)
    if remote:
        spec = _normalise(remote)
        if spec:
            return spec
        raise RuntimeError(f"origin is not a GitHub remote: {remote}")
    base = re.sub(r"[^\w.-]+", "-", os.path.basename(path.rstrip("/"))).strip("-.") or "project"
    last = ""
    for attempt in range(4):
        name = base if attempt == 0 else f"{base}-{attempt + 1}"
        cmd = ["gh", "repo", "create", name, "--private" if private else "--public",
               "--source", path, "--remote", "origin", "--push"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env=identity.git_env())
        if out.returncode == 0:
            break
        last = (out.stderr or out.stdout).strip()[-600:]
        if "already exists" not in last.lower():
            raise RuntimeError(last or "gh repo create failed")
        _git(path, "remote", "remove", "origin")   # gh may have added it before the push failed
    else:
        raise RuntimeError(last or "gh repo create failed")
    spec = github_spec(path)
    if not spec:
        raise RuntimeError("repo created but no GitHub origin was configured")
    return spec
