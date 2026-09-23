"""Interactive terminal widgets for kcoder (arrow-key menus)."""

from __future__ import annotations

import os
import select as _select
import sys

from rich.console import Group
from rich.live import Live
from rich.text import Text

ACCENT = "#87CEFA"  # light sky blue - kcoder's accent color


def _read_key() -> str:
    """Read one keypress in raw mode. Returns 'up', 'down', 'enter', 'esc', or the char."""
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        # Read raw bytes from the fd (not buffered sys.stdin), so the select()
        # below accurately reflects whether more of an escape sequence is
        # waiting — buffered reads would hide pending bytes from select().
        ch = os.read(fd, 1)
        if ch == b"\x03":  # Ctrl+C
            raise KeyboardInterrupt
        if ch == b"\x1b":
            # Bare ESC, or the start of an escape sequence (arrow keys)?
            if _select.select([fd], [], [], 0.05)[0]:
                rest = os.read(fd, 8)
                # Cursor keys come as CSI (ESC [ A) or SS3 (ESC O A); the final
                # byte is A=up / B=down (ignore left/right and modified forms).
                if rest[:1] in (b"[", b"O"):
                    return {b"A": "up", b"B": "down"}.get(rest[-1:], "")
                return ""
            return "esc"
        if ch in (b"\r", b"\n"):
            return "enter"
        return ch.decode("utf-8", "ignore")
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


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

    with Live(render(), console=console, auto_refresh=False, transient=True) as live:
        while True:
            key = _read_key()
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
