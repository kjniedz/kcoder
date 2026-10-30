#!/bin/bash
# kcoder installer for macOS (and Linux). No terminal experience needed.
#
# One line in Terminal does it all:
#
#   curl -fsSL https://raw.githubusercontent.com/kjniedz/kcoder/main/install.sh | bash
#
# or, from a downloaded copy of the repo (green "Code" button, Download ZIP):
#
#   bash ~/Downloads/kcoder-main/install.sh        # or: bash ~/kcoder/install.sh
#
# Run from a git checkout it installs that checkout; run from a ZIP or through
# the pipe it clones the repo to ~/kcoder first, so `kcoder update` can pull
# new commits later. On a Mac without Python it installs Python from
# python.org (one password prompt), puts kcoder.app in ~/Applications and
# opens it. The app then walks you through signing in to your AI model.
#
# Environment overrides: KCODER_HOME (where to clone, default ~/kcoder),
# KCODER_REPO (clone URL), KCODER_PYTHON (python.org version to install),
# KCODER_NO_LAUNCH=1 (do not open the app), KCODER_DRY_RUN=1 (print the steps).

# everything sits in main so that bash has read the whole script before a
# command runs: piped through curl, nothing below can eat the rest of it
main() {
  set -euo pipefail
  local REPO="${KCODER_REPO:-https://github.com/kjniedz/kcoder.git}"
  local PY_VERSION="${KCODER_PYTHON:-3.14.3}"
  local FRAMEWORK=/Library/Frameworks/Python.framework/Versions
  local DRY="${KCODER_DRY_RUN:-}"
  local OS
  OS="$(uname -s)"

  say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
  run() { if [ -n "$DRY" ]; then echo "    \$ $*"; else "$@"; fi; }

  find_python() {
    local v p
    if [ "$OS" = "Darwin" ]; then
      for v in 3.14 3.13 3.12 3.11; do
        p="$FRAMEWORK/$v/bin/python3"
        if [ -x "$p" ]; then echo "$p"; return 0; fi
      done
    fi
    for p in python3.14 python3.13 python3.12 python3.11 python3; do
      if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
        command -v "$p"; return 0
      fi
    done
    return 1
  }

  local PY
  PY="$(find_python || true)"
  if [ -z "$PY" ]; then
    if [ "$OS" != "Darwin" ]; then
      echo "kcoder needs Python 3.11 or newer. Install it with your package manager (for example: sudo apt install python3 python3-venv) and run this again."
      exit 1
    fi
    say "Installing Python $PY_VERSION from python.org (your Mac will ask for your password once)"
    local PKG="/tmp/python-$PY_VERSION.pkg"
    run curl -fL "https://www.python.org/ftp/python/$PY_VERSION/python-$PY_VERSION-macos11.pkg" -o "$PKG"
    run sudo installer -pkg "$PKG" -target /
    run rm -f "$PKG"
    PY="$(find_python || true)"
    if [ -z "$PY" ] && [ -z "$DRY" ]; then echo "Python did not install. Please install it from https://www.python.org/downloads/ and run this again."; exit 1; fi
    PY="${PY:-$FRAMEWORK/${PY_VERSION%.*}/bin/python3}"
  fi

  # the checkout: this one, or a clone in ~/kcoder
  local HERE CHECKOUT
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$HERE" ] && [ -d "$HERE/.git" ] && [ -f "$HERE/kcoder/cli.py" ]; then
    CHECKOUT="$HERE"
    say "Using this kcoder checkout: $CHECKOUT"
  else
    CHECKOUT="${KCODER_HOME:-$HOME/kcoder}"
    if [ -d "$CHECKOUT/.git" ]; then
      say "Updating the kcoder checkout in $CHECKOUT"
      run git -C "$CHECKOUT" pull --ff-only
    else
      say "Downloading kcoder into $CHECKOUT"
      if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        run gh repo clone "$REPO" "$CHECKOUT"
      else
        run git clone "$REPO" "$CHECKOUT"
      fi
    fi
  fi

  if [ "$OS" != "Darwin" ]; then
    # distro Pythons refuse system-wide pip installs (PEP 668): use kcoder's own environment
    local VENV="${XDG_DATA_HOME:-$HOME/.local/share}/kcoder-venv"
    if [ ! -x "$VENV/bin/python" ]; then
      say "Creating kcoder's Python environment in $VENV"
      run "$PY" -m venv "$VENV"
    fi
    PY="$VENV/bin/python"
  fi

  say "Installing kcoder (this takes a minute)"
  run "$PY" -m pip install --quiet --upgrade pip
  run "$PY" -m pip install --quiet -e "$CHECKOUT"
  if [ "$OS" != "Darwin" ]; then
    run mkdir -p "$HOME/.local/bin"
    run ln -sf "$(dirname "$PY")/kcoder" "$HOME/.local/bin/kcoder"
  fi

  local BIN
  BIN="$(dirname "$PY")"
  if [ "$OS" = "Darwin" ]; then
    say "Setting up the kcoder app in ~/Applications"
    run "$PY" -P -m kcoder.cli app --install
    say "Done. Pin it: right-click its Dock icon, Options, Keep in Dock."
  else
    say "Done."
  fi
  if ! command -v kcoder >/dev/null 2>&1; then
    echo "To use kcoder from a terminal, add this folder to your PATH: $BIN"
    echo "(or run it as: $PY -P -m kcoder)"
  fi
  if [ -z "${KCODER_NO_LAUNCH:-}" ]; then
    run "$PY" -P -m kcoder.cli app
  fi
}

main "$@"
