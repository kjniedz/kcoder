"""Secret detection: API keys, tokens, private keys, wallet seed phrases and
raw private keys, .env and credential files. Used by the git hooks (block
commits and pushes), by the daemon (mask transcripts) and by exports.

A finding is {"kind", "path", "line", "match", "redacted", "fingerprint"}.
The allowlist lives in the repo at .kcoder/allowlist, one entry per line:

    secret:<fingerprint>     a specific match (shown in the block message)
    path:<glob>              files to skip entirely (e.g. path:fixtures/*.pem)
    kind:<kind>              a whole detector (e.g. kind:generic-assignment)
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import re

_WORDS: set | None = None


def _bip39() -> set:
    global _WORDS
    if _WORDS is None:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bip39-english.txt")
        try:
            with open(p, "r", encoding="utf-8") as f:
                _WORDS = {w.strip() for w in f if w.strip()}
        except OSError:
            _WORDS = set()
    return _WORDS


# (kind, compiled regex) - the first group (or whole match) is the secret
PATTERNS = [
    ("aws-access-key", re.compile(r"\b((?:AKIA|ASIA)[0-9A-Z]{16})\b")),
    ("aws-secret-key", re.compile(r"(?i)aws(?:.{0,20})?(?:secret|private)(?:.{0,20})?['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9/+=]{40})\b")),
    ("github-token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b")),
    ("anthropic-key", re.compile(r"\b(sk-ant-[A-Za-z0-9_\-]{20,})")),
    ("openai-key", re.compile(r"\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,})\b")),
    ("slack-token", re.compile(r"\b(xox[baprs]-[A-Za-z0-9\-]{10,})\b")),
    ("google-api-key", re.compile(r"\b(AIza[0-9A-Za-z_\-]{35})\b")),
    ("stripe-key", re.compile(r"\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b")),
    ("sendgrid-key", re.compile(r"\b(SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,})\b")),
    ("twilio-key", re.compile(r"\b(SK[0-9a-fA-F]{32})\b")),
    ("npm-token", re.compile(r"\b(npm_[A-Za-z0-9]{36})\b")),
    ("jwt", re.compile(r"\b(eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})\b")),
    ("private-key-block", re.compile(r"(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)")),
    ("eth-private-key", re.compile(r"(?i)(?:private[_ -]?key|privkey|secret)\W{0,10}(0x[0-9a-f]{64}|[0-9a-f]{64})\b")),
    ("wif-private-key", re.compile(r"\b([5KL][1-9A-HJ-NP-Za-km-z]{50,51})\b")),
    ("basic-auth-url", re.compile(r"[a-z][a-z0-9+.-]*://[^/\s:@]+:([^/\s@]{6,})@")),
    ("generic-assignment", re.compile(
        r"(?i)\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b"
        r"\s*[:=]\s*['\"]([^'\"\s]{16,})['\"]")),
]
SEED_LENGTHS = {12, 15, 18, 21, 24}

# files that are secrets by nature (matched against the repo-relative path)
FILE_PATTERNS = [
    ("env-file", [".env", ".env.*", "*/.env", "*/.env.*"]),
    ("credentials-file", ["credentials.json", "*/credentials.json", "credentials", ".netrc", "*/.netrc", "secrets.json", "secrets.yml", "secrets.yaml",
                          "*/secrets.json", "*/secrets.yml", "*/secrets.yaml", "service-account*.json", "*/service-account*.json", ".npmrc", "*/.npmrc", ".pypirc"]),
    ("private-key-file", ["*.pem", "*.key", "id_rsa", "id_rsa.*", "id_ed25519", "id_ed25519.*", "id_ecdsa", "id_dsa", "*.p12", "*.pfx", "*.jks", "*.keystore",
                          "*/id_rsa", "*/id_ed25519"]),
]
FILE_EXCEPTIONS = [".env.example", ".env.sample", ".env.template", "*.pub", "*.example"]
# low-entropy placeholders that match the shapes above but are not secrets
PLACEHOLDER = re.compile(r"(?i)^(?:x{8,}|\*{8,}|0{16,}|(?:your|my|the|example|sample|dummy|fake|test|placeholder|changeme|redacted)[\w\-]*|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\})$")


def fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8", "replace")).hexdigest()[:16]


def redact(secret: str) -> str:
    if len(secret) <= 8:
        return "*" * len(secret)
    return secret[:4] + "…" + secret[-2:]


def _entropy_ok(s: str) -> bool:
    """Reject obviously fake values (all one char, placeholders)."""
    if PLACEHOLDER.match(s):
        return False
    return len(set(s)) >= 5


def scan_text(text: str, path: str = "", line_offset: int = 0) -> list:
    """Findings in a blob of text; `line` is 1-based within the text (+offset)."""
    out = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if len(line) > 20000:
            continue
        for kind, rx in PATTERNS:
            for m in rx.finditer(line):
                secret = m.group(1) if m.groups() else m.group(0)
                if kind != "private-key-block" and not _entropy_ok(secret):
                    continue
                out.append(_finding(kind, path, i + 1 + line_offset, secret))
        words = [w for w in re.split(r"[^a-z]+", line.lower()) if w]
        if len(words) in SEED_LENGTHS and _bip39() and all(w in _bip39() for w in words):
            out.append(_finding("seed-phrase", path, i + 1 + line_offset, " ".join(words)))
    seen = set()
    deduped = []
    for f in out:
        key = (f["path"], f["line"], f["match"])
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    return deduped


def scan_path(path: str) -> str | None:
    """The kind if this repo-relative path is a secret file by nature."""
    name = os.path.basename(path)
    if any(fnmatch.fnmatch(name, p) for p in FILE_EXCEPTIONS):
        return None
    for kind, pats in FILE_PATTERNS:
        if any(fnmatch.fnmatch(path, p) or fnmatch.fnmatch(name, p) for p in pats):
            return kind
    return None


def _finding(kind: str, path: str, line: int, secret: str) -> dict:
    return {"kind": kind, "path": path, "line": line, "match": secret,
            "redacted": redact(secret), "fingerprint": fingerprint(secret)}


def scan_diff(diff: str) -> list:
    """Findings in the added lines of a unified diff (any -U), with the
    target path and the new-file line number."""
    out = []
    path = ""
    new_line = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            p = raw[4:].strip()
            path = p[2:] if p.startswith("b/") else p
            if path == "/dev/null":
                path = ""
            continue
        if raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            new_line = int(m.group(1)) if m else 0
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            for f in scan_text(raw[1:], path):
                f["line"] = new_line
                out.append(f)
            new_line += 1
        elif raw.startswith(" "):
            new_line += 1
    return out


# ----------------------------------------------------------------------
# allowlist
# ----------------------------------------------------------------------

ALLOWLIST_REL = os.path.join(".kcoder", "allowlist")


def load_allowlist(root: str) -> dict:
    allow = {"secret": set(), "path": [], "kind": set()}
    try:
        with open(os.path.join(root, ALLOWLIST_REL), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip(), v.strip()
                if k == "secret":
                    allow["secret"].add(v)
                elif k == "path":
                    allow["path"].append(v)
                elif k == "kind":
                    allow["kind"].add(v)
    except OSError:
        pass
    return allow


def add_allow(root: str, entry: str) -> str:
    """Append an allowlist line (e.g. 'secret:abcd1234'); returns the file path."""
    p = os.path.join(root, ALLOWLIST_REL)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    existing = ""
    try:
        existing = open(p, "r", encoding="utf-8").read()
    except OSError:
        pass
    if entry not in existing.splitlines():
        with open(p, "a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write(entry + "\n")
    return p


def is_allowed(finding: dict, allow: dict) -> bool:
    if finding.get("fingerprint") in allow["secret"] or finding.get("kind") in allow["kind"]:
        return True
    path = finding.get("path") or ""
    return any(fnmatch.fnmatch(path, p) or fnmatch.fnmatch(os.path.basename(path), p) for p in allow["path"])


def filter_allowed(findings: list, root: str) -> list:
    allow = load_allowlist(root)
    return [f for f in findings if not is_allowed(f, allow)]


def describe(findings: list) -> str:
    """The plain block message: file, line, kind, redacted match."""
    lines = []
    for f in findings[:20]:
        where = f"{f['path']}:{f['line']}" if f.get("path") else f"line {f['line']}"
        what = "secret file" if f["kind"].endswith("-file") else f"{f['kind']} {f['redacted']}"
        lines.append(f"  {where}  {what}  (allow with: secret:{f['fingerprint']})" if not f["kind"].endswith("-file")
                     else f"  {where}  {what}  (allow with: path:{f['path']})")
    if len(findings) > 20:
        lines.append(f"  … and {len(findings) - 20} more")
    return "\n".join(lines)


# ----------------------------------------------------------------------
# masking (transcripts, exports)
# ----------------------------------------------------------------------

def mask(text: str) -> str:
    if not text or len(text) < 16:
        return text
    def sub(kind, rx):
        def repl(m):
            s = m.group(1) if m.groups() else m.group(0)
            if kind != "private-key-block" and not _entropy_ok(s):
                return m.group(0)
            return m.group(0).replace(s, f"[redacted {kind}]")
        return rx.sub(repl, text)
    out = text
    for kind, rx in PATTERNS:
        if rx.search(out):
            text = out
            out = sub(kind, rx)
    if _bip39():
        masked = []
        changed = False
        for line in out.splitlines(keepends=True):
            words = [w for w in re.split(r"[^a-z]+", line.lower()) if w]
            if len(words) in SEED_LENGTHS and all(w in _bip39() for w in words):
                masked.append("[redacted seed-phrase]\n" if line.endswith("\n") else "[redacted seed-phrase]")
                changed = True
            else:
                masked.append(line)
        if changed:
            out = "".join(masked)
    return out


def mask_value(value):
    """Recursively mask strings inside dicts/lists (tool inputs, results)."""
    if isinstance(value, str):
        return mask(value)
    if isinstance(value, list):
        return [mask_value(v) for v in value]
    if isinstance(value, dict):
        return {k: mask_value(v) for k, v in value.items()}
    return value


def mask_event(event: dict) -> dict:
    """A copy of a session event with secrets masked in its text fields."""
    out = dict(event)
    for k in ("text", "content", "description", "summary", "started"):
        if isinstance(out.get(k), str):
            out[k] = mask(out[k])
    if isinstance(out.get("input"), (dict, list)):
        out["input"] = mask_value(out["input"])
    return out
