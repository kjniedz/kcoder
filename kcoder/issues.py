"""GitHub issues as tasks.

Paste an issue URL (https://github.com/owner/name/issues/123, or owner/name#123)
as a task, or as a session's first message: kcoder fetches the issue (gh when
signed in, the public API otherwise), writes the task from its title, body and
labels, remembers the issue on the session, and when the session opens a PR
the description starts with "Closes #123" and the issue gets a comment with
the PR link. GitHub closes the issue when the PR merges.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import urllib.request

ISSUE_URL = re.compile(r"https?://github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)\b")
ISSUE_SHORT = re.compile(r"(?<![\w/])([\w.-]+)/([\w.-]+)#(\d+)\b")


def find(text: str) -> dict | None:
    """The first issue reference in `text`: {spec, number, url}."""
    m = ISSUE_URL.search(text or "") or ISSUE_SHORT.search(text or "")
    if not m:
        return None
    spec = f"{m.group(1)}/{m.group(2)}"
    n = int(m.group(3))
    return {"spec": spec, "number": n, "url": f"https://github.com/{spec}/issues/{n}"}


def fetch(spec: str, number: int, timeout: float = 20.0) -> dict:
    """{number, title, body, labels, url, state} via gh, falling back to the public API."""
    if shutil.which("gh"):
        r = subprocess.run(["gh", "issue", "view", str(number), "--repo", spec, "--json", "number,title,body,labels,url,state"],
                           capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0 and r.stdout.strip():
            d = json.loads(r.stdout)
            return {"number": d.get("number", number), "title": d.get("title") or "", "body": d.get("body") or "",
                    "labels": [l.get("name") for l in d.get("labels") or [] if l.get("name")], "url": d.get("url") or f"https://github.com/{spec}/issues/{number}",
                    "state": (d.get("state") or "").lower(), "spec": spec}
        err = (r.stderr or r.stdout).strip()
    else:
        err = "gh is not installed"
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{spec}/issues/{number}", headers={"Accept": "application/vnd.github+json", "User-Agent": "kcoder"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        return {"number": d.get("number", number), "title": d.get("title") or "", "body": d.get("body") or "",
                "labels": [l.get("name") for l in d.get("labels") or [] if l.get("name")], "url": d.get("html_url") or f"https://github.com/{spec}/issues/{number}",
                "state": (d.get("state") or "").lower(), "spec": spec}
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"could not read issue {spec}#{number}: {err or exc}")


def task_text(issue: dict, extra: str = "") -> str:
    """The task a session gets for an issue."""
    lines = [f"Work on GitHub issue #{issue['number']} in {issue['spec']}: {issue['title']}", "", f"Issue: {issue['url']}"]
    if issue.get("labels"):
        lines.append("Labels: " + ", ".join(issue["labels"]))
    body = (issue.get("body") or "").strip()
    if body:
        lines += ["", "--- issue text ---", body[:12000], "--- end ---"]
    if extra.strip():
        lines += ["", extra.strip()]
    lines += ["", "Read the code first, make the smallest change that resolves the issue, run the tests, and commit. "
              f"kcoder's PR for this session will say \"Closes #{issue['number']}\" and link back to the issue."]
    return "\n".join(lines)


def expand(text: str, repo: str | None) -> tuple[str, str | None, dict | None]:
    """If `text` names an issue: (task text, repo or the issue's repo spec, issue info)."""
    ref = find(text)
    if not ref:
        return text, repo, None
    issue = fetch(ref["spec"], ref["number"])
    rest = ISSUE_URL.sub("", text, count=1) if ISSUE_URL.search(text) else ISSUE_SHORT.sub("", text, count=1)
    return task_text(issue, rest), repo or ref["spec"], {"spec": issue["spec"], "number": issue["number"], "url": issue["url"], "title": issue["title"]}


def pr_fields(issue: dict, repo_spec: str | None, title: str | None, body: str) -> tuple[str | None, str]:
    """PR title and body for a session that works on an issue."""
    same = (repo_spec or "").lower() == (issue.get("spec") or "").lower()
    ref = f"#{issue['number']}" if same else f"{issue['spec']}#{issue['number']}"
    t = title or f"{issue.get('title') or 'Fix'} ({ref})"[:70]
    return t, f"Closes {ref}\n\n{body}"


def comment(issue: dict, pr_url: str, timeout: float = 30.0) -> bool:
    """Tell the issue about the PR (needs gh signed in)."""
    if not shutil.which("gh") or not pr_url:
        return False
    r = subprocess.run(["gh", "issue", "comment", str(issue["number"]), "--repo", issue["spec"], "--body",
                        f"kcoder opened {pr_url} for this issue."], capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0
