"""Git worktrees per session, plus merge / PR / discard and status."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time

from . import identity, paths

WORKTREES_DIR = os.path.join(paths.DATA_DIR, "worktrees")


class GitError(Exception):
    pass


def _git(cwd: str, *args, check: bool = True, timeout: int = 120, env: dict | None = None) -> str:
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitError(f"git {' '.join(args)}: {exc}")
    if check and out.returncode != 0:
        raise GitError((out.stderr or out.stdout).strip() or f"git {' '.join(args)} failed")
    return out.stdout


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "session"


def create_worktree(root: str, name: str, start: str | None = None) -> dict:
    """A new worktree + branch kcoder/<name> for a session. `start` is the
    commit or branch to branch from (default: the repo's HEAD); forks pass
    the parent session's branch so they begin with the same files."""
    root = os.path.abspath(root)
    slug = _slug(name)
    branch = f"kcoder/{slug}"
    repo_key = f"{os.path.basename(root.rstrip('/'))}-{hashlib.sha1(root.encode()).hexdigest()[:6]}"
    path = os.path.join(WORKTREES_DIR, repo_key, slug)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        if os.path.exists(os.path.join(path, ".git")):
            raise GitError(f"worktree path already exists: {path}")
        shutil.rmtree(path, ignore_errors=True)    # a stale, unregistered leftover
        _git(root, "worktree", "prune", check=False)
    if not _git(root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip():
        raise GitError("the repository has no commits yet; make one first")
    base = _git(root, "rev-parse", "--abbrev-ref", "HEAD").strip() or "HEAD"
    if _git(root, "rev-parse", "--verify", "--quiet", branch, check=False).strip():
        _git(root, "worktree", "add", path, branch)
    else:
        _git(root, "worktree", "add", "-b", branch, path, start or "HEAD")
    return {"path": path, "branch": branch, "root": root, "base": base, "created": time.time()}


def is_attached(info: dict) -> bool:
    """True if the worktree directory exists and is registered with git."""
    path = info.get("path")
    return bool(path and os.path.exists(os.path.join(path, ".git")))


def checkpoint(path: str, message: str) -> str | None:
    """Commit uncommitted work (as the signed-in account). None when clean."""
    return commit_all(path, message)


def detach_worktree(info: dict) -> dict:
    """Archive-time cleanup: keep the branch (with any uncommitted work
    committed as a checkpoint), remove the directory. Raises GitError when
    work could not be committed, in which case the worktree is left alone."""
    path, root = info.get("path"), info.get("root")
    if not is_attached(info):
        return {**info, "detached": True}
    committed = checkpoint(path, f"kcoder: checkpoint before archiving {info.get('branch')}")
    out = subprocess.run(["git", "-C", root, "worktree", "remove", "--force", path], capture_output=True, text=True)
    if out.returncode != 0 and os.path.isdir(path):
        raise GitError("could not remove worktree: " + (out.stderr or out.stdout).strip()[-300:])
    _git(root, "worktree", "prune", check=False)
    return {**info, "detached": True, "checkpoint": committed}


def reattach_worktree(info: dict) -> dict:
    """Resume-time: recreate the worktree directory from the session branch."""
    if is_attached(info):
        return {**info, "detached": False}
    root, path, branch = info["root"], info["path"], info["branch"]
    if not os.path.isdir(root):
        raise GitError(f"project {root} no longer exists")
    if not _git(root, "rev-parse", "--verify", "--quiet", branch, check=False).strip():
        raise GitError(f"branch {branch} no longer exists")
    if os.path.exists(path):
        shutil.rmtree(path, ignore_errors=True)
    _git(root, "worktree", "prune", check=False)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _git(root, "worktree", "add", path, branch)
    out = dict(info)
    out.pop("detached", None)
    return out


def remove_worktree(info: dict, delete_branch: bool = False) -> None:
    root, path, branch = info.get("root"), info.get("path"), info.get("branch")
    if root and path and os.path.isdir(path):
        _git(root, "worktree", "remove", "--force", path, check=False)
    if path and os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    if root:
        _git(root, "worktree", "prune", check=False)
        if delete_branch and branch:
            _git(root, "branch", "-D", branch, check=False)


def status(cwd: str) -> dict:
    branch = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip() or "?"
    porcelain = _git(cwd, "status", "--porcelain=v1", check=False)
    lines = [ln for ln in porcelain.splitlines() if ln.strip()]
    ahead = behind = 0
    ab = _git(cwd, "rev-list", "--left-right", "--count", "@{upstream}...HEAD", check=False).strip()
    if ab and "\t" in ab:
        b, a = ab.split("\t")
        ahead, behind = int(a), int(b)
    diffstat = _git(cwd, "diff", "--stat", "HEAD", check=False).strip()
    last = _git(cwd, "log", "-1", "--format=%h %s", check=False).strip()
    return {
        "branch": branch, "dirty": len(lines), "ahead": ahead, "behind": behind,
        "status": porcelain.strip(), "diffstat": diffstat[-4000:], "last_commit": last,
        "text": f"{branch}: {len(lines)} changed file(s)" + (f", {ahead} ahead" if ahead else ""),
    }


def pull(cwd: str) -> str:
    """Fast-forward the checkout from its upstream. Refuses when there are
    uncommitted changes or no upstream, so nothing is ever lost."""
    if not _git(cwd, "remote", check=False).strip():
        raise GitError("no git remote configured")
    if _git(cwd, "status", "--porcelain", check=False).strip():
        raise GitError("uncommitted changes; commit or discard them before pulling")
    before = _git(cwd, "rev-parse", "HEAD", check=False).strip()
    upstream = _git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}", check=False).strip()
    if not upstream:
        branch = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
        raise GitError(f"branch {branch} has no upstream to pull from")
    _git(cwd, "pull", "--ff-only", timeout=300)
    after = _git(cwd, "rev-parse", "HEAD", check=False).strip()
    if before == after:
        return f"already up to date with {upstream}"
    n = _git(cwd, "rev-list", "--count", f"{before}..{after}", check=False).strip() or "?"
    return f"pulled {n} commit(s) from {upstream} ({after[:7]})"


def commit_all(cwd: str, message: str) -> str | None:
    """Stage and commit everything. Returns the short hash or None if clean."""
    if not _git(cwd, "status", "--porcelain", check=False).strip():
        return None
    try:
        identity.require()          # commits are signed as the signed-in GitHub account, or not at all
    except identity.IdentityError as exc:
        raise GitError(str(exc))
    _git(cwd, "add", "-A")
    _git(cwd, "commit", "-q", "-m", identity.with_trailer(message), env=identity.git_env())
    return _git(cwd, "rev-parse", "--short", "HEAD").strip()


def merge_into_root(info: dict, message: str | None = None) -> str:
    root, branch, path = info["root"], info["branch"], info["path"]
    committed = commit_all(path, message or f"kcoder: work from session on {branch}")
    if _git(root, "status", "--porcelain", check=False).strip():
        raise GitError("the main checkout has uncommitted changes; commit or stash them first")
    try:
        identity.require()
    except identity.IdentityError as exc:
        raise GitError(str(exc))
    out = subprocess.run(["git", "-C", root, "merge", "--no-ff", "--no-edit", branch], capture_output=True, text=True,
                         env=identity.git_env())
    if out.returncode != 0:
        _git(root, "merge", "--abort", check=False)
        raise GitError("merge conflict - aborted. Resolve by merging " + branch + " manually.\n" + (out.stdout + out.stderr).strip()[-1500:])
    head = _git(root, "rev-parse", "--short", "HEAD").strip()
    return f"merged {branch} into {_git(root, 'rev-parse', '--abbrev-ref', 'HEAD').strip()} ({head})" + (f", committed {committed} first" if committed else "")


def open_pr(info: dict, title: str | None = None, body: str | None = None) -> dict:
    path, branch = info["path"], info["branch"]
    committed = commit_all(path, title or f"kcoder: work on {branch}")
    if not _git(path, "remote", check=False).strip():
        raise GitError("no git remote configured; add one (or use merge instead)")
    identity.ensure_credential_helper()   # push with the signed-in account's token
    _git(path, "push", "-u", "origin", branch, timeout=300, env=identity.git_env())
    if not shutil.which("gh"):
        return {"url": None, "message": f"pushed {branch}; install the gh CLI to open PRs automatically", "committed": committed}
    args = ["gh", "pr", "create", "--head", branch]
    if title:
        args += ["--title", title, "--body", body or ""]
    else:
        args += ["--fill"]
    out = subprocess.run(args, cwd=path, capture_output=True, text=True, timeout=120)
    text = (out.stdout + out.stderr).strip()
    m = re.search(r"https://\S+/pull/\d+", text)
    if out.returncode != 0 and not m:
        raise GitError(text[-1500:] or "gh pr create failed")
    return {"url": m.group(0) if m else None, "message": text[-500:], "committed": committed}


def handle_request(manager, session, t: str, req: dict) -> dict:
    from .errors import RequestError

    info = session.meta.get("worktree")
    cwd = session.engine.cwd
    try:
        if t == "git":
            st = status(cwd)
            manager._record(session, {"t": "git", "ts": time.time(), **st, "status": "", "diffstat": ""})
            return {"git": st}
        if t == "pull":
            if session.engine.busy:
                raise RequestError("the session is working; pull when it is idle")
            msg = pull(cwd)
            manager._record(session, {"t": "git", "ts": time.time(), "text": msg})
            return {"ok": True, "message": msg}
        if t == "commit":
            h = commit_all(cwd, req.get("message") or "kcoder: checkpoint")
            manager._record(session, {"t": "git", "ts": time.time(), "text": f"committed {h}" if h else "nothing to commit"})
            return {"commit": h}
        if not info:
            raise RequestError("this session has no worktree (start it with worktree enabled)")
        if t == "merge":
            msg = merge_into_root(info, req.get("message"))
            manager._record(session, {"t": "git", "ts": time.time(), "text": msg})
            return {"ok": True, "message": msg}
        if t == "pr":
            r = open_pr(info, req.get("title"), req.get("body"))
            manager._record(session, {"t": "git", "ts": time.time(), "text": r.get("url") or r.get("message")})
            return r
        if t == "discard":
            if session.engine.busy:
                session.engine.interrupt()
            remove_worktree(info, delete_branch=True)
            session.meta.pop("worktree", None)
            session.engine.cwd = info["root"]
            session.meta["cwd"] = info["root"]
            session.save_meta()
            manager._record(session, {"t": "git", "ts": time.time(), "text": f"discarded {info['branch']}; cwd is now {info['root']}"})
            manager.broadcast_sessions()
            return {"ok": True}
    except GitError as exc:
        raise RequestError(str(exc))
    raise RequestError(f"unknown request type: {t}")
