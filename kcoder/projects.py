"""Projects: a project is a git repo or a plain folder. Every chat belongs to
one. Also finds the project's KCODER.md instructions and lists its files."""

from __future__ import annotations

import fnmatch
import hashlib
import os
import subprocess

INSTRUCTIONS_FILES = ("KCODER.md", "kcoder.md", ".kcoder.md")
AGENT_FILES = ("AGENTS.md", "CLAUDE.md")     # read as well, so existing repos just work
IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
                ".pytest_cache", "dist", "build", ".next", ".idea", ".vscode", "target",
                ".tox", ".eggs", "coverage", ".cache"}
MAX_FILES = 8000


def git_toplevel(path: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", path, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def project_root(cwd: str) -> str:
    """The git repo root containing cwd, or cwd itself."""
    cwd = os.path.abspath(os.path.expanduser(cwd))
    return git_toplevel(cwd) or cwd


def project_id(root: str) -> str:
    return hashlib.sha1(os.path.abspath(root).encode()).hexdigest()[:10]


def project_info(root: str) -> dict:
    root = os.path.abspath(root)
    return {
        "id": project_id(root),
        "path": root,
        "name": os.path.basename(root.rstrip("/")) or root,
        "git": git_toplevel(root) == root,
        "has_instructions": bool(instruction_files(root)),
    }


def instructions_path(root: str) -> str | None:
    for name in INSTRUCTIONS_FILES:
        p = os.path.join(root, name)
        if os.path.isfile(p):
            return p
    return None


def instruction_files(root: str) -> list:
    """Every instruction file this project has: the KCODER.md variant plus
    AGENTS.md / CLAUDE.md when present."""
    out = []
    p = instructions_path(root)
    if p:
        out.append(p)
    for name in AGENT_FILES:
        q = os.path.join(root, name)
        if os.path.isfile(q):
            out.append(q)
    return out


def load_instructions(root: str, cwd: str | None = None, limit: int = 40_000, skip: tuple = ()) -> str:
    """Instruction file contents for a project (and, if different, for the
    cwd). `skip` names files the provider already reads itself (Claude Code
    loads CLAUDE.md on its own)."""
    parts = []
    seen = set()
    for base in (root, cwd):
        if not base:
            continue
        for p in instruction_files(base):
            if p in seen or os.path.basename(p) in skip:
                continue
            seen.add(p)
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read(limit)
            except OSError:
                continue
            parts.append(f"<!-- {p} -->\n{text.strip()}")
    return "\n\n".join(parts)


def _gitignore_patterns(root: str) -> list:
    pats = []
    try:
        with open(os.path.join(root, ".gitignore"), "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("!"):
                    continue
                pats.append(line.rstrip("/"))
    except OSError:
        pass
    return pats


def list_files(root: str, limit: int = MAX_FILES) -> list:
    """Relative paths of project files (for @-references), skipping vendored
    and ignored directories."""
    root = os.path.abspath(root)
    pats = _gitignore_patterns(root)
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in IGNORED_DIRS and not d.startswith(".")
            and not any(fnmatch.fnmatch(d, p) or fnmatch.fnmatch(os.path.join(rel_dir, d), p) for p in pats)
        )
        for name in sorted(filenames):
            if name.startswith(".") and name not in (".env.example", ".gitignore"):
                continue
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            if any(fnmatch.fnmatch(name, p) or fnmatch.fnmatch(rel, p) for p in pats):
                continue
            out.append(rel)
            if len(out) >= limit:
                return out
    return out


def fuzzy_filter(paths: list, query: str, limit: int = 30) -> list:
    """Subsequence fuzzy match, best matches first."""
    q = query.lower()
    if not q:
        return paths[:limit]
    scored = []
    for p in paths:
        s = _fuzzy_score(p.lower(), q)
        if s is not None:
            scored.append((s, p))
    scored.sort()
    return [p for _, p in scored[:limit]]


def _fuzzy_score(text: str, q: str):
    if q in text:
        # contiguous match: prefer matches in the file name and shorter paths
        base = os.path.basename(text)
        return (0 if q in base else 1, len(text) - len(q), text.find(q))
    i = 0
    gaps = 0
    last = -1
    for ch in q:
        j = text.find(ch, i)
        if j < 0:
            return None
        if last >= 0:
            gaps += j - last - 1
        last = j
        i = j + 1
    return (2, gaps, len(text))
