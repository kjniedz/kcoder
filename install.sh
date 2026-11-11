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
# new commits later.
#
# On a Mac it needs nothing in place first. If git is missing it has macOS
# install Apple's command line tools (a dialog: click Install). kcoder always
# runs on its own Python from python.org, installed if it is not there (one
# password prompt): the Python that Homebrew or Apple ship refuses to install
# packages ("externally-managed-environment ... try brew install xyz"), so
# those are left alone even when they are on the PATH. Then it puts
# kcoder.app in ~/Applications and opens it. The app walks you through signing
# in to your AI model. Linux gets kcoder's own Python environment in
# ~/.local/share/kcoder-venv and the command in ~/.local/bin.
#
# Running the same command again is always safe: it picks up where it stopped.
#
# Environment overrides: KCODER_HOME (where to clone, default ~/kcoder),
# KCODER_REPO (clone URL), KCODER_PYTHON (python.org version to install),
# KCODER_NO_LAUNCH=1 (do not open the app), KCODER_DRY_RUN=1 (print the steps).

# everything sits in main so that bash has read the whole script before a
# command runs: piped through curl, nothing below can eat the rest of it
main() {
  set -Eeuo pipefail   # -E: the ERR trap below fires inside functions too
  local REPO="${KCODER_REPO:-https://github.com/kjniedz/kcoder.git}"
  local PY_VERSION="${KCODER_PYTHON:-3.14.3}"
  local FRAMEWORK="${KCODER_FRAMEWORK:-/Library/Frameworks/Python.framework/Versions}"   # KCODER_FRAMEWORK: tests only
  local DRY="${KCODER_DRY_RUN:-}"
  local OS STEP="starting"
  OS="$(uname -s)"

  say() { STEP="$*"; printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
  run() { if [ -n "$DRY" ]; then echo "    \$ $*"; else "$@"; fi; }
  # a failed command lands here (set -e): say what step it was and what to do,
  # in plain words, instead of leaving a bare error as the last line
  fail() {
    printf '\n\033[1;31m==>\033[0m kcoder could not finish this step: %s\n' "$STEP"
    echo "    The reason is in the lines above this one. The usual ones:"
    echo "    - a download failed or 'Could not resolve host': check the internet connection"
    echo "    - 'Sorry, try again' or 'is not in the sudoers file': the password is the one you log in"
    echo "      to this Mac with, and the account must be an administrator"
    echo "    - 'externally-managed-environment' or 'try brew install': a Python that refuses to"
    echo "      install packages was used; this installer brings its own, so run it again"
    echo "    Running the same command again is safe and picks up where it stopped."
    echo "    Still stuck? Select everything in this window, copy it and send it to Kyle."
  }
  trap fail ERR

  # --- git (Apple's command line tools on a Mac) ---
  if [ "$OS" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    say "Installing Apple's command line tools (they bring git). A window opens: click Install and wait; this continues by itself when it is done"
    run xcode-select --install >/dev/null 2>&1 || true
    if [ -z "$DRY" ]; then
      local waited=0
      until xcode-select -p >/dev/null 2>&1; do
        sleep 5
        waited=$((waited + 5))
        if [ $((waited % 60)) -eq 0 ]; then echo "    still waiting for the command line tools (click Install in the dialog if it is still open)"; fi
        if [ "$waited" -ge 1800 ]; then
          echo "The command line tools did not finish in 30 minutes. If the dialog was closed, run this command again to get it back."
          exit 1
        fi
      done
      say "The command line tools are installed"
    fi
  fi
  if [ "$OS" != "Darwin" ] && ! command -v git >/dev/null 2>&1; then
    echo "kcoder needs git. Install it with your package manager (for example: sudo apt install git) and run this again."
    exit 1
  fi

  # --- Python ---
  find_python() {
    local v p
    if [ "$OS" = "Darwin" ]; then
      # python.org's framework build only. Homebrew's python3 and Apple's
      # /usr/bin/python3 are skipped on purpose: their pip refuses every
      # install ("externally-managed-environment ... try brew install xyz")
      # and Apple's is too old. The framework one installs kcoder as is and
      # its interpreter goes into kcoder.app, so the Dock says "kcoder".
      for v in 3.14 3.13 3.12 3.11; do
        p="$FRAMEWORK/$v/bin/python3"
        if [ -x "$p" ]; then echo "$p"; return 0; fi
      done
      return 1
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
    say "Installing Python $PY_VERSION from python.org for kcoder to run on (your Mac asks for your login password once; nothing you type shows)"
    local PKG="/tmp/python-$PY_VERSION.pkg"
    run curl -fL --progress-bar "https://www.python.org/ftp/python/$PY_VERSION/python-$PY_VERSION-macos11.pkg" -o "$PKG"
    run sudo installer -pkg "$PKG" -target /
    run rm -f "$PKG"
    PY="$(find_python || true)"
    if [ -z "$PY" ] && [ -z "$DRY" ]; then echo "Python did not install. Please install it from https://www.python.org/downloads/ and run this again."; exit 1; fi
    PY="${PY:-$FRAMEWORK/${PY_VERSION%.*}/bin/python3}"
  fi

  # --- the checkout: this one, or a clone in ~/kcoder ---
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
  # --prefer-binary: a package whose newest version has no ready build for this machine (cryptography
  # on an Intel Mac) is taken at the newest version that has one, instead of being compiled and failing
  run "$PY" -m pip install --quiet --prefer-binary -e "$CHECKOUT"
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
