"""The kcoder prompt: a prompt_toolkit line editor tuned to feel like Claude Code.

- Enter sends; Option+Enter inserts a newline (terminals that send Alt+Enter
  for Shift+Enter, as Claude Code's /terminal-setup configures, get
  Shift+Enter too); normal cursor movement across lines.
- Bracketed paste: a paste never submits by itself. Multi-line pastes
  collapse into a chip like "[Pasted #1 · 142 lines]" that is expanded back
  into the message on send; Alt+E expands the chip under the cursor so it
  can be edited first.
- Up/Down on the first/last line recalls previous prompts.
- "/" at the start opens a slash-command menu with autocomplete.
- Ctrl+C clears the line, or - pressed twice on an empty line - exits.
"""

from __future__ import annotations

import re
import time

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys
from prompt_toolkit.lexers import Lexer
from prompt_toolkit.styles import Style

PASTE_CHIP_MIN_LINES = 3      # pastes with at least this many lines become a chip
PASTE_CHIP_MIN_CHARS = 400    # ...or at least this many characters
DOUBLE_CTRL_C_SECONDS = 1.5

CHIP_RE = re.compile(r"\[Pasted #(\d+) · \d+ lines?\]")

SLASH_COMMANDS = [
    ("/help", "show commands"),
    ("/exit", "detach; session keeps running"),
    ("/quit", "detach; session keeps running"),
    ("/close", "end this session"),
    ("/clear", "reset conversation history"),
    ("/cd", "change working directory"),
    ("/provider", "switch provider"),
    ("/model", "switch model"),
    ("/auto", "toggle auto-approve"),
    ("/name", "rename this session"),
    ("/sessions", "list sessions"),
]

STYLE = Style.from_dict({
    "prompt": "bold ansigreen",
    "chip": "bold #87CEFA reverse",
    "rprompt": "italic #888888",
    "completion-menu": "bg:#1c2230 #d0d8e8",
    "completion-menu.completion.current": "bg:#87CEFA #0b0f14 bold",
    "completion-menu.meta.completion": "bg:#1c2230 #7f8ca0",
    "completion-menu.meta.completion.current": "bg:#87CEFA #0b0f14",
})


class SlashCompleter(Completer):
    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/") or " " in text or "\n" in document.text:
            return
        for cmd, meta in SLASH_COMMANDS:
            if cmd.startswith(text):
                yield Completion(cmd, start_position=-len(text), display=cmd, display_meta=meta)


class ChipLexer(Lexer):
    """Highlights paste chips inline."""

    def lex_document(self, document):
        lines = document.lines

        def get_line(lineno):
            line = lines[lineno]
            frags = []
            pos = 0
            for m in CHIP_RE.finditer(line):
                if m.start() > pos:
                    frags.append(("", line[pos:m.start()]))
                frags.append(("class:chip", m.group()))
                pos = m.end()
            if pos < len(line):
                frags.append(("", line[pos:]))
            return frags

        return get_line


class Prompt:
    def __init__(self, history_prompts: list[str] | None = None):
        self.pastes: dict[int, str] = {}
        self._last_ctrl_c = 0.0
        self._hint = ""
        self.history = InMemoryHistory()
        for p in history_prompts or []:
            if p.strip():
                self.history.append_string(p)
        self.session = PromptSession(
            message=[("class:prompt", "you> ")],
            multiline=True,
            key_bindings=self._bindings(),
            history=self.history,
            completer=SlashCompleter(),
            complete_while_typing=True,
            lexer=ChipLexer(),
            style=STYLE,
            prompt_continuation=lambda width, line_number, is_soft_wrap: "     ",
            rprompt=self._rprompt,
            enable_history_search=False,
            mouse_support=False,
        )

    # -- key bindings --------------------------------------------------

    def _bindings(self) -> KeyBindings:
        kb = KeyBindings()

        @kb.add("enter")
        def _submit(event):
            buf = event.current_buffer
            state = buf.complete_state
            if state and state.current_completion is not None:
                buf.apply_completion(state.current_completion)
                buf.insert_text(" ")
                return
            buf.validate_and_handle()

        @kb.add("escape", "enter")   # Option+Enter; map Shift+Enter to this in your terminal
        def _newline(event):
            event.current_buffer.insert_text("\n")

        @kb.add(Keys.BracketedPaste)
        def _paste(event):
            data = event.data.replace("\r\n", "\n").replace("\r", "\n")
            lines = data.count("\n") + 1
            if lines >= PASTE_CHIP_MIN_LINES or len(data) >= PASTE_CHIP_MIN_CHARS:
                n = len(self.pastes) + 1
                self.pastes[n] = data
                event.current_buffer.insert_text(f"[Pasted #{n} · {lines} line{'s' if lines != 1 else ''}]")
                self._hint = "alt+e expands a paste"
            else:
                event.current_buffer.insert_text(data)

        @kb.add("escape", "e")
        def _expand(event):
            buf = event.current_buffer
            text = buf.text
            chips = list(CHIP_RE.finditer(text))
            if not chips:
                return
            cur = buf.cursor_position
            target = next((m for m in chips if m.start() <= cur <= m.end()), None) or chips[-1]
            body = self.pastes.get(int(target.group(1)), "")
            buf.text = text[:target.start()] + body + text[target.end():]
            buf.cursor_position = target.start() + len(body)
            self._hint = ""

        @kb.add("c-c")
        def _ctrl_c(event):
            buf = event.current_buffer
            now = time.monotonic()
            if buf.text:
                buf.reset()
                self._hint = ""
                self._last_ctrl_c = 0.0
                return
            if now - self._last_ctrl_c < DOUBLE_CTRL_C_SECONDS:
                event.app.exit(exception=EOFError())
                return
            self._last_ctrl_c = now
            self._hint = "ctrl+c again to exit"

        return kb

    def _rprompt(self):
        if self._hint == "ctrl+c again to exit" and time.monotonic() - self._last_ctrl_c > DOUBLE_CTRL_C_SECONDS:
            self._hint = ""
        return FormattedText([("class:rprompt", self._hint)]) if self._hint else ""

    # -- public --------------------------------------------------------

    def read(self, default: str = "", ctrl_c_at: float = 0.0) -> str:
        """Prompt once (optionally pre-filled with `default`, e.g. text typed
        while the agent was busy). `ctrl_c_at` is when a Ctrl+C last
        interrupted a turn, so a quick second press here exits. Returns the
        message with paste chips expanded. Raises EOFError on Ctrl+D /
        double Ctrl+C."""
        self._hint = ""
        self._last_ctrl_c = ctrl_c_at
        if ctrl_c_at and time.monotonic() - ctrl_c_at < DOUBLE_CTRL_C_SECONDS:
            self._hint = "ctrl+c again to exit"
        raw = self.session.prompt(default=default)
        return self.expand(raw).strip()

    def expand(self, text: str) -> str:
        def repl(m):
            return self.pastes.get(int(m.group(1)), m.group())
        return CHIP_RE.sub(repl, text)

    def chip_count(self, text: str) -> int:
        return len(CHIP_RE.findall(text))
