"""Checkpoints: before every turn, snapshot the session worktree (as a git
tree, kept alive by a ref under refs/kcoder/<sid>/) together with the
conversation position. "Undo to here" restores both. Restores only ever
touch files inside the session's worktree.

<session dir>/checkpoints.jsonl: one line per checkpoint
    {"n", "ts", "turn", "tree", "head", "messages", "seq"}
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time

MAX_CHECKPOINTS = 60


class CheckpointError(Exception):
    pass


def _git(cwd: str, *args: str, check: bool = True, env: dict | None = None) -> str:
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, env=env, timeout=120)
    if check and r.returncode != 0:
        raise CheckpointError((r.stderr or r.stdout).strip()[-500:] or f"git {' '.join(args)} failed")
    return r.stdout


def _path(session_dir: str) -> str:
    return os.path.join(session_dir, "checkpoints.jsonl")


def load(session_dir: str) -> list:
    out = []
    try:
        with open(_path(session_dir), "r", encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return out


def _save(session_dir: str, items: list) -> None:
    os.makedirs(session_dir, exist_ok=True)
    tmp = _path(session_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    os.replace(tmp, _path(session_dir))


def snapshot(cwd: str, sid: str, session_dir: str, *, turn: int, messages: int, seq: int) -> dict:
    """Snapshot the working tree of `cwd` (a git worktree) before user turn `turn`."""
    fd, idx = tempfile.mkstemp(prefix="kcoder-cp-")
    os.close(fd)
    os.unlink(idx)
    env = dict(os.environ, GIT_INDEX_FILE=idx,
               GIT_AUTHOR_NAME="kcoder checkpoint", GIT_AUTHOR_EMAIL="checkpoint@kcoder.invalid",
               GIT_COMMITTER_NAME="kcoder checkpoint", GIT_COMMITTER_EMAIL="checkpoint@kcoder.invalid")
    try:
        _git(cwd, "read-tree", "HEAD", env=env, check=False)
        _git(cwd, "add", "-A", env=env)
        tree = _git(cwd, "write-tree", env=env).strip()
    finally:
        try:
            os.unlink(idx)
        except OSError:
            pass
    head = _git(cwd, "rev-parse", "HEAD", check=False).strip() or None
    items = load(session_dir)
    n = (items[-1]["n"] + 1) if items else 1
    # a dangling tree would be garbage-collected; hang it off a hidden ref
    commit = _git(cwd, "commit-tree", tree, "-m", f"kcoder checkpoint {n} for session {sid}", env=env).strip()
    _git(cwd, "update-ref", f"refs/kcoder/{sid}/{n}", commit)
    item = {"n": n, "ts": time.time(), "turn": turn, "tree": tree, "head": head, "messages": messages, "seq": seq}
    items.append(item)
    if len(items) > MAX_CHECKPOINTS:
        for old in items[:-MAX_CHECKPOINTS]:
            _git(cwd, "update-ref", "-d", f"refs/kcoder/{sid}/{old['n']}", check=False)
        items = items[-MAX_CHECKPOINTS:]
    _save(session_dir, items)
    return item


def restore(cwd: str, item: dict) -> None:
    """Make the worktree identical to the checkpoint's tree. Files outside
    `cwd` are never touched; HEAD moves back to the checkpoint's commit when
    that commit is still an ancestor (the agent's later commits are undone)."""
    cwd = os.path.realpath(cwd)
    top = os.path.realpath(_git(cwd, "rev-parse", "--show-toplevel").strip())
    if top != cwd:
        raise CheckpointError(f"{cwd} is not the top of a worktree")
    head = item.get("head")
    if head and _git(cwd, "cat-file", "-e", head, check=False) == "" and \
            subprocess.run(["git", "-C", cwd, "merge-base", "--is-ancestor", head, "HEAD"], capture_output=True).returncode == 0:
        _git(cwd, "reset", "--soft", head)
    # stage everything (so new files are known), then reset index + files to the tree
    _git(cwd, "add", "-A")
    _git(cwd, "read-tree", "--reset", "-u", item["tree"])
    _git(cwd, "reset", "-q")        # unstage: the working tree now equals the tree, index matches HEAD
    _git(cwd, "clean", "-fd", "-q", check=False)   # leftovers that were never in the tree


def drop_after(session_dir: str, cwd: str, sid: str, n: int) -> list:
    """Forget checkpoints newer than n (after an undo)."""
    items = load(session_dir)
    keep = [it for it in items if it["n"] <= n]
    for it in items:
        if it["n"] > n:
            _git(cwd, "update-ref", "-d", f"refs/kcoder/{sid}/{it['n']}", check=False)
    _save(session_dir, keep)
    return keep


def remove_all(cwd: str | None, sid: str) -> None:
    if not cwd or not os.path.isdir(cwd):
        return
    refs = _git(cwd, "for-each-ref", "--format=%(refname)", f"refs/kcoder/{sid}/", check=False).split()
    for ref in refs:
        _git(cwd, "update-ref", "-d", ref, check=False)
