"""Interactive terminal widgets for kcoder (arrow-key menus)."""

from __future__ import annotations

import os
import select as _select
import sys
from contextlib import contextmanager

from rich.console import Group
from rich.live import Live
from rich.text import Text

ACCENT = "#87CEFA"  # light sky blue - kcoder's accent color


@contextmanager
def cbreak_mode():
    """Put the terminal in cbreak mode (no line buffering or echo, output
    processing kept) for the whole lifetime of a widget. Switching modes
    between keystrokes loses bytes that arrive in the gap, so widgets hold
    the mode until they're done."""
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        yield fd
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _read_key(fd: int) -> str:
    """Read one keypress (terminal already in cbreak mode).
    Returns 'up', 'down', 'enter', 'esc', or the character."""
    ch = os.read(fd, 1)
    if ch == b"\x03":  # Ctrl+C (cbreak normally raises via SIGINT; belt and braces)
        raise KeyboardInterrupt
    if ch == b"\x1b":
        # Bare ESC, or the start of an escape sequence (arrow keys)?
        if not _select.select([fd], [], [], 0.05)[0]:
            return "esc"
        nxt = os.read(fd, 1)
        if nxt not in (b"[", b"O"):
            return ""  # alt+<key>: ignore
        # CSI / SS3: read exactly one sequence, up to its final byte
        # (0x40-0x7E), leaving anything typed after it for the next call.
        final = b""
        while _select.select([fd], [], [], 0.05)[0]:
            b = os.read(fd, 1)
            if not b:
                break
            if 0x40 <= b[0] <= 0x7E:
                final = b
                break
        return {b"A": "up", b"B": "down"}.get(final, "")
    if ch in (b"\r", b"\n"):
        return "enter"
    return ch.decode("utf-8", "ignore")


def _supports_raw_mode() -> bool:
    if not sys.stdin.isatty():
        return False
    try:
        import termios  # noqa: F401
        import tty  # noqa: F401
        return True
    except ImportError:  # e.g. Windows
        return False


def select(console, title: str, options: list, index: int = 0):
    """Arrow-key menu. `options` are rich-markup labels.

    Returns the selected index, or None if cancelled (esc/q).
    Falls back to a numbered prompt when not attached to a terminal.
    """
    if not options:
        return None
    index = max(0, min(index, len(options) - 1))

    if not _supports_raw_mode():
        console.print(f"\n[bold]{title}[/bold]")
        for i, label in enumerate(options, 1):
            console.print(f"  {i}. {label}", highlight=False)
        choice = console.input("[bold]Choose (number, enter to cancel):[/bold] ").strip()
        try:
            i = int(choice) - 1
            if 0 <= i < len(options):
                return i
        except ValueError:
            pass
        return None

    def render() -> Group:
        lines = [Text.from_markup(f"[bold]{title}[/bold]"), Text()]
        for i, label in enumerate(options):
            body = Text.from_markup(label)
            if i == index:
                body.stylize(f"bold {ACCENT}")
                lines.append(Text("❯ ", style=f"bold {ACCENT}") + body)
            else:
                lines.append(Text("  ") + body)
        lines.append(Text())
        lines.append(Text.from_markup("[dim]↑/↓ move · enter select · esc cancel[/dim]"))
        return Group(*lines)

    with cbreak_mode() as fd, Live(render(), console=console, auto_refresh=False, transient=True) as live:
        while True:
            key = _read_key(fd)
            if key == "up":
                index = (index - 1) % len(options)
            elif key == "down":
                index = (index + 1) % len(options)
            elif key == "enter":
                return index
            elif key in ("esc", "q"):
                return None
            elif key.isdigit() and key != "0" and int(key) <= len(options):
                return int(key) - 1
            else:
                continue
            live.update(render(), refresh=True)


def confirm(console, question: str, yes_label: str = "Yes", no_label: str = "No") -> bool:
    """Arrow-key yes/no. Cancelling (esc) counts as no."""
    choice = select(console, question, [yes_label, no_label])
    return choice == 0
