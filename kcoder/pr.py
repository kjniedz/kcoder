"""One-click pull requests: commit, check review + secrets (the hooks do that
on push), push, open a draft PR as the signed-in GitHub user with a
description written from the session's work and diff, then keep its CI
status fresh for the pane header."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

from . import chatlog, identity, review
from .worktree import GitError, _git, commit_all

TEST_CMD = re.compile(r"\b(pytest|npm (?:run )?test|yarn test|pnpm test|go test|cargo test|make test|rspec|phpunit|mvn test|gradle test|jest|vitest|tox|ruff|eslint|mypy|tsc)\b")


def _user_prompts(messages: list) -> list:
    out = []
    for m in messages:
        if m.get("role") == "user" and chatlog.is_user_turn(m):
            t = chatlog.user_text(m).strip()
            if t and not t.startswith("[Context was compacted"):
                out.append(t)
    return out


def _tests_run(events: list) -> list:
    """(command, ok) for test-like commands the session ran."""
    calls = {}
    out = []
    for e in events:
        if e.get("t") == "tool_call":
            cmd = (e.get("input") or {}).get("command") or (e.get("input") or {}).get("cmd") or ""
            if isinstance(cmd, str) and TEST_CMD.search(cmd):
                calls[e.get("id")] = cmd.strip()
        elif e.get("t") == "tool_result" and e.get("id") in calls:
            out.append((calls.pop(e["id"]), not e.get("is_error")))
    return out


def build_description(session_meta: dict, messages: list, events: list, changes: dict, commits: list) -> str:
    """Deterministic PR body: what changed, why, how it was tested."""
    files = changes.get("files") or []
    adds = sum(f["additions"] for f in files)
    dels = sum(f["deletions"] for f in files)
    lines = ["## What changed", ""]
    if commits:
        lines += [f"- {c}" for c in commits[:30]]
        lines.append("")
    lines.append(f"{len(files)} file(s) changed, +{adds} / -{dels}:")
    lines.append("")
    for f in files[:60]:
        lines.append(f"- `{f['path']}` ({f['status']}, +{f['additions']}/-{f['deletions']})")
    if len(files) > 60:
        lines.append(f"- … and {len(files) - 60} more")
    lines += ["", "## Why", ""]
    prompts = _user_prompts(messages)
    if prompts:
        for p in prompts[:5]:
            p = p.strip().replace("\r", "")
            lines.append("> " + p[:800].replace("\n", "\n> "))
            lines.append("")
    else:
        lines += ["(no task text recorded)", ""]
    lines += ["## How it was tested", ""]
    tests = _tests_run(events)
    if tests:
        for cmd, ok in tests[-10:]:
            lines.append(f"- `{cmd[:160]}` {'passed' if ok else 'failed'}")
    else:
        lines.append("No test commands were run in this session.")
    lines += ["", f"---", f"Opened from kcoder session `{session_meta.get('name')}` on branch `{(session_meta.get('worktree') or {}).get('branch', '')}`."]
    return "\n".join(lines)


def model_summary(session, title_hint: str, deterministic: str, diff: str, timeout: float = 120.0) -> str | None:
    """Ask the session's model for a short PR title + description from the
    diff and the deterministic facts. Returns 'title\\n\\nbody' or None."""
    from .engine import _CaptureHooks
    from .providers import make_backend
    from . import auth
    resolved = auth.resolve_backend(session.meta["provider"])
    if resolved is None:
        return None
    provider, backend = resolved
    prompt = (
        "Write a pull request title and description for the change below. Format exactly:\n"
        "TITLE: <one line, under 70 chars>\n\n<markdown body with sections '## What changed', '## Why', '## How it was tested'>\n\n"
        "Base it only on the facts given; do not invent tests that were not run. Keep it concise.\n\n"
        f"Facts gathered by kcoder:\n{deterministic[:6000]}\n\nDiff (may be truncated):\n```diff\n{diff[:60000]}\n```"
    )
    hooks = _CaptureHooks()
    hooks.cwd = session.engine.cwd
    hooks.trust = "read"
    try:
        backend.run_turn([{"role": "user", "content": prompt}], session.engine.model, "", hooks)
    except Exception:  # noqa: BLE001
        return None
    text = hooks.text.strip()
    if "TITLE:" not in text:
        return None
    return text


def open_pr(manager, session, info: dict, title: str | None = None, body: str | None = None, draft: bool = True) -> dict:
    from . import config
    path, branch = info["path"], info["branch"]
    sdir = session.dir
    # 1. commit whatever is uncommitted (the pre-commit hook scans for secrets)
    committed = commit_all(path, title or f"kcoder: work on {branch}")
    # 2. review policy
    policy = config.load().get("review_required", "push")
    if policy in ("push", "commit") and not review.approved_now(sdir, path):
        raise GitError("review required before opening a PR: open this session's changes view, accept or reject each hunk, and approve")
    if not _git(path, "remote", check=False).strip():
        raise GitError("no git remote configured; add one (or use merge instead)")
    # 3. description
    ch = review.changes(path, info.get("base"))
    commits = [c for c in _git(path, "log", "--format=%s", f"{ch['base']}..HEAD", check=False).splitlines() if c.strip()]
    events = session.all_events()
    deterministic = build_description(session.meta, session.engine.messages, events, ch, commits)
    if not body:
        body = deterministic
        if not session.engine.busy:
            summary = model_summary(session, title or "", deterministic, ch["diff"])
            if summary:
                first, _, rest = summary.partition("\n")
                if not title:
                    title = first.replace("TITLE:", "").strip()[:70]
                body = rest.strip() + "\n\n---\n" + deterministic.split("---")[-1].strip()
    if not title:
        title = (session.meta.get("title") or f"kcoder: {branch}")[:70]
    # 4. push (pre-push hook: secrets + review) and open the PR as the signed-in account
    identity.ensure_credential_helper()
    env = identity.git_env()
    r = subprocess.run(["git", "-C", path, "push", "-u", "origin", branch], capture_output=True, text=True, timeout=300, env=env)
    if r.returncode != 0:
        raise GitError((r.stderr or r.stdout).strip()[-1500:] or "push failed")
    if not shutil.which("gh"):
        return {"url": None, "message": f"pushed {branch}; install the gh CLI to open PRs automatically", "committed": committed}
    args = ["gh", "pr", "create", "--head", branch, "--title", title, "--body", body]
    if draft:
        args.append("--draft")
    out = subprocess.run(args, cwd=path, capture_output=True, text=True, timeout=120)
    text = (out.stdout + out.stderr).strip()
    m = re.search(r"https://\S+/pull/\d+", text)
    if out.returncode != 0 and not m:
        if "already exists" in text:
            m = re.search(r"https://\S+/pull/\d+", text)
        if not m:
            raise GitError(text[-1500:] or "gh pr create failed")
    url = m.group(0) if m else None
    pr = {"url": url, "number": int(url.rsplit("/", 1)[1]) if url else None, "draft": draft, "title": title,
          "state": "OPEN", "checks": "none", "updated": time.time()}
    session.meta["pr"] = pr
    session.save_meta()
    return {"url": url, "message": text[-500:], "committed": committed, "pr": pr}


def refresh_status(pr: dict, cwd: str) -> dict | None:
    """Current state + CI rollup of a PR via gh. None when gh is unavailable."""
    if not shutil.which("gh") or not pr.get("url"):
        return None
    r = subprocess.run(["gh", "pr", "view", pr["url"], "--json", "state,isDraft,statusCheckRollup,mergeable,title,url,number"],
                       cwd=cwd if os.path.isdir(cwd) else None, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return None
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    rollup = d.get("statusCheckRollup") or []
    states = {str(c.get("conclusion") or c.get("state") or "").upper() for c in rollup}
    if not rollup:
        checks = "none"
    elif states & {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}:
        checks = "failure"
    elif states - {"SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"}:
        checks = "pending"
    else:
        checks = "success"
    return {**pr, "state": d.get("state") or pr.get("state"), "draft": bool(d.get("isDraft")), "checks": checks,
            "mergeable": d.get("mergeable"), "title": d.get("title") or pr.get("title"), "updated": time.time(),
            "checks_total": len(rollup)}
