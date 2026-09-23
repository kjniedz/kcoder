"""The KCODER banner: gradient block letters, a short reveal animation, a
compact wordmark for narrow terminals, taglines, and the live context line.

The gradient is brand, not state - nothing here changes colour with status.
The same stops are used by the web app header so CLI and browser match.
"""

from __future__ import annotations

import os
import random
import select
import subprocess
import sys
import time

import pyfiglet
from rich.console import Console
from rich.style import Style
from rich.text import Text

from . import config

# Gradient stops, left to right: kcoder light blue -> periwinkle -> deep violet.
GRADIENT = [(0x87, 0xCE, 0xFA), (0x7C, 0x6C, 0xFF), (0x4C, 0x1D, 0x95)]
ACCENT = "#87CEFA"

COMPACT_WIDTH = 80          # below this, use the one-line wordmark
ANIMATION_FRAMES = 12
ANIMATION_SECONDS = 0.33    # total reveal time, under the 400ms budget


def _lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient_color(t: float) -> str:
    """Hex colour at position t in [0, 1] along the gradient."""
    t = max(0.0, min(1.0, t))
    segs = len(GRADIENT) - 1
    pos = t * segs
    i = min(int(pos), segs - 1)
    r, g, b = _lerp(GRADIENT[i], GRADIENT[i + 1], pos - i)
    return f"#{r:02x}{g:02x}{b:02x}"


def figlet_lines() -> list[str]:
    try:
        raw = pyfiglet.figlet_format("KCODER", font="ansi_shadow")
    except pyfiglet.FontNotFound:
        raw = pyfiglet.figlet_format("KCODER", font="big")
    lines = [ln.rstrip() for ln in raw.splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _colour_enabled(console: Console) -> bool:
    return console.color_system is not None and not os.environ.get("NO_COLOR")


def render_letters(lines: list[str], console: Console, *, reveal: float = 1.0,
                   shimmer: float | None = None) -> Text:
    """Gradient-coloured banner. `reveal` (0..1) hides columns beyond that
    fraction of the width; `shimmer` is the column fraction of a bright band."""
    width = max((len(ln) for ln in lines), default=1)
    colour = _colour_enabled(console)
    out = Text()
    cutoff = int(width * reveal)
    for row, line in enumerate(lines):
        for x, ch in enumerate(line):
            if x >= cutoff or ch == " ":
                out.append(" ")
                continue
            if not colour:
                out.append(ch, style="bold")
                continue
            t = x / max(1, width - 1)
            style = Style(color=gradient_color(t), bold=True)
            if shimmer is not None:
                d = abs(t - shimmer)
                if d < 0.06:
                    style = Style(color="#f4f0ff", bold=True)
                elif d < 0.12:
                    style = Style(color=_blend(gradient_color(t), "#f4f0ff", 0.5), bold=True)
            out.append(ch, style=style)
        if row < len(lines) - 1:
            out.append("\n")
    return out


def _blend(hex_a: str, hex_b: str, t: float) -> str:
    a = tuple(int(hex_a[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(hex_b[i:i + 2], 16) for i in (1, 3, 5))
    r, g, bl = _lerp(a, b, t)
    return f"#{r:02x}{g:02x}{bl:02x}"


def wordmark(console: Console, text: str = "kcoder") -> Text:
    """One-line gradient wordmark."""
    out = Text()
    colour = _colour_enabled(console)
    for i, ch in enumerate(text):
        t = i / max(1, len(text) - 1)
        out.append(ch, style=Style(color=gradient_color(t), bold=True) if colour else Style(bold=True))
    return out


# ----------------------------------------------------------------------
# motion
# ----------------------------------------------------------------------

_reduce_motion_cache: bool | None = None


def reduce_motion() -> bool:
    """True when the OS or environment asks for reduced motion."""
    global _reduce_motion_cache
    if _reduce_motion_cache is not None:
        return _reduce_motion_cache
    result = False
    if os.environ.get("KCODER_REDUCE_MOTION") or os.environ.get("REDUCE_MOTION"):
        result = True
    elif sys.platform == "darwin":
        try:
            out = subprocess.run(
                ["defaults", "read", "com.apple.universalaccess", "reduceMotion"],
                capture_output=True, text=True, timeout=0.5,
            )
            result = out.returncode == 0 and out.stdout.strip() == "1"
        except (OSError, subprocess.TimeoutExpired):
            result = False
    _reduce_motion_cache = result
    return result


def _animate(lines: list[str], console: Console) -> bool:
    """Sweep the letters in with a shimmer band. Any keypress skips to the
    end. Returns True if the final frame was drawn by the animation."""
    import termios
    import tty
    from rich.live import Live

    fd = sys.stdin.fileno()
    try:
        old = termios.tcgetattr(fd)
    except termios.error:
        return False
    frame_time = ANIMATION_SECONDS / ANIMATION_FRAMES
    try:
        tty.setcbreak(fd)
        with Live(render_letters(lines, console, reveal=0.0), console=console,
                  refresh_per_second=60, transient=False) as live:
            for i in range(1, ANIMATION_FRAMES + 1):
                t = i / ANIMATION_FRAMES
                # reveal runs slightly ahead of the shimmer so the band trails the edge
                live.update(render_letters(lines, console, reveal=min(1.0, t * 1.15), shimmer=t))
                if select.select([fd], [], [], frame_time)[0]:
                    os.read(fd, 64)  # swallow the keypress that skipped the reveal
                    break
            live.update(render_letters(lines, console))
        return True
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


# ----------------------------------------------------------------------
# public entry points
# ----------------------------------------------------------------------

def tagline(cfg: dict | None = None) -> str:
    cfg = cfg or config.load()
    lines = [str(t) for t in cfg.get("taglines") or [] if str(t).strip()]
    return random.choice(lines) if lines else ""


def print_banner(console: Console, *, compact: bool = False, animate: bool | None = None,
                 credit: bool = True) -> None:
    """Full banner (or the compact wordmark). Only for TTY sessions."""
    cfg = config.load()
    if compact or console.width < COMPACT_WIDTH:
        line = wordmark(console)
        if credit:
            line.append("  developed by Kyle Niedzwiecki · © 2026 Kyer's Reserve LLC", style="dim italic")
        console.print(line, highlight=False)
        console.print()
        return

    lines = figlet_lines()
    want_motion = (
        (animate if animate is not None else bool(cfg.get("animation", True)))
        and sys.stdin.isatty() and sys.stdout.isatty()
        and not os.environ.get("KCODER_NO_ANIMATION")
        and not reduce_motion()
        and _colour_enabled(console)
    )
    drawn = False
    if want_motion:
        try:
            drawn = _animate(lines, console)
        except Exception:  # noqa: BLE001 - never let the banner break startup
            drawn = False
    if not drawn:
        console.print(render_letters(lines, console), highlight=False)
    console.print()
    if credit:
        console.print("developed by Kyle Niedzwiecki", style="italic dim", highlight=False)
        console.print("© 2026 Kyer's Reserve LLC", style="dim", highlight=False)
        tl = tagline(cfg)
        if tl:
            console.print(tl, style=f"italic {ACCENT}", highlight=False)
    console.print()


def context_line(stats: dict | None) -> Text:
    """'4 sessions running · 1 waiting on you · $3.12 today' from daemon stats."""
    from .pricing import fmt_usd

    if not stats:
        return Text("daemon offline", style="dim")
    parts = []
    total = stats.get("sessions", 0)
    working = stats.get("working", 0)
    waiting = stats.get("waiting", 0)
    if total == 0:
        parts.append(("no sessions yet", "dim"))
    else:
        label = f"{total} session{'s' if total != 1 else ''}"
        if working:
            label += f", {working} running"
        parts.append((label, "dim"))
    if waiting:
        parts.append((f"{waiting} waiting on you", "bold yellow"))
    today = stats.get("today") or {}
    tokens = today.get("input", 0) + today.get("output", 0)
    if tokens:
        parts.append((f"{tokens:,} tokens · {fmt_usd(today.get('cost', 0.0))} today", "dim"))
    else:
        parts.append(("nothing spent today", "dim"))
    out = Text()
    for i, (txt, style) in enumerate(parts):
        if i:
            out.append(" · ", style="dim")
        out.append(txt, style=style)
    return out
