#!/bin/bash
# kcoder installer for macOS. No terminal experience needed:
#
#   curl -fsSL https://raw.githubusercontent.com/kjniedz/kcoder/main/install.sh | bash
#
# It installs Python from python.org if your Mac does not have it (one
# password prompt), installs kcoder, puts kcoder.app in ~/Applications and
# opens it. The app then walks you through signing in to your AI model.
#
# Environment overrides (for maintainers): KCODER_SOURCE (pip source, default
# the GitHub main tarball), KCODER_PYTHON (python.org version to install),
# KCODER_DRY_RUN=1 (print the steps instead of running them).

main() {
  set -euo pipefail
  local SOURCE="${KCODER_SOURCE:-https://github.com/kjniedz/kcoder/archive/refs/heads/main.tar.gz}"
  local PY_VERSION="${KCODER_PYTHON:-3.14.3}"
  local FRAMEWORK=/Library/Frameworks/Python.framework/Versions
  local DRY="${KCODER_DRY_RUN:-}"

  say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
  run() { if [ -n "$DRY" ]; then echo "    \$ $*"; else "$@"; fi; }

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "This installer is for macOS. On other systems run:"
    echo "    python3 -m pip install --upgrade \"kcoder @ $SOURCE\" && python3 -m kcoder.cli app"
    exit 1
  fi

  find_python() {
    local v p
    for v in 3.14 3.13 3.12 3.11; do
      p="$FRAMEWORK/$v/bin/python3"
      if [ -x "$p" ]; then echo "$p"; return 0; fi
    done
    return 1
  }

  local PY
  PY="$(find_python || true)"
  if [ -z "$PY" ]; then
    say "Installing Python $PY_VERSION from python.org (your Mac will ask for your password once)"
    local PKG="/tmp/python-$PY_VERSION.pkg"
    run curl -fL "https://www.python.org/ftp/python/$PY_VERSION/python-$PY_VERSION-macos11.pkg" -o "$PKG"
    run sudo installer -pkg "$PKG" -target /
    run rm -f "$PKG"
    PY="$(find_python || true)"
    if [ -z "$PY" ] && [ -z "$DRY" ]; then echo "Python did not install. Please install it from https://www.python.org/downloads/ and run this again."; exit 1; fi
    PY="${PY:-$FRAMEWORK/${PY_VERSION%.*}/bin/python3}"
  fi
  say "Installing kcoder (this takes a minute)"
  run "$PY" -m pip install --quiet --upgrade pip
  run "$PY" -m pip install --quiet --upgrade "kcoder @ $SOURCE"

  say "Setting up the kcoder app in ~/Applications"
  run "$PY" -m kcoder.cli app --install

  say "Done. Opening kcoder. Pin it: right-click its Dock icon, Options, Keep in Dock."
  run "$PY" -m kcoder.cli app
  echo
  echo "To use kcoder from a terminal too, add this folder to your PATH: $(dirname "$PY")"
}

main "$@"
