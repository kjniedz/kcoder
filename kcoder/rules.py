"""Per-repo rules in plain English, enforced as checks.

Any bullet line in KCODER.md (or AGENTS.md / CLAUDE.md) that reads like one
of these becomes a check, not just advice:

    - never touch migrations                   protect:  no write, edit, commit or push of matching files
    - do not change src/legacy/ or *.lock
    - only change files under src/ and tests/  only:     writes outside these paths are refused
    - never commit .env files                  nocommit: matching files cannot be staged in a commit
    - never run git push --force               norun:    shell commands containing this are refused
    - do not run rm -rf
    - run the tests before committing          before-commit:  the command runs in the pre-commit hook;
    - run npm run lint before pushing          before-push:    a failure blocks the commit / push
    - always run make check before committing

Every other line stays advice for the model. "the tests" is resolved to the
repo's test command (npm test, pytest, go test, cargo test, make test).

Checks run in three places: the built-in tool loop (write_file / edit_file /
run_bash), Claude Code's PreToolUse hook (Edit / Write / MultiEdit /
NotebookEdit / Bash, see kcoder.permit) and the git hooks of every worktree
(pre-commit, pre-push, see kcoder.hooks). Each refusal names the rule and the
file so the agent can explain instead of retrying.
"""

from __future__ import annotations

import fnmatch
import os
import re
import shlex
import subprocess

from . import projects

PROTECT = "protect"
ONLY = "only"
NOCOMMIT = "nocommit"
NORUN = "norun"
BEFORE_COMMIT = "before-commit"
BEFORE_PUSH = "before-push"

_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
_NEVER = r"(?:never|do not|don't|do n't|must not|mustn't|no one may|nobody may)"
_RULES = [
    (PROTECT, re.compile(_NEVER + r"\s+(?:touch|change|modify|edit|rewrite|alter|write to)\s+(?:the\s+)?(.+?)\.?$", re.I)),
    (NOCOMMIT, re.compile(_NEVER + r"\s+(?:commit|stage|check in|add)\s+(?:the\s+)?(.+?)\.?$", re.I)),
    (NORUN, re.compile(_NEVER + r"\s+(?:run|execute|use|call)\s+(?:the\s+)?(?:command\s+)?(.+?)\.?$", re.I)),
    (ONLY, re.compile(r"^only\s+(?:touch|change|modify|edit|write to|write)\s+(?:files\s+)?(?:under|in|inside|within)\s+(.+?)\.?$", re.I)),
    (BEFORE_COMMIT, re.compile(r"^(?:always\s+)?run\s+(.+?)\s+before\s+(?:every\s+|each\s+|any\s+|a\s+)?commit(?:ting|s)?\.?$", re.I)),
    (BEFORE_PUSH, re.compile(r"^(?:always\s+)?run\s+(.+?)\s+before\s+(?:every\s+|each\s+|any\s+|a\s+)?push(?:ing|es)?\.?$", re.I)),
]
_FILLER = re.compile(r"\b(?:files?|folders?|directory|directories|dirs?|anything|everything|under|in|inside|within)\b", re.I)


def _targets(text: str) -> list:
    """'migrations, `*.lock` or the vendor/ folder' -> ['migrations', '*.lock', 'vendor/']."""
    out = []
    for part in re.split(r"\s*(?:,|;|\bor\b|\band\b)\s*", text):
        part = _FILLER.sub(" ", part).strip(" `'\"")
        part = part.strip()
        if part and part.lower() not in ("the", "a", "an"):
            out.append(part)
    return out


def parse(text: str, source: str = "") -> list:
    """The enforced rules in one instruction file."""
    rules = []
    for raw in (text or "").splitlines():
        m = _BULLET.match(raw)
        if not m:
            continue
        line = m.group(1).strip().rstrip(".")
        for kind, rx in _RULES:
            mm = rx.match(line)
            if not mm:
                continue
            arg = mm.group(1).strip()
            if kind in (PROTECT, NOCOMMIT, ONLY):
                targets = _targets(arg)
                if not targets:
                    break
                rules.append({"kind": kind, "paths": targets, "text": line, "source": source})
            elif kind == NORUN:
                cmd = arg.strip(" `'\"")
                if cmd:
                    rules.append({"kind": kind, "command": cmd, "text": line, "source": source})
            else:
                cmd = arg.strip(" `'\"")
                rules.append({"kind": kind, "command": cmd, "text": line, "source": source})
            break
    return rules


_cache: dict = {}      # path -> (mtime, size, rules); load() runs on every snapshot and tool call


def load(root: str, cwd: str | None = None) -> list:
    """Rules from every instruction file of the project (and the cwd, when it differs)."""
    rules, seen = [], set()
    for base in (root, cwd):
        if not base:
            continue
        for p in projects.instruction_files(base):
            if p in seen:
                continue
            seen.add(p)
            try:
                st = os.stat(p)
                hit = _cache.get(p)
                if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
                    rules += hit[2]
                    continue
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    parsed = parse(f.read(60_000), os.path.basename(p))
                _cache[p] = (st.st_mtime, st.st_size, parsed)
                rules += parsed
            except OSError:
                continue
    out, seen_rules = [], set()          # the worktree's copy of KCODER.md repeats the root's
    for r in rules:
        key = (r["kind"], r["text"].lower(), r["source"])
        if key not in seen_rules:
            seen_rules.add(key)
            out.append(r)
    return out


# -- paths -----------------------------------------------------------------

def path_matches(pattern: str, rel: str) -> bool:
    """'migrations' matches db/migrations/001.sql; '*.lock' matches any lock
    file; 'src/legacy/' matches everything under it; globs with / match the
    whole relative path."""
    rel = rel.replace(os.sep, "/")
    while rel.startswith("./"):
        rel = rel[2:]
    pat = pattern.replace(os.sep, "/").strip()
    if not pat:
        return False
    base = rel.rsplit("/", 1)[-1]
    parts = rel.split("/")
    if "/" in pat.rstrip("/"):
        p = pat.rstrip("/")
        return rel == p or rel.startswith(p + "/") or fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p + "/*") or fnmatch.fnmatch(rel, p + "/**")
    p = pat.rstrip("/")
    if any(c in p for c in "*?["):
        return fnmatch.fnmatch(base, p) or any(fnmatch.fnmatch(x, p) for x in parts)
    return base == p or p in parts[:-1] or base.startswith(p + ".") or (p.endswith("s") and p[:-1] in parts[:-1])


def _rel(path: str, root: str) -> str:
    try:
        return os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    except ValueError:
        return path


def check_write(rules: list, path: str, root: str) -> str | None:
    """The reason a write to `path` is refused, or None."""
    rel = _rel(path, root)
    if rel.startswith(".."):
        return None
    for r in rules:
        if r["kind"] == PROTECT and any(path_matches(p, rel) for p in r["paths"]):
            return f"Rule in {r['source']}: \"{r['text']}\". {rel} matches, so it stays untouched; explain what you would change there and ask the user."
    only = [r for r in rules if r["kind"] == ONLY]
    if only and not any(path_matches(p, rel) for r in only for p in r["paths"]):
        r = only[0]
        return f"Rule in {r['source']}: \"{r['text']}\". {rel} is outside, so it stays untouched; explain what you would change there and ask the user."
    return None


def check_command(rules: list, command: str) -> str | None:
    """The reason a shell command is refused, or None."""
    flat = " ".join(command.split()).lower()
    for r in rules:
        if r["kind"] != NORUN:
            continue
        needle = " ".join(r["command"].split()).lower()
        if needle and (needle in flat or re.search(r"(^|[\s;&|])" + re.escape(needle) + r"(\s|$)", flat)):
            return f"Rule in {r['source']}: \"{r['text']}\". Not run; tell the user what you wanted to do."
    return None


def check_commit_paths(rules: list, paths: list) -> str | None:
    """Staged / pushed files against protect and never-commit rules."""
    hits = []
    only = [r for r in rules if r["kind"] == ONLY]
    for rel in paths:
        hit = next((r for r in rules if r["kind"] in (PROTECT, NOCOMMIT) and any(path_matches(p, rel) for p in r["paths"])), None)
        if hit is None and only and not any(path_matches(p, rel) for r in only for p in r["paths"]):
            hit = only[0]
        if hit is not None:
            hits.append(f"  {rel}  ({hit['source']}: {hit['text']})")
    if hits:
        return "files this repo's rules keep out of commits:\n" + "\n".join(hits[:20]) + ("\n  …" if len(hits) > 20 else "")
    return None


# -- commands before commit / push -------------------------------------------

def test_command(root: str) -> str | None:
    """What 'the tests' means in this repo."""
    def has(*names):
        return any(os.path.exists(os.path.join(root, n)) for n in names)
    if has("package.json"):
        try:
            import json
            with open(os.path.join(root, "package.json"), "r", encoding="utf-8") as f:
                if "test" in (json.load(f).get("scripts") or {}):
                    return "npm test"
        except (OSError, ValueError):
            pass
    if has("pytest.ini", "conftest.py", "tests", "test") or (has("pyproject.toml") and "pytest" in open(os.path.join(root, "pyproject.toml"), encoding="utf-8", errors="replace").read()):
        return "python3 -m pytest -q" if os.name != "nt" else "python -m pytest -q"
    if has("go.mod"):
        return "go test ./..."
    if has("Cargo.toml"):
        return "cargo test"
    if has("Makefile") and re.search(r"^test:", open(os.path.join(root, "Makefile"), encoding="utf-8", errors="replace").read(), re.M):
        return "make test"
    if has("Gemfile"):
        return "bundle exec rspec" if has("spec") else "bundle exec rake test"
    return None


def resolve_command(rule: dict, root: str) -> str | None:
    cmd = rule.get("command") or ""
    if re.fullmatch(r"(?:the\s+)?(?:unit\s+)?tests?(?:\s+suite)?", cmd, re.I):
        return test_command(root)
    return cmd or None


def run_before(rules: list, kind: str, cwd: str, timeout: int = 1800) -> str | None:
    """Run every before-commit / before-push command; the block message on the first failure."""
    for r in rules:
        if r["kind"] != kind:
            continue
        cmd = resolve_command(r, cwd)
        if not cmd:
            return (f"rule \"{r['text']}\" ({r['source']}): kcoder could not tell which command runs the tests here. "
                    f"Write the command in the rule, for example \"run npm test before committing\".")
        try:
            p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, errors="replace", timeout=timeout,
                               env={**os.environ, "CI": "1", "FORCE_COLOR": "0", "KCODER_SKIP_REVIEW": "1"})
        except subprocess.TimeoutExpired:
            return f"rule \"{r['text']}\" ({r['source']}): `{cmd}` did not finish within {timeout // 60} minutes."
        if p.returncode != 0:
            out = ((p.stdout or "") + (p.stderr or "")).strip()
            tail = "\n".join(out.splitlines()[-30:])
            return f"rule \"{r['text']}\" ({r['source']}): `{cmd}` failed with exit code {p.returncode}.\n{tail}\nFix it and try again."
    return None


def describe(rule: dict, root: str | None = None) -> str:
    """One line a person can check: what kcoder understood."""
    k = rule["kind"]
    if k == PROTECT:
        return "no writes, commits or pushes touching " + ", ".join(rule["paths"])
    if k == ONLY:
        return "writes only under " + ", ".join(rule["paths"])
    if k == NOCOMMIT:
        return "never staged in a commit: " + ", ".join(rule["paths"])
    if k == NORUN:
        return f"shell commands containing `{rule['command']}` are refused"
    cmd = resolve_command(rule, root) if root else rule.get("command")
    when = "commit" if k == BEFORE_COMMIT else "push"
    return f"`{cmd}` runs before every {when}; a failure blocks it" if cmd else f"runs the tests before every {when} (no test command found in this repo yet)"


def summary(root: str, cwd: str | None = None) -> list:
    return [{**r, "what": describe(r, root)} for r in load(root, cwd)]
