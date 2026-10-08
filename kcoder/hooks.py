"""Git hooks installed in every kcoder worktree (per-worktree core.hooksPath):

    pre-commit   block when staged changes contain secrets or secret files;
                 with review policy "commit", block until the index tree was
                 approved in the changes view
    pre-push     block when the commits being pushed contain secrets; with
                 review policy "push" (the default), block until the pushed
                 tree was approved in the changes view

Run as `python -m kcoder.hooks <hook> --sid S --data-dir D --root R [--chain DIR]`.
Messages are plain text for whoever ran git (the agent or the user). The
repo's own hooks (DIR) run afterwards when they exist.
"""

from __future__ import annotations

import argparse
import os
import shlex
import stat
import subprocess
import sys


def hooks_dir_for(worktree_path: str) -> str:
    return worktree_path.rstrip("/") + ".hooks"


def install(worktree_path: str, root: str, sid: str, data_dir: str) -> str:
    """Write the hook scripts for one worktree and point its core.hooksPath at them."""
    d = hooks_dir_for(worktree_path)
    os.makedirs(d, exist_ok=True)
    # the repo's own hooks, so they keep running inside kcoder worktrees
    prev = subprocess.run(["git", "-C", root, "config", "--get", "core.hooksPath"], capture_output=True, text=True).stdout.strip()
    chain = os.path.abspath(os.path.join(root, prev)) if prev else os.path.join(root, ".git", "hooks")
    for hook in ("pre-commit", "pre-push"):
        script = (
            "#!/bin/bash\n"
            "# kcoder hook (secret scan + review policy); generated, do not edit\n"
            f"exec {shlex.quote(sys.executable)} -P -m kcoder.hooks {hook} --sid {shlex.quote(sid)} "
            f"--data-dir {shlex.quote(data_dir)} --root {shlex.quote(root)} --chain {shlex.quote(chain)} \"$@\"\n"
        )
        p = os.path.join(d, hook)
        with open(p, "w", encoding="utf-8") as f:
            f.write(script)
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    subprocess.run(["git", "-C", root, "config", "extensions.worktreeConfig", "true"], capture_output=True)
    subprocess.run(["git", "-C", worktree_path, "config", "--worktree", "core.hooksPath", d], capture_output=True)
    return d


def _git(cwd: str, *args: str) -> str:
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True).stdout


def _policy(data_dir: str) -> str:
    from . import config
    pol = config.load().get("review_required", "push")
    return pol if pol in ("push", "commit", "none") else "push"


def _block(title: str, body: str) -> int:
    print(f"\nkcoder: {title}\n{body}\n", file=sys.stderr)
    return 1


def pre_commit(a) -> int:
    from . import secrets as sec
    cwd = os.getcwd()
    staged = _git(cwd, "diff", "--cached", "--name-only", "--diff-filter=ACMR").split()
    findings = []
    for p in staged:
        kind = sec.scan_path(p)
        if kind:
            findings.append({"kind": kind, "path": p, "line": 1, "match": p, "redacted": p, "fingerprint": sec.fingerprint(p)})
    findings += sec.scan_diff(_git(cwd, "diff", "--cached", "-U0", "--diff-filter=ACMR"))
    findings = sec.filter_allowed(findings, cwd)
    if findings:
        return _block("commit blocked: this commit would add secrets",
                      sec.describe(findings) + f"\nRemove them (or add an entry to {sec.ALLOWLIST_REL} for a false positive) and commit again.")
    if _policy(a.data_dir) == "commit" and not os.environ.get("KCODER_SKIP_REVIEW"):
        from . import review
        tree = _git(cwd, "write-tree").strip()
        if not review.is_approved(a.sid, a.data_dir, tree):
            return _block("commit blocked: review required before commit",
                          "Open this session's changes view in kcoder, accept or reject each hunk, and approve; then commit again.\n"
                          "(review_required in ~/.config/kcoder/config.json: push | commit | none)")
    return 0


def pre_push(a, stdin_text: str) -> int:
    from . import secrets as sec
    cwd = os.getcwd()
    ranges = []
    for line in stdin_text.splitlines():
        parts = line.split()
        if len(parts) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = parts
        if set(local_sha) == {"0"}:
            continue   # a delete
        if set(remote_sha) == {"0"}:
            remotes = _git(cwd, "for-each-ref", "--format=%(objectname)", "refs/remotes/").split()
            ranges.append((local_sha, [local_sha, "--not", *remotes] if remotes else [local_sha]))
        else:
            ranges.append((local_sha, [f"{remote_sha}..{local_sha}"]))
    findings = []
    for _, rng in ranges:
        diff = _git(cwd, "log", "-p", "--format=", "-U0", "--diff-filter=ACMR", *rng)
        findings += sec.scan_diff(diff)
        for p in set(_git(cwd, "log", "--format=", "--name-only", "--diff-filter=ACMR", *rng).split()):
            kind = sec.scan_path(p)
            if kind:
                findings.append({"kind": kind, "path": p, "line": 1, "match": p, "redacted": p, "fingerprint": sec.fingerprint(p)})
    findings = sec.filter_allowed(findings, cwd)
    if findings:
        return _block("push blocked: these commits contain secrets",
                      sec.describe(findings) + "\nRewrite the commits without them (or allowlist a false positive) and push again.")
    if _policy(a.data_dir) == "push" and not os.environ.get("KCODER_SKIP_REVIEW"):
        from . import review
        for sha, _ in ranges:
            tree = _git(cwd, "rev-parse", f"{sha}^{{tree}}").strip()
            if not review.is_approved(a.sid, a.data_dir, tree):
                return _block("push blocked: review required before push",
                              "Open this session's changes view in kcoder, accept or reject each hunk, and approve; then push again.\n"
                              "(review_required in ~/.config/kcoder/config.json: push | commit | none)")
    return 0


def main(argv: list | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m kcoder.hooks")
    p.add_argument("hook", choices=["pre-commit", "pre-push"])
    p.add_argument("--sid", required=True)
    p.add_argument("--data-dir", required=True)
    p.add_argument("--root", required=True)
    p.add_argument("--chain", default=None)
    p.add_argument("rest", nargs="*")
    a = p.parse_args(argv)
    os.environ["KCODER_DATA_DIR"] = a.data_dir     # before kcoder.paths is imported
    stdin_text = sys.stdin.read() if a.hook == "pre-push" and not sys.stdin.isatty() else ""
    try:
        code = pre_commit(a) if a.hook == "pre-commit" else pre_push(a, stdin_text)
    except Exception as exc:  # noqa: BLE001 - never let a hook crash silently
        print(f"\nkcoder: {a.hook} hook failed ({type(exc).__name__}: {exc}); refusing to continue\n", file=sys.stderr)
        return 1
    if code:
        return code
    chained = os.path.join(a.chain, a.hook) if a.chain else None
    if chained and os.path.isfile(chained) and os.access(chained, os.X_OK):
        r = subprocess.run([chained, *a.rest], input=stdin_text, text=True)
        return r.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
