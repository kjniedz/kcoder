"""Connector approvals: Claude Code's PreToolUse hook for MCP tools.

Claude Code runs `python -m kcoder.permit --sid <sid> --data-dir <dir>` before
every `mcp__*` tool call (kcoder passes the hook in `--settings`). Reads run by
themselves. Anything that sends or changes (an email, a calendar event, a Drive
file, a Linear issue, a paid generation) waits for an approval in kcoder: the
pane, the inbox, the phone. The hook answers allow or deny; a deny tells the
model why so it can ask in chat instead of retrying blindly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

CONNECTOR_WAIT_SECONDS = int(os.environ.get("KCODER_CONNECTOR_WAIT") or 480)   # inside the hook's 600s timeout

# first word of the tool name (after mcp__<server>__) that only reads
READ_VERBS = {
    "get", "list", "search", "read", "fetch", "find", "query", "describe", "show", "lookup", "look", "check",
    "count", "download", "export", "preview", "browse", "view", "extract", "status", "summarize", "summarise",
    "balance", "transactions", "history", "resolve", "info", "whoami", "me", "models", "jobs", "apps", "ls",
    "cat", "head", "tail", "open", "watch", "poll", "wait", "estimate", "quote", "validate", "verify", "test",
}
# whole tool names (after the server prefix) that only read, when the first word is ambiguous
READ_TOOLS = {"job_display", "jobs_wait", "apps_describe", "apps_search", "media_confirm", "show_result", "guide"}

# input keys worth showing in the approval, in order of interest
SHOW_KEYS = ("to", "cc", "bcc", "recipient", "recipients", "attendees", "subject", "title", "summary", "name",
             "start", "end", "when", "date", "body", "content", "text", "message", "description", "prompt",
             "file", "filename", "path", "folder", "id", "issue", "team", "state", "query", "url", "amount")


def split_tool(tool_name: str) -> tuple[str, str]:
    """'mcp__claude_ai_Gmail__send_email' -> ('claude_ai_Gmail', 'send_email')."""
    m = re.match(r"^mcp__(.+?)__(.+)$", tool_name or "")
    return (m.group(1), m.group(2)) if m else ("", tool_name or "")


def server_label(server: str) -> str:
    s = server.replace("claude_ai_", "").replace("plugin_", "").replace("_", " ").strip()
    return s or "connector"


def classify(tool_name: str) -> str:
    """'read' when the tool only looks at things; 'write' (ask first) for
    anything else, including tools we have never seen."""
    _, tool = split_tool(tool_name)
    t = tool.lower()
    if t in READ_TOOLS:
        return "read"
    first = re.split(r"[_\-]", t, 1)[0]
    return "read" if first in READ_VERBS else "write"


def _short(v, n: int = 90) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def describe(tool_name: str, tool_input) -> str:
    """One line a person can approve on: 'Gmail · send_email: to=k@x.com, subject=…'."""
    server, tool = split_tool(tool_name)
    head = f"{server_label(server)} · {tool}"
    if not isinstance(tool_input, dict) or not tool_input:
        return head
    parts = []
    keys = [k for k in SHOW_KEYS if k in tool_input] + [k for k in tool_input if k not in SHOW_KEYS]
    for k in keys[:6]:
        v = tool_input.get(k)
        if v in (None, "", [], {}):
            continue
        parts.append(f"{k}={_short(v)}")
    return (head + ": " + ", ".join(parts))[:600] if parts else head


def grant_key(tool_name: str, tool_input) -> str:
    """Stable id for 'this exact call', so a late approval covers the retry."""
    raw = tool_name + "\n" + json.dumps(tool_input, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def decision(kind: str, reason: str = "") -> str:
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": kind}}
    if reason:
        out["hookSpecificOutput"]["permissionDecisionReason"] = reason[:500]
    return json.dumps(out)


def decide(a, hook_input: dict) -> str | None:
    """The decision JSON for one hook call, or None to stay silent (= Claude Code's own rules apply)."""
    if hook_input.get("hook_event_name") not in (None, "PreToolUse"):
        return None
    tool_name = str(hook_input.get("tool_name") or "")
    if not tool_name.startswith("mcp__"):
        return None
    if classify(tool_name) == "read":
        return decision("allow")
    from . import config
    if config.load().get("connector_approvals", True) is False:
        return decision("allow")
    tool_input = hook_input.get("tool_input") or {}
    desc = describe(tool_name, tool_input)
    from .hooks import ask_daemon
    reply = ask_daemon(a.sid, {"type": "review_wait", "kind": "connector", "name": tool_name, "key": grant_key(tool_name, tool_input),
                               "description": desc, "wait": CONNECTOR_WAIT_SECONDS, "input": tool_input if len(json.dumps(tool_input, default=str)) < 20000 else {}},
                       CONNECTOR_WAIT_SECONDS)
    if reply is None:
        return decision("deny", "kcoder could not be reached, and this connector action needs the user's approval. Tell the user what you wanted to do and ask them to do it or approve it.")
    if reply.get("approved"):
        return decision("allow")
    if reply.get("pending"):
        return decision("deny", f"The user has not answered kcoder's approval request for this action yet ({desc}). Do not retry on your own: tell the user it is waiting in the kcoder inbox and continue with other work. When they approve it, kcoder will tell you to do it again.")
    return decision("deny", "The user declined this action in kcoder" + (f": {reply.get('reason')}" if reply.get("reason") else "") + ". Do not retry it; ask what they would like instead.")


def main(argv: list | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m kcoder.permit")
    p.add_argument("--sid", required=True)
    p.add_argument("--data-dir", required=True)
    a = p.parse_args(argv)
    os.environ["KCODER_DATA_DIR"] = a.data_dir     # before kcoder.paths is imported
    try:
        hook_input = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0
    try:
        out = decide(a, hook_input)
    except Exception as exc:  # noqa: BLE001 - never let a hook crash into an unreviewed write
        out = decision("deny", f"kcoder's connector check failed ({exc}); ask the user to do this by hand.") if str(hook_input.get("tool_name") or "").startswith("mcp__") else None
    if out:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
