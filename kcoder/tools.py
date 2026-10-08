"""Tool definitions and executors for kcoder."""

from __future__ import annotations

import os
import subprocess

DEFAULT_BASH_TIMEOUT = int(os.environ.get("KCODER_BASH_TIMEOUT", "120"))

# Tools that mutate state and therefore require user approval
# (unless auto-approve mode is on).
DANGEROUS_TOOLS = {"write_file", "edit_file", "run_bash"}
READ_ONLY_TOOLS = {"read_file", "list_dir"}

TOOLS = [
    {
        "name": "read_file",
        "description": (
            "Read a file from the local filesystem and return its contents. "
            "Call this before editing a file so you know its exact contents."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file (absolute, or relative to the current working directory).",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": (
            "Create or overwrite a file with the given content. "
            "Parent directories are created automatically. "
            "Use edit_file instead when changing part of an existing file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path of the file to write.",
                },
                "content": {
                    "type": "string",
                    "description": "Full content to write to the file.",
                },
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Replace an exact string in a file with a new string. "
            "old_str must appear exactly once in the file; include enough "
            "surrounding context to make it unique. Read the file first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path of the file to edit.",
                },
                "old_str": {
                    "type": "string",
                    "description": "Exact text to find (must be unique in the file).",
                },
                "new_str": {
                    "type": "string",
                    "description": "Text to replace old_str with.",
                },
            },
            "required": ["path", "old_str", "new_str"],
        },
    },
    {
        "name": "list_dir",
        "description": "List the contents of a directory. Directories are marked with a trailing slash.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory to list. Defaults to the current working directory.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "run_bash",
        "description": (
            "Execute a shell command and return its stdout, stderr, and exit code. "
            "Runs in the current working directory. Use for builds, tests, git, "
            "searching, and anything else the other tools don't cover."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to run.",
                },
                "timeout": {
                    "type": "integer",
                    "description": f"Timeout in seconds (default {DEFAULT_BASH_TIMEOUT}).",
                },
            },
            "required": ["command"],
        },
    },
]


def resolve(path: str, cwd: str) -> str:
    """Expand ~ and resolve a relative path against the session's cwd."""
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


def read_file(path: str, cwd: str = ".") -> str:
    with open(resolve(path, cwd), "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    if not content:
        return "(file is empty)"
    return content


def _inside(path: str, scope: str | None) -> None:
    """Refuse writes outside the session's worktree."""
    if not scope:
        return
    real = os.path.realpath(path)
    root = os.path.realpath(scope)
    if real != root and not real.startswith(root + os.sep):
        raise ValueError(f"refusing to write outside this session's worktree ({scope}): {path}")


def write_file(path: str, content: str, cwd: str = ".", scope: str | None = None) -> str:
    path = resolve(path, cwd)
    _inside(path, scope)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return f"Wrote {len(content)} bytes to {path}"


def edit_file(path: str, old_str: str, new_str: str, cwd: str = ".", scope: str | None = None) -> str:
    path = resolve(path, cwd)
    _inside(path, scope)
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    count = content.count(old_str)
    if count == 0:
        raise ValueError(f"old_str not found in {path}")
    if count > 1:
        raise ValueError(
            f"old_str appears {count} times in {path}; "
            "include more surrounding context to make it unique"
        )
    with open(path, "w", encoding="utf-8") as f:
        f.write(content.replace(old_str, new_str, 1))
    return f"Edited {path}"


def list_dir(path: str = ".", cwd: str = ".") -> str:
    path = resolve(path, cwd)
    entries = sorted(os.listdir(path))
    if not entries:
        return "(directory is empty)"
    lines = []
    for name in entries:
        if os.path.isdir(os.path.join(path, name)):
            lines.append(name + "/")
        else:
            lines.append(name)
    return "\n".join(lines)


MAX_OUTPUT = 200_000


def run_bash(command: str, timeout: int = DEFAULT_BASH_TIMEOUT, cwd: str = ".",
             on_output=None, proc_slot=None, env: dict | None = None) -> str:
    """Run a shell command, streaming combined output through `on_output`
    (if given) while it runs. `proc_slot` (any object) gets a `.proc`
    attribute so the caller can kill a runaway command."""
    import time

    try:
        if env is None:
            from . import identity
            env = identity.git_env()
        proc = subprocess.Popen(
            command, shell=True, cwd=cwd, stdin=subprocess.DEVNULL, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )
    except OSError as exc:
        return f"Error: {exc}"
    if proc_slot is not None:
        proc_slot.proc = proc
    chunks: list[bytes] = []
    total = 0
    deadline = time.monotonic() + (timeout or DEFAULT_BASH_TIMEOUT)
    timed_out = False
    killed = False
    import select as _select
    fd = proc.stdout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            ready, _, _ = _select.select([fd], [], [], min(0.5, remaining))
            if ready:
                data = os.read(fd.fileno(), 65536)
                if not data:
                    break
                total += len(data)
                if total <= MAX_OUTPUT:
                    chunks.append(data)
                if on_output is not None:
                    try:
                        on_output(data.decode("utf-8", "replace"))
                    except Exception:  # noqa: BLE001
                        pass
            elif proc.poll() is not None:
                # drain anything left
                rest = fd.read()
                if rest:
                    chunks.append(rest)
                break
            if proc_slot is not None and getattr(proc_slot, "kill_requested", False):
                killed = True
                break
    finally:
        if timed_out or killed:
            try:
                os.killpg(proc.pid, 9)
            except (ProcessLookupError, PermissionError):
                proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if proc_slot is not None:
            proc_slot.proc = None
            proc_slot.kill_requested = False
    output = b"".join(chunks).decode("utf-8", "replace").rstrip("\n")
    if total > MAX_OUTPUT:
        output += f"\n… output truncated ({total:,} bytes)"
    parts = []
    if output:
        parts.append(output)
    if timed_out:
        parts.append(f"[error: command timed out after {timeout}s and was killed]")
    elif killed:
        parts.append("[killed by the user]")
    parts.append(f"[exit code: {proc.returncode}]")
    return "\n".join(parts)


def describe_tool_call(name: str, tool_input: dict) -> str:
    """One-line human-readable summary of a tool call, for display/approval."""
    if name == "run_bash":
        return f"run_bash: {tool_input.get('command', '')}"
    if name == "write_file":
        content = tool_input.get("content", "")
        return f"write_file: {tool_input.get('path', '')} ({len(content)} bytes)"
    if name == "edit_file":
        return f"edit_file: {tool_input.get('path', '')}"
    if name == "read_file":
        return f"read_file: {tool_input.get('path', '')}"
    if name == "list_dir":
        return f"list_dir: {tool_input.get('path', '.')}"
    return f"{name}: {tool_input}"


def execute_tool(name: str, tool_input: dict, cwd: str | None = None,
                 on_output=None, proc_slot=None, scope: str | None = None) -> str:
    """Dispatch a tool call against `cwd` (defaults to the process cwd).

    Raises on unknown tool; tool errors propagate.
    """
    cwd = cwd or os.getcwd()
    if name == "read_file":
        return read_file(tool_input["path"], cwd)
    if name == "write_file":
        return write_file(tool_input["path"], tool_input["content"], cwd, scope)
    if name == "edit_file":
        return edit_file(tool_input["path"], tool_input["old_str"], tool_input["new_str"], cwd, scope)
    if name == "list_dir":
        return list_dir(tool_input.get("path", "."), cwd)
    if name == "run_bash":
        return run_bash(
            tool_input["command"],
            timeout=tool_input.get("timeout", DEFAULT_BASH_TIMEOUT),
            cwd=cwd,
            on_output=on_output,
            proc_slot=proc_slot,
        )
    raise ValueError(f"Unknown tool: {name}")
