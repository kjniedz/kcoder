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


def write_file(path: str, content: str, cwd: str = ".") -> str:
    path = resolve(path, cwd)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return f"Wrote {len(content)} bytes to {path}"


def edit_file(path: str, old_str: str, new_str: str, cwd: str = ".") -> str:
    path = resolve(path, cwd)
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


def run_bash(command: str, timeout: int = DEFAULT_BASH_TIMEOUT, cwd: str = ".") -> str:
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {timeout}s"
    parts = []
    if result.stdout:
        parts.append(result.stdout.rstrip("\n"))
    if result.stderr:
        parts.append(f"[stderr]\n{result.stderr.rstrip(chr(10))}")
    parts.append(f"[exit code: {result.returncode}]")
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


def execute_tool(name: str, tool_input: dict, cwd: str | None = None) -> str:
    """Dispatch a tool call against `cwd` (defaults to the process cwd).

    Raises on unknown tool; tool errors propagate.
    """
    cwd = cwd or os.getcwd()
    if name == "read_file":
        return read_file(tool_input["path"], cwd)
    if name == "write_file":
        return write_file(tool_input["path"], tool_input["content"], cwd)
    if name == "edit_file":
        return edit_file(tool_input["path"], tool_input["old_str"], tool_input["new_str"], cwd)
    if name == "list_dir":
        return list_dir(tool_input.get("path", "."), cwd)
    if name == "run_bash":
        return run_bash(
            tool_input["command"],
            timeout=tool_input.get("timeout", DEFAULT_BASH_TIMEOUT),
            cwd=cwd,
        )
    raise ValueError(f"Unknown tool: {name}")
