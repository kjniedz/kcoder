"""Cut a signed release:  python -m kcoder.release [--notes TEXT] [--draft]

Builds dist/kcoder-<version>.tar.gz from the git tag v<version> (created
if missing), writes SHA256SUMS, signs it with the release key
(~/.config/kcoder/release_key, an ssh-ed25519 key) and publishes everything
as a GitHub release with `gh`. The updater refuses anything else.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys

from . import paths, updater

KEY_PATH = os.environ.get("KCODER_RELEASE_KEY") or os.path.join(paths.CONFIG_DIR, "release_key")


def _run(args: list, cwd: str, check: bool = True) -> str:
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"$ {' '.join(args)}\n{(r.stderr or r.stdout).strip()}")
    return r.stdout


def main(argv: list | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m kcoder.release")
    p.add_argument("--notes", default=None, help="release notes (default: commits since the previous tag)")
    p.add_argument("--draft", action="store_true")
    p.add_argument("--no-publish", action="store_true", help="build + sign only")
    a = p.parse_args(argv)

    root = updater.checkout_root()
    if not root:
        raise SystemExit("run this from a developer checkout of kcoder")
    if _run(["git", "status", "--porcelain"], root).strip():
        raise SystemExit("the working tree has uncommitted changes; commit first")
    ver = updater.installed_version()
    tag = f"v{ver}"
    if not os.path.isfile(KEY_PATH):
        raise SystemExit(f"no release key at {KEY_PATH}; create one with:\n  ssh-keygen -t ed25519 -N '' -f {KEY_PATH}")
    pub = open(KEY_PATH + ".pub", encoding="utf-8").read().split()
    if " ".join(pub[:2]) != updater.RELEASE_PUBKEY:
        raise SystemExit("the release key does not match RELEASE_PUBKEY in kcoder/updater.py")

    if not _run(["git", "tag", "-l", tag], root).strip():
        _run(["git", "tag", "-a", tag, "-m", f"kcoder {ver}"], root)
        print(f"tagged {tag}")
    dist = os.path.join(root, "dist")
    os.makedirs(dist, exist_ok=True)
    name = f"kcoder-{ver}.tar.gz"
    tarball = os.path.join(dist, name)
    _run(["git", "archive", "--format=tar.gz", f"--prefix=kcoder-{ver}/", "-o", tarball, tag], root)
    digest = hashlib.sha256(open(tarball, "rb").read()).hexdigest()
    sums = os.path.join(dist, "SHA256SUMS")
    with open(sums, "w", encoding="utf-8") as f:
        f.write(f"{digest}  {name}\n")
    sig = sums + ".sig"
    if os.path.exists(sig):
        os.remove(sig)
    _run(["ssh-keygen", "-Y", "sign", "-f", KEY_PATH, "-n", updater.SIGN_NAMESPACE, sums], root)
    updater.verify_release_dir(dist, name)   # what the updater will do on the other end
    print(f"built + signed {tarball}\n  sha256 {digest}")
    if a.no_publish:
        return 0
    if not shutil.which("gh"):
        raise SystemExit("gh is required to publish")
    _run(["git", "push", "origin", tag], root)
    notes = a.notes
    if notes is None:
        prev = _run(["git", "describe", "--tags", "--abbrev=0", f"{tag}^"], root, check=False).strip()
        rng = f"{prev}..{tag}" if prev else tag
        notes = _run(["git", "log", "--format=- %s", rng], root).strip() or f"kcoder {ver}"
    args = ["gh", "release", "create", tag, tarball, sums, sig, "--title", f"kcoder {ver}", "--notes", notes]
    if a.draft:
        args.append("--draft")
    out = _run(args, root)
    print(out.strip() or f"published {tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
