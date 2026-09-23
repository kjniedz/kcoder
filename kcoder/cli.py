"""kcoder - interactive terminal coding agent."""

import argparse
import base64
import mimetypes
import os
import random
import re
import select
import sys
import time

import anthropic
import openai
import pyfiglet
from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.markup import escape
from rich.panel import Panel
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from . import auth, ui
from .providers import PROVIDERS
from .tools import DANGEROUS_TOOLS, describe_tool_call, execute_tool

ACCENT = ui.ACCENT

SYSTEM_PROMPT = """\
You are kcoder, a terminal coding agent developed by Kyle Niedzwiecki.

You help with software engineering tasks in the user's current working
directory: {cwd}

You have tools to read, write, and edit files, list directories, and run
bash commands. Use them to get things done rather than just describing
what the user could do. Read files before editing them. When a task needs
multiple steps, work through them with tool calls until it's complete,
then summarize what you did.

Keep responses concise and terminal-friendly. Use markdown for structure
and code blocks for code.\
"""

console = Console()


def print_banner() -> None:
    try:
        banner = pyfiglet.figlet_format("KCODER", font="ansi_shadow")
    except pyfiglet.FontNotFound:
        banner = pyfiglet.figlet_format("KCODER", font="big")
    console.print(banner, style=f"bold {ACCENT}", highlight=False)
    console.print("developed by Kyle Niedzwiecki", style="italic dim")
    console.print("© 2026 Kyer's Reserve LLC\n", style="dim")


def print_session_panel(provider, model: str, auto_approve: bool) -> None:
    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="dim", justify="right")
    grid.add_column()
    grid.add_row("provider", f"[bold]{provider.label}[/bold]")
    grid.add_row("model", f"[bold]{model}[/bold]")
    grid.add_row("cwd", escape(os.getcwd()))
    grid.add_row(
        "auto-approve",
        "[bold green]on[/bold green]" if auto_approve else "[dim]off[/dim]",
    )
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
        "  /exit, /quit      leave kcoder\n"
        "  /clear            reset conversation history\n"
        "  /cd [path]        change working directory (no arg: home; or drag a folder in)\n"
        "  /provider [name]  switch provider (anthropic, xiaomi, deepseek, qwen,\n"
        "                    kimi, glm, minimax, xiaokai); no arg: pick interactively\n"
        "  /model [name]     show/switch model; no arg: pick interactively\n"
        "  /auto             toggle auto-approve for tool execution\n"
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
    choice = ui.select(console, f"Models — {provider.label}", labels, index=start)
    if choice is None:
        return current
    if choice == len(provider.models):
        typed = console.input("[bold]model name:[/bold] ").strip()
        return typed or current
    return provider.models[choice]


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


def build_user_content(text: str, image_paths: list, kind: str):
    """Build the message `content` for a turn. Plain string when there are no
    images; otherwise a list of text + image blocks in the provider's format."""
    if not image_paths:
        return text
    blocks: list = []
    if text.strip():
        blocks.append({"type": "text", "text": text})
    for path in image_paths:
        media_type = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            data = base64.standard_b64encode(f.read()).decode()
        if kind == "anthropic":
            blocks.append({
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            })
        else:  # openai-compatible
            blocks.append({
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}"},
            })
    return blocks


def read_user_input() -> str:
    """Prompt for input, capturing full multi-line pastes.

    A paste containing newlines submits its first line immediately; the
    remaining lines sit in the tty buffer. Keep draining complete lines
    until the buffer goes quiet so the whole paste lands in one message.
    """
    first = console.input("[bold green]you>[/bold green] ")
    lines = [first]
    if sys.stdin.isatty():
        while select.select([sys.stdin], [], [], 0.08)[0]:
            line = sys.stdin.readline()
            if not line:
                break
            lines.append(line.rstrip("\n"))
    if len(lines) > 1:
        console.print(
            f"[dim]… +{len(lines) - 1} pasted line{'s' if len(lines) > 2 else ''}[/dim]"
        )
    return "\n".join(lines).strip()


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


class TurnUI:
    """Display + approval callbacks the backends use during a turn."""

    def __init__(self, auto_approve: bool):
        self.auto_approve = auto_approve
        self.last_elapsed = 0.0

    def render_stream(self, text_iterator) -> None:
        console.print("[bold magenta]kcoder>[/bold magenta]")
        text = ""
        stats = _StreamStats()
        spinner = Spinner("dots", text=stats, style=ACCENT)
        with Live(
            Group(spinner),
            console=console,
            refresh_per_second=12,
            vertical_overflow="visible",
        ) as live:
            for piece in text_iterator:
                text += piece
                stats.chars = len(text)
                live.update(Group(Markdown(text), spinner))
            live.update(Markdown(text) if text else Group())
        self.last_elapsed = stats.elapsed

    def usage(self, input_tokens: int, output_tokens: int) -> None:
        console.print(
            f"[dim]✓ {self.last_elapsed:.1f}s · "
            f"{input_tokens:,} in → {output_tokens:,} out tokens[/dim]",
            highlight=False,
        )

    def handle_tool_call(self, name: str, tool_input: dict):
        """Returns (result_content, is_error)."""
        description = describe_tool_call(name, tool_input)
        console.print(f"[dim]⚙ {escape(description)}[/dim]", highlight=False)

        if name in DANGEROUS_TOOLS and not self.auto_approve:
            approved = ui.confirm(
                console,
                f"[yellow]Allow[/yellow] [bold]{escape(description)}[/bold]?",
                yes_label="Yes, run it",
                no_label="No, skip this",
            )
            if not approved:
                console.print("[dim]  ✗ declined[/dim]")
                return "The user declined to allow this tool call.", True
            console.print("[dim]  ✓ approved[/dim]")

        try:
            return execute_tool(name, tool_input), False
        except Exception as exc:
            console.print(f"[dim]  ✗ error: {exc}[/dim]", highlight=False)
            return f"Error: {exc}", True

    def notice(self, message: str) -> None:
        console.print(f"[red]{message}[/red]", highlight=False)

    def info(self, message: str) -> None:
        console.print(f"[dim]{message}[/dim]", highlight=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="kcoder",
        description="kcoder - a terminal coding agent developed by Kyle Niedzwiecki",
    )
    parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="auto-approve all tool executions (no y/n prompts)",
    )
    parser.add_argument(
        "--provider",
        metavar="NAME",
        help=f"provider to use ({', '.join(PROVIDERS)})",
    )
    parser.add_argument(
        "--logout",
        action="store_true",
        help="forget all saved credentials and exit",
    )
    args = parser.parse_args()

    if args.logout:
        if auth.delete_credentials():
            console.print("[dim]Saved credentials removed. kcoder will ask again next run.[/dim]")
        else:
            console.print("[dim]No saved credentials found.[/dim]")
        return

    print_banner()

    config = auth.load_config()
    provider_id = args.provider or config.get("default_provider")
    if provider_id is not None and provider_id not in PROVIDERS:
        console.print(f"[red]Unknown provider: {provider_id}[/red]", highlight=False)
        sys.exit(1)

    try:
        if provider_id is None:
            result = auth.first_run(console)
        else:
            result = auth.connect(provider_id, console)
            if result is not None:
                auth.set_default_provider(provider_id)
    except KeyboardInterrupt:
        console.print("\n[dim]setup cancelled[/dim]")
        sys.exit(1)
    if result is None:
        sys.exit(1)
    provider, backend = result

    model = os.environ.get("KCODER_MODEL") or provider.default_model
    auto_approve = args.yes
    messages: list = []

    print_session_panel(provider, model, auto_approve)

    while True:
        try:
            user_input = read_user_input()
        except KeyboardInterrupt:
            console.print()
            continue
        except EOFError:
            console.print("\n[dim]bye![/dim]")
            break

        if not user_input:
            continue

        parts = user_input.split(maxsplit=1)
        # A command is "/word" — this excludes dragged paths like /Users/...
        # and pasted code, which start with "/" but aren't a bare word.
        if parts and re.fullmatch(r"/[a-zA-Z]+", parts[0]):
            command, arg = parts[0].lower(), (parts[1].strip() if len(parts) > 1 else "")

            if command in ("/exit", "/quit"):
                console.print("[dim]bye![/dim]")
                break
            if command == "/clear":
                messages.clear()
                console.print("[dim]conversation cleared[/dim]")
                continue
            if command == "/cd":
                target = clean_path(arg) if arg else os.path.expanduser("~")
                try:
                    os.chdir(target)
                    console.print(f"[dim]cwd → {escape(os.getcwd())}[/dim]", highlight=False)
                except (FileNotFoundError, NotADirectoryError):
                    console.print(f"[red]No such directory: {escape(target)}[/red]", highlight=False)
                except OSError as exc:
                    console.print(f"[red]Couldn't change directory: {exc}[/red]", highlight=False)
                continue
            if command == "/auto":
                auto_approve = not auto_approve
                console.print(f"[dim]auto-approve: {'on' if auto_approve else 'off'}[/dim]")
                continue
            if command == "/provider":
                if arg:
                    if arg not in PROVIDERS:
                        console.print(
                            f"[red]Unknown provider: {escape(arg)}[/red] "
                            f"(options: {', '.join(PROVIDERS)})",
                            highlight=False,
                        )
                        continue
                    new_id = arg
                else:
                    new_id = auth.pick_provider(console, current=provider.id)
                    if new_id is None:
                        continue
                try:
                    switched = auth.connect(new_id, console)
                except KeyboardInterrupt:
                    console.print("\n[dim]cancelled[/dim]")
                    continue
                if switched is None:
                    continue
                provider, backend = switched
                auth.set_default_provider(new_id)
                model = provider.default_model
                if messages:
                    messages.clear()
                    console.print("[dim]conversation cleared (history formats differ between providers)[/dim]")
                print_session_panel(provider, model, auto_approve)
                continue
            if command == "/model":
                if arg:
                    model = arg
                else:
                    model = pick_model_interactively(provider, model)
                console.print(f"[bold {ACCENT}]✓[/bold {ACCENT}] [dim]model →[/dim] [bold]{escape(model)}[/bold]", highlight=False)
                continue
            if command == "/help":
                print_help()
                continue
            console.print(f"[red]Unknown command: {escape(command)}[/red] (try /help)", highlight=False)
            continue

        # A bare folder path on its own line (e.g. a drag-and-dropped folder):
        # offer to make it the working directory instead of sending it as a chat.
        if "\n" not in user_input:
            dropped = clean_path(user_input)
            if os.path.isabs(dropped) and os.path.isdir(dropped) and dropped != os.getcwd():
                if ui.confirm(
                    console,
                    f"Switch working directory to [bold]{escape(dropped)}[/bold]?",
                    yes_label="Yes, work here",
                    no_label="No, send as a message",
                ):
                    os.chdir(dropped)
                    console.print(f"[dim]cwd → {escape(os.getcwd())}[/dim]", highlight=False)
                    continue

        # Resolve dragged paths: images become attachments, other paths are
        # un-escaped inline so the agent sees clean paths.
        text, image_paths = process_input(user_input)
        for i, path in enumerate(image_paths, 1):
            console.print(
                f"[{ACCENT}]🖼 Image #{i}[/{ACCENT}] [dim]← {escape(os.path.basename(path))}[/dim]",
                highlight=False,
            )

        turn_start = len(messages)
        messages.append({"role": "user", "content": build_user_content(text, image_paths, provider.kind)})
        try:
            backend.run_turn(
                messages, model, SYSTEM_PROMPT.format(cwd=os.getcwd()), TurnUI(auto_approve)
            )
        except KeyboardInterrupt:
            console.print("\n[dim]interrupted[/dim]")
            del messages[turn_start:]
        except (anthropic.AuthenticationError, openai.AuthenticationError):
            console.print(
                "[red]Authentication failed.[/red] "
                "Run [bold]kcoder --logout[/bold] then restart kcoder to reconnect.",
                highlight=False,
            )
            del messages[turn_start:]
        except (anthropic.NotFoundError, openai.NotFoundError):
            console.print(
                f"[red]Model not found: {model}[/red] (try /model, or /provider)",
                highlight=False,
            )
            del messages[turn_start:]
        except (anthropic.RateLimitError, openai.RateLimitError):
            console.print("[red]Rate limited - wait a moment and try again.[/red]")
            del messages[turn_start:]
        except (anthropic.APIConnectionError, openai.APIConnectionError):
            console.print("[red]Couldn't reach the API - check your internet connection.[/red]")
            del messages[turn_start:]
        except (anthropic.APIError, openai.APIError) as exc:
            console.print(f"[red]API error: {getattr(exc, 'message', exc)}[/red]", highlight=False)
            del messages[turn_start:]
        console.print()


if __name__ == "__main__":
    main()
