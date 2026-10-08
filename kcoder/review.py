"""Diff review for a session: everything the session changed relative to the
branch it started from (committed, staged, unstaged and untracked), as a file
list plus unified diff split into hunks. Hunks can be rejected (reverse-
applied in the worktree) or edited; approving records the resulting tree so
the git hooks let a commit or push through.

Review state lives in <session dir>/review.json:
    {"approved": {<tree sha>: ts, ...}, "base": <sha>}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time


class ReviewError(Exception):
    pass


def _git(cwd: str, *args: str, check: bool = True, env: dict | None = None, input_text: str | None = None) -> str:
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, env=env, input=input_text)
    if check and r.returncode != 0:
        raise ReviewError((r.stderr or r.stdout).strip()[-600:] or f"git {' '.join(args)} failed")
    return r.stdout


def _tmp_index(cwd: str) -> dict:
    """An env with a scratch index that contains the whole working tree."""
    fd, idx = tempfile.mkstemp(prefix="kcoder-idx-")
    os.close(fd)
    os.unlink(idx)
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    # start from HEAD so unchanged files are present, then add everything
    _git(cwd, "read-tree", "HEAD", env=env, check=False)
    _git(cwd, "add", "-A", env=env)
    return env


def worktree_tree(cwd: str) -> str:
    """Tree sha of the full working tree (tracked + untracked, honouring .gitignore)."""
    env = _tmp_index(cwd)
    try:
        return _git(cwd, "write-tree", env=env).strip()
    finally:
        try:
            os.unlink(env["GIT_INDEX_FILE"])
        except OSError:
            pass


def base_commit(cwd: str, base_branch: str | None) -> str:
    """Where the session's branch forked from (merge-base with its base branch)."""
    if base_branch:
        mb = _git(cwd, "merge-base", base_branch, "HEAD", check=False).strip()
        if mb:
            return mb
    # no base known: the branch's first commit's parent, else the root
    return _git(cwd, "rev-parse", "HEAD").strip()


def changes(cwd: str, base_branch: str | None) -> dict:
    """{"base", "tree", "files": [...], "diff": str, "hunks": [...]}"""
    base = base_commit(cwd, base_branch)
    env = _tmp_index(cwd)
    try:
        tree = _git(cwd, "write-tree", env=env).strip()
        stat = _git(cwd, "diff", "--cached", "--numstat", "-M", base, env=env)
        names = _git(cwd, "diff", "--cached", "--name-status", "-M", base, env=env)
        diff = _git(cwd, "diff", "--cached", "-M", "--no-color", base, env=env)
    finally:
        try:
            os.unlink(env["GIT_INDEX_FILE"])
        except OSError:
            pass
    status = {}
    for line in names.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            status[parts[-1]] = parts[0][0]
    files = []
    for line in stat.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            add, dele, path = parts[0], parts[1], parts[-1]
            files.append({"path": path, "additions": 0 if add == "-" else int(add), "deletions": 0 if dele == "-" else int(dele),
                          "status": status.get(path, "M"), "binary": add == "-"})
    return {"base": base, "tree": tree, "files": files, "diff": diff[:2_000_000], "hunks": split_hunks(diff)}


def split_hunks(diff: str) -> list:
    """[{"id", "path", "old_path", "header", "text", "new_start", "new_count", "file_header"}]"""
    hunks = []
    file_header: list = []
    path = old_path = ""
    cur = None
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if cur:
                hunks.append(cur)
                cur = None
            file_header = [line]
            m = re.match(r"diff --git a/(.*?) b/(.*?)\n", line)
            old_path, path = (m.group(1), m.group(2)) if m else ("", "")
            continue
        if cur is None and not line.startswith("@@"):
            file_header.append(line)
            continue
        if line.startswith("@@"):
            if cur:
                hunks.append(cur)
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            cur = {"id": len(hunks), "path": path, "old_path": old_path, "header": line.rstrip("\n"), "text": line,
                   "new_start": int(m.group(1)) if m else 0, "new_count": int(m.group(2)) if m and m.group(2) is not None else 1,
                   "file_header": "".join(file_header), "binary": any("Binary files" in h for h in file_header)}
            continue
        if cur is not None:
            cur["text"] += line
    if cur:
        hunks.append(cur)
    return hunks


def reject_hunk(cwd: str, hunk: dict) -> None:
    """Undo one hunk in the working tree (reverse-apply it)."""
    if hunk.get("binary"):
        raise ReviewError("binary changes cannot be rejected hunk by hunk; delete or restore the file instead")
    patch = hunk["file_header"] + hunk["text"]
    r = subprocess.run(["git", "-C", cwd, "apply", "-R", "--recount", "--unidiff-zero", "--whitespace=nowarn", "-"],
                       input=patch, capture_output=True, text=True)
    if r.returncode != 0:
        raise ReviewError("could not reject this hunk: " + (r.stderr or r.stdout).strip()[-400:])


def edit_hunk(cwd: str, hunk: dict, new_text: str) -> None:
    """Replace the hunk's new-side lines in the current file with `new_text`."""
    path = os.path.join(cwd, hunk["path"])
    if not os.path.isfile(path):
        raise ReviewError(f"{hunk['path']} does not exist in the worktree")
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        lines = f.read().splitlines(keepends=True)
    start = max(0, hunk["new_start"] - 1)
    count = hunk["new_count"]
    if hunk["new_count"] == 0:
        start = hunk["new_start"]   # a pure deletion: insert after this line
    new_lines = new_text.splitlines(keepends=True)
    if new_lines and not new_lines[-1].endswith("\n") and (start + count) < len(lines):
        new_lines[-1] += "\n"
    lines[start:start + count] = new_lines
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write("".join(lines))


# ----------------------------------------------------------------------
# approval state (read by the hooks without the daemon)
# ----------------------------------------------------------------------

def _state_path(session_dir: str) -> str:
    return os.path.join(session_dir, "review.json")


def load_state(session_dir: str) -> dict:
    try:
        with open(_state_path(session_dir), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def approve(session_dir: str, cwd: str, base: str | None = None) -> str:
    """Record the current working tree as reviewed. Returns its tree sha."""
    tree = worktree_tree(cwd)
    state = load_state(session_dir)
    approved = dict(state.get("approved") or {})
    approved[tree] = time.time()
    # keep the last few trees (the user may approve, commit, approve again)
    for k in sorted(approved, key=approved.get)[:-8]:
        approved.pop(k, None)
    state["approved"] = approved
    if base:
        state["base"] = base
    os.makedirs(session_dir, exist_ok=True)
    with open(_state_path(session_dir), "w", encoding="utf-8") as f:
        json.dump(state, f)
    return tree


def is_approved(sid: str, data_dir: str, tree: str) -> bool:
    sdir = os.path.join(data_dir, "sessions", sid)
    return tree in (load_state(sdir).get("approved") or {})


def approved_now(session_dir: str, cwd: str) -> bool:
    """Is the current working tree one of the approved trees?"""
    try:
        return worktree_tree(cwd) in (load_state(session_dir).get("approved") or {})
    except ReviewError:
        return False
