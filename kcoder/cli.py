"""kcoder - terminal client for the kcoder session daemon.

    kcoder                new session here (or attach to one already here)
    kcoder "task"         one-shot: run a task, print the result, exit
    echo task | kcoder    same, headless (no banner, no prompts)
    kcoder ls             list running sessions
    kcoder history        list chats (this project, or --all)
    kcoder search <q>     full-text search across chats
    kcoder attach <id>    attach to / resume a chat (id prefix or name)
    kcoder export <id>    print a chat as markdown
    kcoder rm <id>        delete a chat
    kcoder ui             open the web app in the browser
    kcoder app            open the web app in its own window
    kcoder app --install  macOS: install kcoder.app in ~/Applications
    kcoder daemon ...     start | stop | restart | status | run | install | uninstall
"""

from __future__ import annotations

import argparse
import os
import random
import re
import select
import sys
import time
import webbrowser

from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.markup import escape
from rich.panel import Panel
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from . import __version__, app as appmod, auth, banner, config, paths, projects, ui
from .client import ClientError, DaemonClient, DaemonUnavailable, daemon_url
from .daemon import already_running
from .engine import TRUST_LEVELS
from .input import Prompt
from .providers import PROVIDERS

ACCENT = ui.ACCENT

console = Console()
errconsole = Console(stderr=True)

USAGE_HINT = (
    "kcoder: terminal coding agent. Interactive: run `kcoder` in a terminal. "
    "Headless: `kcoder \"task\"` or `echo task | kcoder` (add -y to allow tools). "
    "See `kcoder --help`."
)


class Detach(Exception):
    """Raised inside the chat loop to leave the session (it keeps running)."""


# ----------------------------------------------------------------------
# chrome
# ----------------------------------------------------------------------

def print_banner(args=None, *, compact: bool = False) -> None:
    """Brand banner. Never printed when stdout isn't a terminal."""
    if not sys.stdout.isatty():
        return
    if args is not None and getattr(args, "no_banner", False):
        return
    if not config.load().get("banner", True):
        return
    banner.print_banner(console, compact=compact)


def print_context_line(client: DaemonClient) -> None:
    """'4 sessions, 1 running · 1 waiting on you · $3.12 today' under the banner."""
    if not sys.stdout.isatty():
        return
    try:
        stats = client.request("stats", timeout=5)["stats"]
    except ClientError:
        stats = None
    console.print(banner.context_line(stats), highlight=False)
    console.print()


def print_session_panel(meta: dict) -> None:
    provider = PROVIDERS.get(meta["provider"])
    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="dim", justify="right")
    grid.add_column()
    title = meta.get("title") or ""
    grid.add_row("session", f"[bold]{escape(meta['name'])}[/bold]  [dim]{meta['id']}[/dim]"
                 + (f"  [dim italic]{escape(title)}[/dim italic]" if title and title != meta["name"] else ""))
    proj = meta.get("project") or {}
    if proj.get("path") and proj.get("path") != meta["cwd"]:
        grid.add_row("project", f"{escape(proj.get('name', ''))}  [dim]{escape(_short_home(proj['path']))}[/dim]")
    if meta.get("worktree"):
        grid.add_row("branch", f"[bold]{escape(meta['worktree'].get('branch', ''))}[/bold]  [dim]worktree[/dim]")
    grid.add_row("provider", f"[bold]{provider.label if provider else meta['provider']}[/bold]")
    grid.add_row("model", f"[bold]{escape(meta['model'])}[/bold]")
    grid.add_row("cwd", escape(meta["cwd"]))
    trust = meta.get("trust") or ("auto" if meta.get("auto_approve") else "read")
    trust_desc = {"auto": "[bold green]auto[/bold green] [dim](everything runs)[/dim]",
                  "write": "[green]write[/green] [dim](shell is gated)[/dim]",
                  "read": "[dim]read[/dim] [dim](writes and shell are gated)[/dim]",
                  "none": "[yellow]none[/yellow] [dim](everything is gated)[/dim]"}[trust]
    grid.add_row("trust", trust_desc)
    console.print(
        Panel(
            grid,
            title=f"[bold {ACCENT}]session[/bold {ACCENT}]",
            title_align="left",
            border_style=ACCENT,
            expand=False,
            padding=(0, 2),
        )
    )
    console.print("[dim]/help for commands[/dim]\n")


def print_help() -> None:
    console.print(
        "\n[bold]Commands[/bold]\n"
        "  /exit, /quit      detach; the session keeps running in kcoderd\n"
        "  /close            end this session and detach\n"
        "  /clear            reset conversation history\n"
        "  /cd [path]        change working directory (no arg: home; or drag a folder in)\n"
        "  /provider [name]  switch provider (anthropic, xiaomi, deepseek, qwen,\n"
        "                    kimi, glm, minimax, xiaokai); no arg: pick interactively\n"
        "  /model [name]     show/switch model; no arg: pick interactively\n"
        "  /auto             toggle auto-approve (trust auto <-> read)\n"
        "  /trust [level]    auto | write | read | none - what runs without asking\n"
        "  /name [name]      rename this session (short name)\n"
        "  /title [text]     set the chat title\n"
        "  /queue [task]     add a follow-up task (no arg: show the queue; /queue clear)\n"
        "  /fork             fork this chat into a new one\n"
        "  /compact          summarise the history to free up context\n"
        "  /export [file]    write this chat as markdown\n"
        "  /sessions         list running sessions\n"
        "  /history          list chats in this project\n"
        "  /help             show this help\n",
        highlight=False,
    )


def pick_model_interactively(provider, current: str) -> str:
    labels = [
        m + (f"  [dim {ACCENT}](current)[/]" if m == current else "")
        for m in provider.models
    ]
    labels.append("[dim]type another model name…[/dim]")
    start = provider.models.index(current) if current in provider.models else 0
    choice = ui.select(console, f"Models - {provider.label}", labels, index=start)
    if choice is None:
        return current
    if choice == len(provider.models):
        typed = console.input("[bold]model name:[/bold] ").strip()
        return typed or current
    return provider.models[choice]


def pick_provider_model(current_pid: str, current_model: str):
    """One list of every provider and its models. Returns (provider_id, model) or None."""
    from . import routing
    rows, labels = [], []
    for p in PROVIDERS.values():
        ready = auth.has_credentials(p.id)
        models = (["auto"] if routing.has_tiers(p) else []) + list(p.models)
        if not ready:
            rows.append((p.id, p.default_model))
            labels.append(f"[dim]{escape(p.label)} · not set up (choose to connect)[/dim]")
            continue
        for m in models:
            cur = p.id == current_pid and m == current_model
            rows.append((p.id, m))
            note = ""
            if p.kind == "claude":
                from .providers import model_family, plan_block_for
                blocked = plan_block_for(m) if m != "auto" else None
                if blocked:
                    note = f"  [yellow](limit reached, back {escape(_when_short(blocked.get('until')))})[/yellow]"
                elif model_family(m) == "fable":
                    note = "  [dim](weekly Fable limit; stops there, no credits)[/dim]"
            labels.append(f"[dim]{escape(p.label)} ·[/dim] {escape(m)}" + note
                          + (f"  [dim {ACCENT}](current)[/]" if cur else ""))
        rows.append((p.id, None))
        labels.append(f"[dim]{escape(p.label)} · type another model name…[/dim]")
    start = next((i for i, r in enumerate(rows) if r == (current_pid, current_model)), 0)
    choice = ui.select(console, "Model (all providers)", labels, index=start)
    if choice is None:
        return None
    pid, model = rows[choice]
    if model is None:
        model = console.input("[bold]model name:[/bold] ").strip()
        if not model:
            return None
    return pid, model


# ----------------------------------------------------------------------
# input handling
# ----------------------------------------------------------------------

def clean_path(raw: str) -> str:
    """Normalize a path the way a terminal hands it over on drag-and-drop:
    strip surrounding quotes and un-escape backslashed characters (spaces,
    brackets, parens, etc.), then expand ~."""
    s = raw.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        s = s[1:-1]
    s = re.sub(r"\\(.)", r"\1", s)  # \[ -> [, "\ " -> " ", \( -> (, ...
    return os.path.expanduser(s)


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

# A drag-and-dropped path: starts with / or ~, then either an escaped char
# (\ , \[, ...) or any non-space, non-backslash character.
_PATH_RE = re.compile(r"(?:[~/])(?:\\.|[^\s\\])*")


def process_input(text: str):
    """Pull drag-and-dropped file paths out of a message.

    Image paths become `[Image #N]` placeholders (and are returned for
    attachment); other real paths are un-escaped in place so the agent sees
    a clean path. Returns (new_text, [image_path, ...]).
    """
    images: list[str] = []

    def repl(match: re.Match) -> str:
        cleaned = clean_path(match.group())
        if not os.path.exists(cleaned):
            return match.group()  # not a real path - leave the text untouched
        ext = os.path.splitext(cleaned)[1].lower()
        if ext in IMAGE_EXTS and os.path.isfile(cleaned):
            images.append(cleaned)
            return f"[Image #{len(images)}]"
        return cleaned

    return _PATH_RE.sub(repl, text), images


# Playful status words shown while the model is still thinking (before any
# tokens stream). Shuffled per turn and rotated over time so it feels random.
THINKING_WORDS = [
    "cooking",
    "loading genius",
    "bribing the algorithm",
    "stalling convincingly",
    "rolling shpli",
    "wibbling",
    "woobling",
    "calculating",
    "processing",
    "working on it",
    "analyzing",
    "computing",
    "pondering",
    "generating",
    "reflecting",
    "crunching",
    "considering",
    "reasoning",
    "developing",
    "railing lines",
]

# Seconds each word stays up before rotating to the next.
_WORD_INTERVAL = 2.0


class _StreamStats:
    """Elapsed time + token estimate, re-rendered live next to the spinner."""

    def __init__(self):
        self.start = time.monotonic()
        self.chars = 0
        # A fresh random order each turn; cycled through as time elapses.
        self._words = random.sample(THINKING_WORDS, len(THINKING_WORDS))

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.start

    def __rich_console__(self, console, options):
        if self.chars:
            yield Text(
                f"{self.elapsed:.0f}s · ~{self.chars // 4:,} tokens", style="dim"
            )
        else:
            word = self._words[int(self.elapsed / _WORD_INTERVAL) % len(self._words)]
            yield Text(f"{self.elapsed:.0f}s · {word}…", style="dim")


class TurnRenderer:
    """Renders one session's event stream in the terminal, exactly like the
    old in-process UI did, and answers approval requests from the keyboard."""

    def __init__(self, client: DaemonClient, sid: str):
        self.client = client
        self.sid = sid
        self.live: Live | None = None
        self.stats: _StreamStats | None = None
        self.spinner = None
        self.text = ""
        self.last_elapsed = 0.0

    # -- live stream ---------------------------------------------------

    def _start_stream(self) -> None:
        console.print("[bold #7FC5FF]kcoder>[/bold magenta]")
        self.text = ""
        self.stats = _StreamStats()
        self.spinner = Spinner("dots", text=self.stats, style=ACCENT)
        self.live = Live(
            Group(self.spinner),
            console=console,
            refresh_per_second=12,
            vertical_overflow="visible",
        )
        self.live.start()

    def _end_stream(self, full_text: str | None = None) -> None:
        if self.live is None:
            return
        text = full_text if full_text is not None else self.text
        self.live.update(Markdown(text) if text else Group())
        self.live.stop()
        self.last_elapsed = self.stats.elapsed if self.stats else 0.0
        self.live = None

    def abort_stream(self) -> None:
        if self.live is not None:
            self._end_stream()

    # -- events --------------------------------------------------------

    def handle(self, ev: dict) -> None:
        t = ev["t"]
        if t == "assistant_start":
            self._start_stream()
        elif t == "text":
            if self.live is None:
                self._start_stream()
            self.text += ev["delta"]
            self.stats.chars = len(self.text)
            self.live.update(Group(Markdown(self.text), self.spinner))
        elif t == "assistant_end":
            self._end_stream(ev.get("text"))
        elif t == "usage":
            console.print(
                f"[dim]✓ {self.last_elapsed:.1f}s · "
                f"{ev['input']:,} in → {ev['output']:,} out tokens[/dim]",
                highlight=False,
            )
        elif t == "tool_call":
            self.abort_stream()
            console.print(f"[dim]⚙ {escape(ev['description'])}[/dim]", highlight=False)
        elif t == "approval_request":
            self.abort_stream()
            try:
                approved = ui.confirm(
                    console,
                    f"[yellow]Allow[/yellow] [bold]{escape(ev['description'])}[/bold]?",
                    yes_label="Yes, run it",
                    no_label="No, skip this",
                )
            except KeyboardInterrupt:
                approved = False
                raise
            finally:
                # a KeyboardInterrupt here still needs an answer sent so the
                # engine isn't left waiting; interrupt() follows from the caller
                try:
                    self.client.request("approve", sid=self.sid, rid=ev["id"], approved=approved)
                except ClientError:
                    pass
            console.print("[dim]  ✓ approved[/dim]" if approved else "[dim]  ✗ declined[/dim]")
        elif t == "tool_result":
            if ev.get("is_error"):
                first = (ev.get("content") or "").splitlines()[:1]
                console.print(f"[dim]  ✗ {escape(first[0] if first else 'error')}[/dim]", highlight=False)
        elif t == "notice":
            self.abort_stream()
            console.print(f"[red]{escape(ev['text'])}[/red]", highlight=False)
        elif t == "error":
            self.abort_stream()
            console.print(f"[red]{escape(ev['text'])}[/red]", highlight=False)
        elif t == "info":
            self.abort_stream()
            console.print(f"[dim]{escape(ev['text'])}[/dim]", highlight=False)
        elif t == "retry":
            self.abort_stream()
            console.print(f"[yellow]↻ {escape(ev.get('reason', 'error'))} - retrying in {ev.get('delay')}s "
                          f"({ev.get('attempt')}/{ev.get('max')})[/yellow]", highlight=False)
        elif t == "compaction_start":
            self.abort_stream()
            console.print(f"[dim]✂ context at {ev.get('tokens', 0):,} tokens - compacting…[/dim]")
        elif t == "compaction":
            console.print(f"[dim]✂ compacted {ev.get('messages_before', 0)} messages into a summary[/dim]")
        elif t == "queue":
            console.print(f"[dim]▶ next queued task ({ev.get('remaining', 0)} left): "
                          f"{escape(ev.get('started', ''))}[/dim]", highlight=False)

    def replay(self, events: list) -> None:
        """Non-live rendering of persisted events (used on attach)."""
        for ev in events:
            t = ev["t"]
            if t == "user":
                imgs = "".join(f" [{ACCENT}]🖼 {escape(i)}[/{ACCENT}]" for i in ev.get("images", []))
                console.print(f"[bold green]you>[/bold green] {escape(ev['text'])}{imgs}", highlight=False)
            elif t == "assistant_end":
                console.print("[bold #7FC5FF]kcoder>[/bold magenta]")
                if ev.get("text"):
                    console.print(Markdown(ev["text"]))
            elif t == "usage":
                console.print(
                    f"[dim]✓ {ev['input']:,} in → {ev['output']:,} out tokens[/dim]", highlight=False
                )
            elif t == "tool_call":
                console.print(f"[dim]⚙ {escape(ev['description'])}[/dim]", highlight=False)
            elif t == "approval_result":
                console.print("[dim]  ✓ approved[/dim]" if ev.get("approved") else "[dim]  ✗ declined[/dim]")
            elif t in ("notice", "error"):
                console.print(f"[red]{escape(ev['text'])}[/red]", highlight=False)
            elif t in ("info", "system", "history_reset"):
                console.print(f"[dim]{escape(ev.get('text', ''))}[/dim]", highlight=False)
            elif t == "compaction":
                console.print("[dim]✂ context compacted here[/dim]")


_last_ctrl_c = 0.0   # when Ctrl+C last interrupted a turn (for "twice exits")


class _KeyWatcher:
    """Puts the terminal in cbreak mode for the duration of a turn so a bare
    Esc can be detected without waiting for Enter. Ctrl+C still raises
    KeyboardInterrupt in cbreak mode."""

    def __init__(self):
        self.fd = None
        self._old = None
        self.typed = b""   # text typed while the agent was busy; prefills the next prompt

    def __enter__(self):
        if not sys.stdin.isatty():
            return self
        try:
            import termios
            import tty
            self.fd = sys.stdin.fileno()
            self._old = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)
        except Exception:  # noqa: BLE001
            self.fd = None
        return self

    def __exit__(self, *exc):
        if self.fd is not None and self._old is not None:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self._old)

    def esc_pressed(self) -> bool:
        if self.fd is None:
            return False
        pressed = False
        while select.select([self.fd], [], [], 0)[0]:
            data = os.read(self.fd, 4096)
            if not data:
                break
            # Ctrl+C normally arrives as SIGINT; if the terminal isn't our
            # controlling tty it shows up as a byte instead. Same meaning.
            if b"\x03" in data:
                raise KeyboardInterrupt
            # a lone ESC byte (not the start of an arrow-key sequence)
            if data == b"\x1b" or data.endswith(b"\x1b"):
                pressed = True
                data = data[:-1]
            if b"\x1b" not in data:   # keep plain typed text, drop escape sequences
                self.typed += data
        return pressed

    def typed_text(self) -> str:
        text = self.typed.decode("utf-8", "ignore").replace("\r\n", "\n").replace("\r", "\n")
        return "".join(ch for ch in text if ch == "\n" or ch >= " ").strip("\n")


def run_turn(client: DaemonClient, sid: str, renderer: TurnRenderer) -> str:
    """Consume events until this session's turn ends.

    Esc or Ctrl+C interrupts the agent (the session survives, so you can
    redirect it). A second Ctrl+C detaches. Returns any text typed while
    the agent was working, so the next prompt can start with it.
    """
    interrupted = False
    global _last_ctrl_c

    def interrupt(source: str) -> None:
        nonlocal interrupted
        global _last_ctrl_c
        renderer.abort_stream()
        if source == "ctrl+c":
            _last_ctrl_c = time.monotonic()
        if interrupted:
            return
        interrupted = True
        console.print(f"\n[dim]interrupting ({source})… ctrl+c again to detach[/dim]")
        try:
            client.request("interrupt", sid=sid)
        except ClientError:
            pass

    with _KeyWatcher() as keys:
        while True:
            try:
                item = client.next_event(timeout=0.1)
                if keys.esc_pressed():
                    interrupt("esc")
            except KeyboardInterrupt:
                if interrupted:
                    renderer.abort_stream()
                    raise Detach()
                interrupt("ctrl+c")
                continue
            if item is None:
                continue
            kind, payload = item
            if kind != "event" or payload.get("sid") != sid:
                continue
            ev = payload["ev"]
            if ev["t"] == "turn_end":
                renderer.abort_stream()
                keys.esc_pressed()
                return keys.typed_text()
            if ev["t"] in ("user", "status", "system"):
                continue
            try:
                renderer.handle(ev)
            except KeyboardInterrupt:
                if interrupted:
                    renderer.abort_stream()
                    raise Detach()
                interrupt("ctrl+c")


def run_turn_until(client: DaemonClient, sid: str, renderer: TurnRenderer, stop_types: set,
                   timeout: float = 600) -> None:
    """Consume events for sid until one of stop_types arrives (or turn_end)."""
    end = time.time() + timeout
    while time.time() < end:
        item = client.next_event(timeout=0.5)
        if item is None:
            continue
        kind, payload = item
        if kind != "event" or payload.get("sid") != sid:
            continue
        ev = payload["ev"]
        if ev["t"] == "compaction":
            console.print(f"[dim]✂ compacted {ev.get('messages_before', 0)} messages into a summary[/dim]")
            return
        if ev["t"] in stop_types or ev["t"] == "turn_end":
            renderer.handle(ev)
            return
        if ev["t"] not in ("user", "status", "system"):
            renderer.handle(ev)


def run_turn_plain(client: DaemonClient, sid: str, *, allow_tools: bool) -> bool:
    """Headless turn: stream text to stdout, notes to stderr, no prompts.
    Returns True if the turn ended without error."""
    ok = True
    while True:
        item = client.next_event(timeout=0.5)
        if item is None:
            continue
        kind, payload = item
        if kind != "event" or payload.get("sid") != sid:
            continue
        ev = payload["ev"]
        t = ev["t"]
        if t == "text":
            sys.stdout.write(ev["delta"])
            sys.stdout.flush()
        elif t == "assistant_end":
            if ev.get("text"):
                sys.stdout.write("\n")
                sys.stdout.flush()
        elif t == "tool_call":
            print(f"⚙ {ev['description']}", file=sys.stderr, flush=True)
        elif t == "approval_request":
            # Nobody is here to answer; declining is the safe default.
            print(f"  ✗ declined (headless; run with -y to allow tools): {ev['description']}",
                  file=sys.stderr, flush=True)
            try:
                client.request("approve", sid=sid, rid=ev["id"], approved=False)
            except ClientError:
                pass
        elif t == "tool_result" and ev.get("is_error"):
            first = (ev.get("content") or "").splitlines()[:1]
            print(f"  ✗ {first[0] if first else 'error'}", file=sys.stderr, flush=True)
        elif t in ("notice", "error"):
            print(ev["text"], file=sys.stderr, flush=True)
            if t == "error":
                ok = False
        elif t == "turn_end":
            return ok and ev.get("result") == "ok"


# ----------------------------------------------------------------------
# credentials (interactive setup happens in the terminal, never the daemon)
# ----------------------------------------------------------------------

def ensure_credentials(provider_id: str) -> bool:
    """Make sure the daemon will be able to build a backend for provider_id,
    running the interactive sign-in flow here if needed."""
    if auth.has_credentials(provider_id):
        return True
    try:
        result = auth.connect(provider_id, console)
    except KeyboardInterrupt:
        console.print("\n[dim]setup cancelled[/dim]")
        return False
    return result is not None


def choose_provider(requested: str | None) -> str | None:
    config = auth.load_config()
    provider_id = requested or config.get("default_provider")
    if provider_id is not None and provider_id not in PROVIDERS:
        console.print(f"[red]Unknown provider: {provider_id}[/red]", highlight=False)
        return None
    try:
        if provider_id is None:
            result = auth.first_run(console)
            if result is None:
                return None
            return result[0].id
    except KeyboardInterrupt:
        console.print("\n[dim]setup cancelled[/dim]")
        return None
    if not ensure_credentials(provider_id):
        return None
    if requested:
        auth.set_default_provider(provider_id)
    return provider_id


# ----------------------------------------------------------------------
# the chat loop
# ----------------------------------------------------------------------

def chat(client: DaemonClient, meta: dict, replay: list | None = None,
         history: list | None = None) -> None:
    sid = meta["id"]
    print_session_panel(meta)
    renderer = TurnRenderer(client, sid)
    prompt = Prompt(history_prompts=history)

    if replay:
        renderer.replay(replay)
        console.print()

    if meta.get("interrupted") and meta.get("resume_text"):
        console.print("[yellow]This session was interrupted by a daemon restart before its last turn finished.[/yellow]")
        console.print(f"[dim]last message:[/dim] {escape(meta['resume_text'][:200])}", highlight=False)
        if ui.confirm(console, "Resume by sending it again?", yes_label="Yes, resume", no_label="No, start fresh from here"):
            try:
                client.request("resume_turn", sid=sid)
                run_turn(client, sid, renderer)
                console.print()
            except ClientError as exc:
                console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
    try:
        # If we attached mid-turn, catch up on the live stream first.
        if meta.get("status") in ("working", "waiting"):
            console.print("[dim](session is working - attaching to the live turn)[/dim]")
            if meta.get("pending_approval"):
                console.print("[dim](a tool approval is pending in this session)[/dim]")
            typed = run_turn(client, sid, renderer)
            console.print()
        else:
            typed = ""
        _chat_loop(client, meta, renderer, prompt, typed)
    except Detach:
        pass
    console.print(f"[dim]detached - `kcoder attach {meta['name']}` to come back[/dim]")


def _chat_loop(client: DaemonClient, meta: dict, renderer: TurnRenderer, prompt: Prompt,
               typed: str = "") -> None:
    sid = meta["id"]
    while True:
        client.drain_events()
        try:
            user_input = prompt.read(default=typed, ctrl_c_at=_last_ctrl_c)
            typed = ""
        except KeyboardInterrupt:
            console.print()
            continue
        except EOFError:
            console.print()
            raise Detach()

        if not user_input:
            continue

        parts = user_input.split(maxsplit=1)
        # A command is "/word" - this excludes dragged paths like /Users/...
        # and pasted code, which start with "/" but aren't a bare word.
        if parts and re.fullmatch(r"/[a-zA-Z]+", parts[0]):
            command, arg = parts[0].lower(), (parts[1].strip() if len(parts) > 1 else "")
            try:
                if _handle_command(client, meta, renderer, command, arg):
                    continue
                return  # command asked to leave
            except ClientError as exc:
                console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
                continue

        # A bare folder path on its own line (e.g. a drag-and-dropped folder):
        # offer to make it the working directory instead of sending it as a chat.
        if "\n" not in user_input:
            dropped = clean_path(user_input)
            if os.path.isabs(dropped) and os.path.isdir(dropped) and dropped != meta["cwd"]:
                if ui.confirm(
                    console,
                    f"Switch working directory to [bold]{escape(dropped)}[/bold]?",
                    yes_label="Yes, work here",
                    no_label="No, send as a message",
                ):
                    _set_cwd(client, meta, dropped)
                    continue

        # Resolve dragged paths: images become attachments, other paths are
        # un-escaped inline so the agent sees clean paths.
        text, image_paths = process_input(user_input)
        for i, path in enumerate(image_paths, 1):
            console.print(
                f"[{ACCENT}]🖼 Image #{i}[/{ACCENT}] [dim]← {escape(os.path.basename(path))}[/dim]",
                highlight=False,
            )

        try:
            client.request("send", sid=sid, text=text, images=image_paths)
        except DaemonUnavailable:
            raise
        except ClientError as exc:
            console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
            continue
        typed = run_turn(client, sid, renderer)
        console.print()


def _set_cwd(client: DaemonClient, meta: dict, target: str) -> None:
    try:
        reply = client.request("set", sid=meta["id"], cwd=target)
    except ClientError as exc:
        msg = str(exc)
        if "no such directory" in msg:
            console.print(f"[red]No such directory: {escape(target)}[/red]", highlight=False)
        else:
            console.print(f"[red]Couldn't change directory: {escape(msg)}[/red]", highlight=False)
        return
    meta.update(reply["session"])
    console.print(f"[dim]cwd → {escape(meta['cwd'])}[/dim]", highlight=False)


def _handle_command(client, meta, renderer, command, arg) -> bool:
    """Returns True to keep chatting, False to leave."""
    sid = meta["id"]
    if command in ("/exit", "/quit"):
        return False
    if command == "/close":
        client.request("close", sid=sid)
        console.print("[dim]session closed. bye![/dim]")
        raise SystemExit(0)
    if command == "/clear":
        client.request("clear", sid=sid)
        console.print("[dim]conversation cleared[/dim]")
        return True
    if command == "/cd":
        target = clean_path(arg) if arg else os.path.expanduser("~")
        _set_cwd(client, meta, target)
        return True
    if command == "/auto":
        reply = client.request("set", sid=sid, auto_approve=not meta.get("auto_approve"))
        meta.update(reply["session"])
        console.print(f"[dim]auto-approve: {'on' if meta['auto_approve'] else 'off'}[/dim]")
        return True
    if command == "/provider":
        if arg:
            if arg not in PROVIDERS:
                console.print(
                    f"[red]Unknown provider: {escape(arg)}[/red] "
                    f"(options: {', '.join(PROVIDERS)})",
                    highlight=False,
                )
                return True
            new_id = arg
        else:
            new_id = auth.pick_provider(console, current=meta["provider"])
            if new_id is None:
                return True
        if not ensure_credentials(new_id):
            return True
        reply = client.request("set", sid=sid, provider=new_id)
        auth.set_default_provider(new_id)
        meta.update(reply["session"])
        if reply["changed"].get("cleared"):
            console.print("[dim]conversation cleared (history formats differ between providers)[/dim]")
        print_session_panel(meta)
        return True
    if command == "/model":
        # `/model fable`, `/model anthropic/claude-opus-4-8`, or a picker of every provider + model
        if arg:
            pid, _, model = arg.partition("/") if "/" in arg and arg.split("/", 1)[0] in PROVIDERS else (meta["provider"], "", arg)
            model = model or arg
        else:
            picked = pick_provider_model(meta["provider"], meta["model"])
            if picked is None:
                return True
            pid, model = picked
        if pid != meta["provider"]:
            if not ensure_credentials(pid):
                return True
            reply = client.request("set", sid=sid, provider=pid, model=model)
            if reply["changed"].get("cleared"):
                console.print("[dim]conversation cleared (history formats differ between providers)[/dim]")
        else:
            reply = client.request("set", sid=sid, model=model)
        meta.update(reply["session"])
        console.print(
            f"[bold {ACCENT}]✓[/bold {ACCENT}] [dim]model →[/dim] [bold]{escape(meta['provider'])}/{escape(meta['model'])}[/bold]",
            highlight=False,
        )
        return True
    if command == "/name":
        if not arg:
            console.print(f"[dim]session name: {escape(meta['name'])}[/dim]", highlight=False)
            return True
        reply = client.request("rename", sid=sid, name=arg)
        meta.update(reply["session"])
        console.print(f"[dim]session → {escape(meta['name'])}[/dim]", highlight=False)
        return True
    if command == "/sessions":
        print_sessions(client.request("list")["sessions"], current=sid)
        return True
    if command == "/trust":
        if arg:
            if arg not in TRUST_LEVELS:
                console.print(f"[red]trust must be one of {', '.join(TRUST_LEVELS)}[/red]")
                return True
            reply = client.request("set", sid=sid, trust=arg)
            meta.update(reply["session"])
        console.print(f"[dim]trust: {meta.get('trust')}[/dim]")
        return True
    if command == "/title":
        if arg:
            reply = client.request("title", sid=sid, title=arg)
            meta.update(reply["session"])
        console.print(f"[dim]title: {escape(meta.get('title') or '')}[/dim]", highlight=False)
        return True
    if command == "/queue":
        if arg == "clear":
            reply = client.request("queue", sid=sid, action="clear")
        elif arg:
            reply = client.request("queue", sid=sid, action="add", text=arg)
            console.print(f"[dim]queued ({len(reply['queue'])} task(s) waiting)[/dim]")
            return True
        else:
            reply = {"queue": meta.get("queue") or client.request("list")["sessions"] and
                     next((s.get("queue", []) for s in client.request("list")["sessions"] if s["id"] == sid), [])}
        q = reply.get("queue") or []
        if not q:
            console.print("[dim]queue is empty[/dim]")
        for i, task in enumerate(q, 1):
            console.print(f"[dim]{i}.[/dim] {escape(task.get('text', str(task)))}", highlight=False)
        return True
    if command == "/fork":
        reply = client.request("fork", sid=sid)
        new = reply["session"]
        console.print(f"[dim]forked → {escape(new['name'])} ({new['id']}); `kcoder attach {escape(new['name'])}`[/dim]",
                      highlight=False)
        return True
    if command == "/compact":
        client.request("compact", sid=sid)
        console.print("[dim]compacting…[/dim]")
        run_turn_until(client, sid, renderer, {"compaction", "notice"})
        return True
    if command == "/export":
        reply = client.request("export", sid=sid)
        if arg:
            path = os.path.expanduser(arg)
            with open(path, "w", encoding="utf-8") as f:
                f.write(reply["markdown"])
            console.print(f"[dim]exported → {escape(path)}[/dim]", highlight=False)
        else:
            console.print(Markdown(reply["markdown"]))
        return True
    if command == "/history":
        proj = (meta.get("project") or {}).get("id")
        print_history(client.request("history", project=proj)["chats"], current=sid)
        return True
    if command == "/help":
        print_help()
        return True
    console.print(f"[red]Unknown command: {escape(command)}[/red] (try /help)", highlight=False)
    return True


# ----------------------------------------------------------------------
# subcommands
# ----------------------------------------------------------------------

STATUS_STYLE = {
    "idle": "green",
    "working": ACCENT,
    "waiting": "bold yellow",
    "error": "red",
}


def _age(ts: float) -> str:
    delta = max(0, time.time() - (ts or 0))
    if delta < 60:
        return f"{int(delta)}s"
    if delta < 3600:
        return f"{int(delta // 60)}m"
    if delta < 86400:
        return f"{int(delta // 3600)}h"
    return f"{int(delta // 86400)}d"


def print_sessions(sessions: list, current: str | None = None) -> None:
    if not sessions:
        console.print("[dim]no sessions - run `kcoder` to start one[/dim]")
        return
    table = Table(box=None, pad_edge=False, header_style=f"bold {ACCENT}")
    for col in ("id", "name", "status", "model", "tokens", "last", "cwd"):
        table.add_column(col)
    for s in sorted(sessions, key=lambda s: s.get("last_activity", 0), reverse=True):
        status = s.get("status", "?")
        style = STATUS_STYLE.get(status, "")
        status_text = f"[{style}]{status}[/{style}]" if style else status
        if status == "waiting":
            status_text += " [yellow]⏳[/yellow]"
        usage = s.get("usage", {})
        tokens = f"{usage.get('input', 0) + usage.get('output', 0):,}"
        marker = f"[{ACCENT}]*[/{ACCENT}]" if s["id"] == current else " "
        table.add_row(
            f"{marker}{s['id']}",
            escape(s["name"]),
            status_text,
            escape(s.get("model") or ""),
            tokens,
            _age(s.get("last_activity", 0)),
            escape(_short_home(s["cwd"])),
        )
    console.print(table)


def print_history(chats: list, current: str | None = None) -> None:
    if not chats:
        console.print("[dim]no chats yet[/dim]")
        return
    table = Table(box=None, pad_edge=False, header_style=f"bold {ACCENT}")
    for col in ("", "id", "name", "title", "status", "project", "last"):
        table.add_column(col)
    for c in chats:
        status = c.get("status", "archived")
        style = STATUS_STYLE.get(status, "dim")
        marks = ("📌" if c.get("pinned") else "") + (f"[{ACCENT}]*[/{ACCENT}]" if c["id"] == current else "")
        table.add_row(
            marks, c["id"], escape(c["name"]), escape((c.get("title") or "")[:50]),
            f"[{style}]{status}[/{style}]", escape((c.get("project") or {}).get("name", "")),
            _age(c.get("last_activity", 0)),
        )
    console.print(table)


def cmd_history(args) -> int:
    with DaemonClient.connect() as client:
        proj = None if args.all else projects.project_id(projects.project_root(os.getcwd()))
        reply = client.request("history", project=proj, limit=args.limit)
        if not reply["chats"] and proj and not args.all:
            console.print("[dim]no chats in this project yet (try `kcoder history --all`)[/dim]")
            return 0
        print_history(reply["chats"])
    return 0


def cmd_search(args) -> int:
    with DaemonClient.connect() as client:
        proj = None if args.all else projects.project_id(projects.project_root(os.getcwd()))
        results = client.request("search", q=" ".join(args.query), project=proj)["results"]
        if not results:
            console.print("[dim]no matches[/dim]")
            return 0
        for r in results:
            console.print(f"[bold]{escape(r.get('title') or r['name'])}[/bold]  [dim]{r['id']} · "
                          f"{escape((r.get('project') or {}).get('name', ''))} · {_age(r.get('last_activity', 0))} ago[/dim]",
                          highlight=False)
            for h in r.get("hits", []):
                console.print(f"  [dim]{h['who']}:[/dim] {escape(h['snippet'])}", highlight=False)
    return 0


def cmd_export(args) -> int:
    with DaemonClient.connect() as client:
        reply = client.request("export", sid=args.session)
    if args.output:
        with open(os.path.expanduser(args.output), "w", encoding="utf-8") as f:
            f.write(reply["markdown"])
        console.print(f"[dim]exported → {escape(args.output)}[/dim]", highlight=False)
    else:
        sys.stdout.write(reply["markdown"])
    return 0


def _short_home(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


def cmd_ls(args) -> int:
    running = already_running()
    if not running:
        console.print("[dim]kcoderd is not running - no sessions[/dim]")
        return 0
    with DaemonClient.connect(autostart=False) as client:
        print_sessions(client.request("list")["sessions"])
    return 0


def cmd_attach(args) -> int:
    with DaemonClient.connect() as client:
        try:
            reply = client.request("attach", sid=args.session, replay=200)
        except ClientError as exc:
            console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
            return 1
        meta = reply["session"]
        events = reply["events"]
        # Replay just the last turn so the terminal shows where things stand.
        starts = [i for i, e in enumerate(events) if e["t"] == "user"]
        last_turn = events[starts[-1]:] if starts else []
        print_banner(args, compact=True)
        print_context_line(client)
        if len(starts) > 1:
            console.print(f"[dim](attached - {len(starts) - 1} earlier turn(s) not shown)[/dim]")
        chat(client, meta, replay=last_turn, history=_prompt_history(events))
    return 0


def _prompt_history(events: list) -> list:
    return [e["text"] for e in events if e["t"] == "user" and e.get("text")]


def cmd_rm(args) -> int:
    with DaemonClient.connect(autostart=False) as client:
        for sid in args.session:
            try:
                client.request("delete", sid=sid)
                console.print(f"[dim]deleted session {escape(sid)}[/dim]", highlight=False)
            except ClientError as exc:
                console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
    return 0


def _stop_daemon(client) -> None:
    client.request("shutdown")
    for _ in range(100):
        if not already_running():
            return
        time.sleep(0.1)


def _refresh_stale_daemon() -> None:
    """After `git pull` / reinstall the running kcoderd is still the old code.
    Restart it when nothing is working, so the app always runs what is
    installed; otherwise say how to do it later."""
    running = already_running()
    if not running or running.get("version") == __version__:
        return
    with DaemonClient.connect(autostart=False, reconcile=False) as client:
        sessions = client.request("list")["sessions"]
        busy = [s["name"] for s in sessions if s.get("status") in ("working", "waiting")]
        if busy:
            console.print(
                f"[yellow]kcoderd {running.get('version')} is running but kcoder {__version__} is installed; "
                f"restart it with `kcoder daemon restart` once {', '.join(busy[:3])} finish(es).[/yellow]",
                highlight=False,
            )
            return
        console.print(f"[dim]restarting kcoderd {running.get('version')} → {__version__}[/dim]")
        if appmod.agent_loaded():
            client.ws.close()
            appmod.agent_stop()
            for _ in range(100):
                if not already_running():
                    break
                time.sleep(0.1)
            appmod.agent_start()
        else:
            _stop_daemon(client)
    from .client import ensure_daemon
    ensure_daemon()


def cmd_ui(args) -> int:
    _refresh_stale_daemon()
    with DaemonClient.connect() as client:
        url = daemon_url()
        token = open(paths.TOKEN_PATH).read().strip()
    full = f"{url}#token={token}"
    console.print(f"[dim]web app:[/dim] {url}")
    if not args.no_open:
        webbrowser.open(full)
    return 0


def cmd_app(args) -> int:
    """`kcoder app`: the web app in its own window, not a browser tab."""
    if args.install:
        try:
            path = appmod.install_mac_app()
        except RuntimeError as exc:
            console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
            return 1
        console.print(f"[green]✓[/green] installed {escape(path)}", highlight=False)
        console.print("[dim]Open it from Spotlight or Launchpad (search: kcoder), or `kcoder app`. "
                      "Right-click its Dock icon → Options → Keep in Dock to pin it.[/dim]")
        if not appmod.agent_installed():
            console.print("[dim]Tip: `kcoder daemon install` keeps kcoderd running from login so the app opens instantly.[/dim]")
        return 0
    if args.uninstall:
        if appmod.uninstall_mac_app():
            console.print("[dim]removed ~/Applications/kcoder.app[/dim]")
        else:
            console.print("[dim]kcoder.app was not installed[/dim]")
        return 0

    _refresh_stale_daemon()
    from .client import ensure_daemon
    info = ensure_daemon()
    url = appmod.app_url(info)
    mode = "browser" if args.browser else ("chromium" if args.chrome else ("native" if args.native else "auto"))
    try:
        used = appmod.open_window(url, mode, foreground=args.foreground)
    except RuntimeError as exc:
        console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
        return 1
    label = {"native": "native window", "chromium": "app window", "browser": "browser"}[used]
    console.print(f"[dim]kcoder app ({label}):[/dim] http://{info['host']}:{info['port']}/", highlight=False)
    return 0


def _when_short(ts) -> str:
    import datetime
    return datetime.datetime.fromtimestamp(float(ts)).strftime("%a %-I:%M %p") if ts else "later"


def _print_plan(st: dict) -> None:
    if st["on_plan"]:
        console.print(f"[green]✓[/green] Claude Code is on your Claude plan" + (f" ({escape(st['email'])})" if st.get("email") else ""), highlight=False)
    else:
        console.print(f"[yellow]{escape(st['problem'] or 'not connected')}[/yellow]", highlight=False)
    for lim in st.get("limits") or []:
        who = "all Claude models" if lim["scope"] == "all" else lim["scope"].capitalize()
        console.print(f"[yellow]limit reached[/yellow] {who}: {escape(lim.get('label') or 'plan limit')}, back {_when_short(lim.get('until'))}", highlight=False)
    console.print("[dim]kcoder never uses an API key or extra usage credits for Claude: at a limit the turn stops.[/dim]")


def cmd_login(args) -> int:
    """Connect (or reconnect) Claude Code to your Claude subscription."""
    from . import providers, setup
    import subprocess
    path = providers.claude_path()
    if not path:
        console.print("Claude Code is not installed. Install it with: [bold]curl -fsSL https://claude.ai/install.sh | bash[/bold], then run [bold]kcoder login[/bold].")
        return 1
    console.print("Signing in with your Claude account (subscription, not an API key). A browser window will open.")
    env = providers._claude_env()
    code = subprocess.call([path, "auth", "login", "--claudeai"], env=env)
    providers.forget_claude_auth()
    st = setup.claude_status()
    _print_plan(st)
    return 0 if code == 0 and st["on_plan"] else 1


def cmd_plan(args) -> int:
    """Show which Claude login kcoder runs on and any limits it is waiting out."""
    from . import providers, setup
    if args.clear:
        providers.clear_plan_limits()
        console.print("[green]✓[/green] cleared; the next turn checks the limit again (and stops before spending if it is still used up)")
    _print_plan(setup.claude_status())
    return 0


def cmd_update(args) -> int:
    from . import updater
    running = already_running()
    if running:
        with DaemonClient.connect(autostart=False, reconcile=False) as client:
            st = client.request("update", action="check", timeout=180)["update"]
            if args.now:
                try:
                    client.request("update", action="apply", force=bool(args.force))
                except ClientError as exc:
                    console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
                    return 1
                console.print(f"[green]✓[/green] pulling {st.get('behind')} commit(s); kcoderd rebuilds and restarts (log: {paths.UPDATE_LOG_PATH})")
                return 0
    else:
        st = updater.check()
        if args.now:
            why = updater.can_apply()
            if why:
                console.print(f"[red]{escape(why)}[/red]", highlight=False)
                return 1
            updater.spawn_helper("apply", previous=updater.head())
            console.print(f"[green]✓[/green] pulling {st.get('behind')} commit(s) (log: {paths.UPDATE_LOG_PATH})")
            return 0
    console.print(f"kcoder {__version__} · checkout {'yes' if st.get('dev') else 'no'} · upstream {st.get('upstream') or '?'}")
    if st.get("error"):
        console.print(f"[yellow]{escape(st['error'])}[/yellow]", highlight=False)
    if st.get("failed"):
        console.print(f"[yellow]the last attempt to apply these commits failed and was rolled back: "
                      f"{escape(str(st['failed'].get('error') or '?').splitlines()[-1])} (log: {paths.UPDATE_LOG_PATH})[/yellow]", highlight=False)
    if st.get("available"):
        console.print(f"[green]{st['behind']} new commit(s):[/green]")
        for c in st.get("commits") or []:
            console.print(f"  {escape(c)}", highlight=False)
        console.print("[dim]`kcoder update --now` pulls them, rebuilds and restarts kcoderd (rolls back if it fails)[/dim]")
    elif not st.get("error"):
        console.print("[dim]up to date[/dim]")
    if st.get("ahead"):
        console.print(f"[dim]{st['ahead']} local commit(s) not pushed yet[/dim]")
    return 0


def cmd_uninstall(args) -> int:
    from . import uninstall as uninstaller
    if args.dry_run:
        print(uninstaller.run(args.delete_history, args.delete_keys, pip=not args.keep_package, dry_run=True))
        return 0
    console.print("[bold]This removes kcoder from this Mac:[/bold]")
    for what, where in uninstaller.plan(args.delete_history, args.delete_keys):
        console.print(f"  • {what}  [dim]{escape(str(where))}[/dim]", highlight=False)
    delete_history, delete_keys = args.delete_history, args.delete_keys
    if not args.yes:
        if not ui.confirm(console, "Remove kcoder?", yes_label="Remove", no_label="Cancel"):
            console.print("[dim]nothing removed[/dim]")
            return 0
        if not delete_history:
            delete_history = ui.confirm(console, "Also delete session history, stats and worktrees? (default: keep)",
                                        yes_label="Delete history", no_label="Keep")
        if not delete_keys:
            delete_keys = ui.confirm(console, "Also delete saved provider keys? (default: keep)",
                                     yes_label="Delete keys", no_label="Keep")
    pid = None
    running = already_running()
    if running:
        pid = int(running["pid"])
        try:
            with DaemonClient.connect(autostart=False, reconcile=False) as client:
                client.request("shutdown")
        except (ClientError, DaemonUnavailable):
            pass
    uninstaller.run(delete_history, delete_keys, wait_pid=pid, pip=not args.keep_package, detach=False)
    console.print("[green]✓[/green] kcoder removed" + ("" if delete_history else " (history kept)") + ("" if delete_keys else " (keys kept)"))
    return 0


def cmd_daemon(args) -> int:
    action = args.action
    if action == "run":
        from . import daemon
        daemon.main([])
        return 0
    if action == "start":
        running = already_running()
        if running:
            console.print(f"[dim]kcoderd already running (pid {running['pid']}, port {running['port']})[/dim]")
            return 0
        from .client import ensure_daemon
        info = ensure_daemon()
        console.print(f"[green]✓[/green] kcoderd started (pid {info['pid']}, port {info['port']})")
        return 0
    if action in ("stop", "restart"):
        running = already_running()
        if running:
            with DaemonClient.connect(autostart=False, reconcile=False) as client:
                sessions = client.request("list")["sessions"]
                busy = [s["name"] for s in sessions if s.get("status") in ("working", "waiting")]
                if busy and not args.force:
                    console.print(f"[yellow]{len(busy)} session(s) still working ({', '.join(busy[:3])}); "
                                  f"use --force to {action} anyway[/yellow]", highlight=False)
                    return 1
                if appmod.agent_loaded():
                    client.ws.close()
                    appmod.agent_stop()
                    for _ in range(100):
                        if not already_running():
                            break
                        time.sleep(0.1)
                else:
                    _stop_daemon(client)
            console.print("[dim]kcoderd stopped[/dim]")
        elif action == "stop":
            console.print("[dim]kcoderd is not running[/dim]")
            return 0
        if action == "stop":
            return 0
        if appmod.agent_installed():
            appmod.agent_start()
            for _ in range(100):
                if already_running():
                    break
                time.sleep(0.1)
        from .client import ensure_daemon
        info = ensure_daemon()
        console.print(f"[green]✓[/green] kcoderd {__version__} started (pid {info['pid']}, port {info['port']})")
        return 0
    if action == "install":
        try:
            running = already_running()
            if running:
                with DaemonClient.connect(autostart=False, reconcile=False) as client:
                    sessions = client.request("list")["sessions"]
                    busy = [s["name"] for s in sessions if s.get("status") in ("working", "waiting")]
                    if busy and not args.force:
                        console.print(f"[yellow]{len(busy)} session(s) still working ({', '.join(busy[:3])}); "
                                      f"installing restarts kcoderd - use --force, or wait[/yellow]", highlight=False)
                        return 1
                    if appmod.agent_loaded():
                        client.ws.close()
                    else:
                        _stop_daemon(client)
            plist = appmod.install_launch_agent()
        except RuntimeError as exc:
            console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
            return 1
        for _ in range(100):
            if already_running():
                break
            time.sleep(0.1)
        info = already_running()
        if info:
            console.print(f"[green]✓[/green] kcoderd runs from login now (pid {info['pid']}, port {info['port']})")
        else:
            console.print(f"[yellow]login item installed but kcoderd has not answered yet - see {paths.DAEMON_LOG_PATH}[/yellow]")
        console.print(f"[dim]{escape(plist)}[/dim]", highlight=False)
        return 0
    if action == "uninstall":
        if appmod.uninstall_launch_agent():
            console.print("[dim]login item removed; kcoderd now starts on demand again[/dim]")
        else:
            console.print("[dim]no login item installed[/dim]")
        return 0
    if action == "status":
        running = already_running()
        if not running:
            console.print("[dim]kcoderd is not running[/dim]")
            return 1
        with DaemonClient.connect(autostart=False, reconcile=False) as client:
            n = len(client.request("list")["sessions"])
        how = "login item" if appmod.agent_loaded() else "on demand"
        stale = "" if running.get("version") == __version__ else f" [yellow](kcoder {__version__} is installed - `kcoder daemon restart`)[/yellow]"
        console.print(
            f"kcoderd {running.get('version', '')} running: pid {running['pid']}, "
            f"ws://{running['host']}:{running['port']}/ws, {n} session(s), {how}{stale}\n"
            f"[dim]log: {paths.DAEMON_LOG_PATH}[/dim]"
        )
        return 0
    return 1


def cmd_chat(args) -> int:
    """`kcoder` with no subcommand: start a session here, or attach to one
    that's already working in this directory."""
    if args.logout:
        if auth.delete_credentials():
            console.print("[dim]Saved credentials removed. kcoder will ask again next run.[/dim]")
        else:
            console.print("[dim]No saved credentials found.[/dim]")
        return 0

    prompt_text = " ".join(args.prompt).strip() if args.prompt else ""
    headless = not sys.stdin.isatty() or not sys.stdout.isatty()
    if headless and not prompt_text and not sys.stdin.isatty():
        prompt_text = sys.stdin.read().strip()
    if headless or prompt_text:
        if not prompt_text:
            print(USAGE_HINT)
            return 0
        return cmd_oneshot(args, prompt_text)

    print_banner(args)

    provider_id = choose_provider(args.provider)
    if provider_id is None:
        return 1

    cwd = os.getcwd()
    try:
        client = DaemonClient.connect()
    except DaemonUnavailable as exc:
        console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
        return 1

    with client:
        print_context_line(client)
        proj_id = projects.project_id(projects.project_root(cwd))
        recent = client.request("history", project=proj_id, limit=8)["chats"]
        meta = None
        replay: list = []
        history: list = []
        if recent and not args.new:
            labels = ["Start a new chat here"] + [
                f"{'Attach to' if c.get('status') not in ('archived', None) else 'Resume'} "
                f"[bold]{escape(c.get('title') or c['name'])}[/bold]  [dim]{c['name']} · {c.get('status', 'archived')} · "
                f"{escape(c.get('model') or '')} · {_age(c.get('last_activity', 0))} ago[/dim]"
                for c in recent
            ]
            choice = ui.select(console, "Chats in this project", labels)
            if choice is None:
                return 0
            if choice > 0:
                target = recent[choice - 1]
                reply = client.request("attach", sid=target["id"], replay=200)
                meta = reply["session"]
                events = reply["events"]
                starts = [i for i, e in enumerate(events) if e["t"] == "user"]
                replay = events[starts[-1]:] if starts else []
                history = _prompt_history(events)
        if meta is None:
            from . import routing
            model = args.model or os.environ.get("KCODER_MODEL") or routing.default_model(PROVIDERS[provider_id], config.load())
            try:
                reply = client.request(
                    "create",
                    cwd=cwd,
                    provider=provider_id,
                    model=model,
                    name=args.name,
                    trust=args.trust or ("auto" if args.yes else config.load().get("default_trust") or "auto"),
                    worktree=True if args.worktree else (False if args.no_worktree else None),
                )
            except ClientError as exc:
                console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
                return 1
            meta = reply["session"]
        try:
            chat(client, meta, replay=replay, history=history)
        except DaemonUnavailable as exc:
            console.print(f"\n[red]{escape(str(exc))}[/red]", highlight=False)
            return 1
    return 0


def cmd_oneshot(args, prompt_text: str) -> int:
    """Headless / one-shot: run one task in a fresh session and exit.

    Nothing decorative is printed. Text streams to stdout, tool activity and
    errors go to stderr, and the exit code is 0 on success. Tool approvals
    are declined unless -y is given. The session is deleted afterwards
    unless --keep is set.
    """
    config_data = auth.load_config()
    provider_id = args.provider or config_data.get("default_provider")
    if provider_id not in PROVIDERS or not auth.has_credentials(provider_id):
        print(
            f"kcoder: no credentials for provider {provider_id or '(none)'}; "
            "run `kcoder` in a terminal once to sign in, or set the provider's API key env var.",
            file=sys.stderr,
        )
        return 1
    try:
        client = DaemonClient.connect()
    except DaemonUnavailable as exc:
        print(f"kcoder: {exc}", file=sys.stderr)
        return 1
    with client:
        model = args.model or os.environ.get("KCODER_MODEL") or PROVIDERS[provider_id].default_model
        try:
            reply = client.request(
                "create", cwd=os.getcwd(), provider=provider_id, model=model,
                name=args.name or f"oneshot-{os.path.basename(os.getcwd()) or 'x'}",
                trust=args.trust or ("auto" if args.yes else "read"),   # nobody is here to approve
            )
            sid = reply["session"]["id"]
            client.request("send", sid=sid, text=prompt_text)
        except ClientError as exc:
            print(f"kcoder: {exc}", file=sys.stderr)
            return 1
        interactive_tty = sys.stdin.isatty() and sys.stdout.isatty()
        try:
            if interactive_tty:
                renderer = TurnRenderer(client, sid)
                run_turn(client, sid, renderer)
                ok = True
            else:
                ok = run_turn_plain(client, sid, allow_tools=bool(args.yes))
        except (Detach, KeyboardInterrupt):
            ok = False
        finally:
            if not args.keep:
                try:
                    client.request("delete", sid=sid)
                except ClientError:
                    pass
            elif interactive_tty:
                console.print(f"[dim]session kept - `kcoder attach {reply['session']['name']}`[/dim]")
    return 0 if ok else 1


# ----------------------------------------------------------------------
# entry point
# ----------------------------------------------------------------------

SUBCOMMANDS = {"ls", "list", "attach", "rm", "ui", "app", "daemon", "help", "history", "search", "export", "update", "uninstall", "login", "plan"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kcoder",
        description="kcoder - a terminal coding agent developed by Kyle Niedzwiecki",
    )
    parser.add_argument("--version", action="version", version=f"kcoder {__version__}")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("chat", help="start or attach to a session here (default)")
    p.add_argument("prompt", nargs="*", help="one-shot task: run it, print the result, exit")
    p.add_argument("-y", "--yes", action="store_true", help="auto-approve all tool executions (no y/n prompts)")
    p.add_argument("--no-banner", action="store_true", help="skip the startup banner")
    p.add_argument("--trust", choices=list(TRUST_LEVELS), help="what runs without asking (default: config default_trust, auto)")
    p.add_argument("--worktree", action="store_true", help="work on a fresh git worktree + branch (the default in a git repo)")
    p.add_argument("--no-worktree", action="store_true", help="work directly in this folder instead of a worktree")
    p.add_argument("--keep", action="store_true", help="one-shot: keep the session instead of deleting it")
    p.add_argument("--provider", metavar="NAME", help=f"provider to use ({', '.join(PROVIDERS)})")
    p.add_argument("--model", metavar="NAME", help="model to start with")
    p.add_argument("--name", metavar="NAME", help="session name (default: directory name)")
    p.add_argument("--new", action="store_true", help="always start a new session (don't offer to attach)")
    p.add_argument("--logout", action="store_true", help="forget all saved credentials and exit")
    p.set_defaults(func=cmd_chat)

    p = sub.add_parser("ls", aliases=["list"], help="list sessions")
    p.set_defaults(func=cmd_ls)

    p = sub.add_parser("history", help="list chats in this project (or all)")
    p.add_argument("--all", action="store_true", help="all projects")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=cmd_history)

    p = sub.add_parser("search", help="full-text search across chats")
    p.add_argument("query", nargs="+")
    p.add_argument("--all", action="store_true", help="all projects (default: this project)")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("export", help="print a chat as markdown")
    p.add_argument("session")
    p.add_argument("-o", "--output", help="write to a file instead of stdout")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("attach", help="attach to / resume a chat by id prefix or name")
    p.add_argument("session")
    p.set_defaults(func=cmd_attach)

    p = sub.add_parser("rm", help="close and delete sessions")
    p.add_argument("session", nargs="+")
    p.set_defaults(func=cmd_rm)

    p = sub.add_parser("ui", help="open the web app in your browser")
    p.add_argument("--no-open", action="store_true", help="print the URL instead of opening it")
    p.set_defaults(func=cmd_ui)

    p = sub.add_parser("app", help="open the web app in its own window")
    p.add_argument("--install", action="store_true", help="macOS: install ~/Applications/kcoder.app")
    p.add_argument("--uninstall", action="store_true", help="macOS: remove ~/Applications/kcoder.app")
    p.add_argument("--browser", action="store_true", help="open in the default browser instead of an app window")
    p.add_argument("--native", action="store_true", help="require the native window (pywebview)")
    p.add_argument("--chrome", action="store_true", help="use a Chromium-family browser in app mode instead of the native window")
    p.add_argument("--foreground", action="store_true", help="keep the native window attached to this terminal (for debugging)")
    p.set_defaults(func=cmd_app)

    p = sub.add_parser("login", help="connect or reconnect your Claude plan (subscription sign-in, never an API key)")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("plan", help="show the Claude login kcoder uses and any plan limits it is waiting out")
    p.add_argument("--clear", action="store_true", help="forget recorded limits (after you reset one on claude.ai)")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("update", help="check your kcoder checkout for new commits, or pull them")
    p.add_argument("--now", action="store_true", help="pull, rebuild and restart kcoderd")
    p.add_argument("--force", action="store_true", help="with --now: even while sessions are working")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("uninstall", help="remove kcoder from this Mac (keeps history and keys unless told otherwise)")
    p.add_argument("--yes", "-y", action="store_true", help="don't ask for confirmation")
    p.add_argument("--delete-history", action="store_true", help="also delete session history, stats and worktrees")
    p.add_argument("--delete-keys", action="store_true", help="also delete saved provider keys")
    p.add_argument("--keep-package", action="store_true", help="leave the Python package installed")
    p.add_argument("--dry-run", action="store_true", help="print what would be done")
    p.set_defaults(func=cmd_uninstall)

    p = sub.add_parser("daemon", help="manage kcoderd")
    p.add_argument("action", choices=["start", "stop", "restart", "status", "run", "install", "uninstall"],
                   nargs="?", default="status")
    p.add_argument("--force", action="store_true", help="stop/restart even while sessions are working")
    p.set_defaults(func=cmd_daemon)
    return parser


def main() -> None:
    argv = sys.argv[1:]
    # `kcoder -y`, `kcoder --provider x`, `kcoder "task"`, bare `kcoder` → the chat command
    if not argv or argv[0] not in SUBCOMMANDS | {"chat", "-h", "--help", "--version"}:
        argv = ["chat"] + argv
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        code = args.func(args)
    except DaemonUnavailable as exc:
        console.print(f"[red]{escape(str(exc))}[/red]", highlight=False)
        code = 1
    except KeyboardInterrupt:
        console.print()
        code = 130
    sys.exit(code or 0)


if __name__ == "__main__":
    main()
