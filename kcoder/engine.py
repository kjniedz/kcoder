"""Headless agent engine for kcoder.

An `Engine` owns one conversation: provider backend, model, working directory,
message history, and approval policy. It never touches a terminal. Everything
it does is reported through `emit(event)` as plain dicts, and everything it
needs from a human arrives through `send()`, `approve()`, and `interrupt()`.

Events (all carry "t" = type and "ts" = unix time):

    turn_start        {}
    assistant_start   {}                       a streamed reply is beginning
    text              {delta}                  streamed text (not persisted)
    assistant_end     {text, elapsed}          full text of that reply segment
    usage             {input, output, cache_read, cache_write, model, elapsed}
    tool_call         {id, name, input, description}
    approval_request  {id, name, description, input}
    retry             {attempt, max, delay, reason}   backing off before retrying
    compaction_start  {tokens}
    compaction        {summary, messages_before, tokens_before}
    approval_result   {id, approved}
    tool_result       {id, name, content, is_error, elapsed}
    notice            {text}                   something the user must see
    info              {text}                   low-key informational line
    error             {text}                   the turn failed
    status            {status}                 idle | working | waiting | error
    turn_end          {result, elapsed}        result: ok | interrupted | error

A turn runs on its own thread so the owner (the daemon) stays responsive;
`emit` is therefore called from that thread and must be thread-safe.
"""

from __future__ import annotations

import base64
import mimetypes
import random
import threading
import time
import uuid

import anthropic
import openai

from . import projects
from .tools import DANGEROUS_TOOLS, READ_ONLY_TOOLS, describe_tool_call, execute_tool

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

# Tool results are stored in history in full, but events carry a bounded
# preview so a chatty command can't flood the UI or the event log.
TOOL_RESULT_PREVIEW = 4000

STATUS_IDLE = "idle"
STATUS_WORKING = "working"
STATUS_WAITING = "waiting"
STATUS_ERROR = "error"

# Trust levels: which tools run without asking.
TRUST_AUTO = "auto"     # everything
TRUST_WRITE = "write"   # reads + file writes/edits; shell is gated
TRUST_READ = "read"     # reads only; writes, edits and shell are gated (default)
TRUST_NONE = "none"     # everything is gated
TRUST_LEVELS = (TRUST_AUTO, TRUST_WRITE, TRUST_READ, TRUST_NONE)

MAX_RETRIES = 5
RETRY_BASE_SECONDS = 2.0
RETRY_MAX_SECONDS = 30.0

# Context compaction: when the last prompt reached this many tokens, the
# history is summarised before the next turn.
DEFAULT_COMPACT_AT = 150_000

COMPACT_PROMPT = """We are about to compact this conversation to free up context. Write a
thorough handoff summary for a fresh instance of yourself that will continue
the work with no other memory. Do not use any tools. Include, in markdown:

1. The user's overall goal and any standing instructions or preferences.
2. What has been done so far, with the exact file paths that were read,
   created, or changed, and what changed in them.
3. Decisions made and why, and anything tried that did not work.
4. Current state: what is in progress, what is verified, what is not.
5. Precise next steps.

Be concrete. Prefer exact names, paths, commands, and error text over prose."""


class Interrupted(Exception):
    """Raised inside a turn when the user interrupts it."""


class EngineBusy(Exception):
    """Raised by send() while a turn is already running."""


def build_user_content(text: str, image_paths: list, kind: str):
    """Message `content` for a user turn: a plain string when there are no
    images, otherwise text + image blocks in the provider's format."""
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


class _Approval:
    def __init__(self, request_id: str):
        self.id = request_id
        self.decided = threading.Event()
        self.approved = False


class _CaptureHooks:
    """Hooks that collect streamed text and refuse tools (used for compaction)."""

    def __init__(self):
        self.text = ""
        self.usage_in = 0
        self.usage_out = 0

    def on_stream(self, it):
        for piece in it:
            self.text += piece or ""

    def usage(self, i, o, **kw):
        self.usage_in += int(i or 0)
        self.usage_out += int(o or 0)

    def handle_tool_call(self, name, tool_input, call_id=None):
        return "Tools are unavailable while compacting; write the summary instead.", True

    def notice(self, m):
        pass

    def info(self, m):
        pass


def _retryable(exc: Exception) -> str | None:
    """Reason string if the error is worth retrying with backoff."""
    if isinstance(exc, (anthropic.RateLimitError, openai.RateLimitError)):
        return "rate limited"
    if isinstance(exc, (anthropic.APIConnectionError, openai.APIConnectionError)):
        return "connection error"
    status = getattr(exc, "status_code", None)
    if status in (500, 502, 503, 529):
        return "overloaded" if status == 529 else f"server error {status}"
    return None


class Engine:
    def __init__(
        self,
        *,
        provider,
        backend,
        model: str,
        cwd: str,
        auto_approve: bool = False,
        trust: str | None = None,
        project_root: str | None = None,
        messages: list | None = None,
        emit=None,
        compact_at: int = DEFAULT_COMPACT_AT,
    ):
        self.provider = provider
        self.backend = backend
        self.model = model
        self.cwd = cwd
        self.trust = trust if trust in TRUST_LEVELS else (TRUST_AUTO if auto_approve else TRUST_READ)
        self.project_root = project_root or cwd
        self.compact_at = compact_at
        self.messages: list = messages if messages is not None else []
        self._emit = emit or (lambda ev: None)

        self.status = STATUS_IDLE
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._interrupt = threading.Event()
        self._pending: _Approval | None = None
        self._turn_started = 0.0
        self.last_input_tokens = 0

    # ------------------------------------------------------------------
    # public API (called from any thread)
    # ------------------------------------------------------------------

    @property
    def busy(self) -> bool:
        return self.status in (STATUS_WORKING, STATUS_WAITING)

    @property
    def auto_approve(self) -> bool:
        return self.trust == TRUST_AUTO

    @auto_approve.setter
    def auto_approve(self, value: bool) -> None:
        self.trust = TRUST_AUTO if value else TRUST_READ

    def needs_approval(self, tool_name: str) -> bool:
        if self.trust == TRUST_AUTO:
            return False
        if self.trust == TRUST_WRITE:
            return tool_name == "run_bash"
        if self.trust == TRUST_NONE:
            return True
        return tool_name in DANGEROUS_TOOLS  # TRUST_READ

    def system_prompt(self) -> str:
        base = SYSTEM_PROMPT.format(cwd=self.cwd)
        extra = projects.load_instructions(self.project_root, self.cwd)
        if extra:
            base += "\n\n# Project instructions (KCODER.md)\n\n" + extra
        return base

    def truncate(self, index: int) -> None:
        """Drop history from message `index` on (for edit-and-resend)."""
        if self.busy:
            raise EngineBusy("can't edit history while a turn is running")
        del self.messages[index:]

    def send(self, text: str, image_paths: list | None = None) -> None:
        """Start a turn with a user message. Raises EngineBusy if one is running."""
        with self._lock:
            if self.busy:
                raise EngineBusy("a turn is already running")
            content = build_user_content(text, image_paths or [], self.provider.kind)
            self._interrupt.clear()
            self._set_status(STATUS_WORKING)
            self._thread = threading.Thread(
                target=self._run_turn, args=(content,), daemon=True, name="kcoder-turn"
            )
            self._thread.start()

    def approve(self, request_id: str, approved: bool) -> bool:
        """Answer a pending approval. Returns False if no such request is pending."""
        pending = self._pending
        if pending is None or pending.id != request_id or pending.decided.is_set():
            return False
        pending.approved = approved
        pending.decided.set()
        return True

    def interrupt(self) -> bool:
        """Ask the running turn to stop. Takes effect at the next streamed
        token or approval check; a tool already executing runs to completion."""
        if not self.busy:
            return False
        self._interrupt.set()
        pending = self._pending
        if pending is not None:
            pending.decided.set()
        return True

    def clear(self) -> None:
        if self.busy:
            raise EngineBusy("can't clear while a turn is running")
        self.messages.clear()

    def switch_provider(self, provider, backend, model: str | None = None) -> None:
        """Swap backends. History is cleared because message formats differ."""
        if self.busy:
            raise EngineBusy("can't switch provider while a turn is running")
        self.provider = provider
        self.backend = backend
        self.model = model or provider.default_model
        self.messages.clear()

    def pending_approval(self) -> str | None:
        pending = self._pending
        if pending is not None and not pending.decided.is_set():
            return pending.id
        return None

    # ------------------------------------------------------------------
    # turn thread
    # ------------------------------------------------------------------

    def _run_turn(self, content) -> None:
        self._turn_started = time.monotonic()
        try:
            self._maybe_compact()
        except Interrupted:
            with self._lock:
                self._set_status(STATUS_IDLE)
            self.emit("turn_end", result="interrupted", elapsed=0.0)
            return
        except Exception as exc:  # noqa: BLE001 - compaction failure shouldn't block the turn
            self.emit("notice", text=f"Context compaction failed ({type(exc).__name__}: {exc}); continuing without it.")
        turn_start = len(self.messages)
        self.messages.append({"role": "user", "content": content})
        self.emit("turn_start")
        result = "ok"
        try:
            self._run_with_retries(turn_start)
        except Interrupted:
            result = "interrupted"
            del self.messages[turn_start:]
            self.emit("info", text="interrupted")
        except (anthropic.AuthenticationError, openai.AuthenticationError):
            result = "error"
            del self.messages[turn_start:]
            self.emit(
                "error",
                text="Authentication failed. Run `kcoder --logout` then restart kcoder to reconnect.",
            )
        except (anthropic.NotFoundError, openai.NotFoundError):
            result = "error"
            del self.messages[turn_start:]
            self.emit("error", text=f"Model not found: {self.model} (try /model, or /provider)")
        except (anthropic.RateLimitError, openai.RateLimitError):
            result = "error"
            del self.messages[turn_start:]
            self.emit("error", text="Rate limited - wait a moment and try again.")
        except (anthropic.APIConnectionError, openai.APIConnectionError):
            result = "error"
            del self.messages[turn_start:]
            self.emit("error", text="Couldn't reach the API - check your internet connection.")
        except (anthropic.APIError, openai.APIError) as exc:
            result = "error"
            del self.messages[turn_start:]
            self.emit("error", text=f"API error: {getattr(exc, 'message', exc)}")
        except Exception as exc:  # noqa: BLE001 - never let a turn thread die silently
            result = "error"
            del self.messages[turn_start:]
            self.emit("error", text=f"{type(exc).__name__}: {exc}")
        finally:
            self._pending = None
            with self._lock:
                self._set_status(STATUS_ERROR if result == "error" else STATUS_IDLE)
            self.emit("turn_end", result=result, elapsed=round(time.monotonic() - self._turn_started, 2))

    def _run_with_retries(self, turn_start: int) -> None:
        """Call the backend, retrying with backoff on rate limits and
        overloads. The history is only ever appended by the backend after a
        complete model call, so a retry never replays a tool call."""
        attempt = 0
        while True:
            try:
                self.backend.run_turn(self.messages, self.model, self.system_prompt(), self)
                return
            except (anthropic.APIError, openai.APIError) as exc:
                reason = _retryable(exc)
                if reason is None or attempt >= MAX_RETRIES:
                    raise
                attempt += 1
                delay = min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** (attempt - 1))) + random.uniform(0, 1)
                retry_after = getattr(getattr(exc, "response", None), "headers", {}) or {}
                try:
                    delay = max(delay, float(retry_after.get("retry-after", 0)))
                except (TypeError, ValueError):
                    pass
                self.emit("retry", attempt=attempt, max=MAX_RETRIES, delay=round(delay, 1), reason=reason)
                end = time.monotonic() + delay
                while time.monotonic() < end:
                    self._check_interrupt()
                    time.sleep(0.25)

    def _maybe_compact(self) -> None:
        if not self.compact_at or self.last_input_tokens < self.compact_at or len(self.messages) < 4:
            return
        self.compact()

    def compact(self) -> None:
        """Summarise the history into a single handoff message."""
        self.emit("compaction_start", tokens=self.last_input_tokens)
        hooks = _CaptureHooks()
        temp = list(self.messages) + [{"role": "user", "content": COMPACT_PROMPT}]
        self.backend.run_turn(temp, self.model, self.system_prompt(), hooks)
        summary = hooks.text.strip()
        if not summary:
            raise RuntimeError("empty summary")
        before = len(self.messages)
        user_msg = {
            "role": "user",
            "content": "[Context was compacted. Summary of the conversation so far:]\n\n" + summary,
        }
        ack = "Understood - continuing from that summary."
        if self.provider.kind == "anthropic":
            assistant_msg = {"role": "assistant", "content": [{"type": "text", "text": ack}]}
        else:
            assistant_msg = {"role": "assistant", "content": ack}
        self.messages[:] = [user_msg, assistant_msg]
        self.last_input_tokens = hooks.usage_out
        self.emit("compaction", summary=summary, messages_before=before,
                  tokens_before=hooks.usage_in, input=hooks.usage_in, output=hooks.usage_out)
        self.emit("usage", input=hooks.usage_in, output=hooks.usage_out, cache_read=0, cache_write=0,
                  model=self.model, elapsed=round(time.monotonic() - self._turn_started, 2))

    # ------------------------------------------------------------------
    # hooks used by the backends (run on the turn thread)
    # ------------------------------------------------------------------

    def on_stream(self, text_iterator) -> None:
        self._check_interrupt()
        self.emit("assistant_start")
        started = time.monotonic()
        text = ""
        for piece in text_iterator:
            self._check_interrupt()
            if not piece:
                continue
            text += piece
            self.emit("text", delta=piece)
        self.emit("assistant_end", text=text, elapsed=round(time.monotonic() - started, 2))

    def usage(self, input_tokens: int, output_tokens: int, cache_read: int = 0,
              cache_write: int = 0) -> None:
        """`input_tokens` is the full prompt size (cached portions included);
        cache_read/cache_write break out the parts billed at cache rates."""
        self.last_input_tokens = int(input_tokens or 0)
        self.emit(
            "usage",
            input=int(input_tokens or 0),
            output=int(output_tokens or 0),
            cache_read=int(cache_read or 0),
            cache_write=int(cache_write or 0),
            model=self.model,
            elapsed=round(time.monotonic() - self._turn_started, 2),
        )

    def handle_tool_call(self, name: str, tool_input: dict, call_id: str | None = None):
        """Returns (result_content, is_error)."""
        self._check_interrupt()
        call_id = call_id or uuid.uuid4().hex[:12]
        description = describe_tool_call(name, tool_input)
        self.emit("tool_call", id=call_id, name=name, input=tool_input, description=description)

        if self.needs_approval(name):
            if not self._request_approval(call_id, name, description, tool_input):
                return "The user declined to allow this tool call.", True

        started = time.monotonic()
        try:
            content = execute_tool(name, tool_input, self.cwd)
            is_error = False
        except Exception as exc:  # noqa: BLE001 - tool errors go back to the model
            content = f"Error: {exc}"
            is_error = True
        self.emit(
            "tool_result",
            id=call_id,
            name=name,
            content=content[:TOOL_RESULT_PREVIEW],
            truncated=len(content) > TOOL_RESULT_PREVIEW,
            is_error=is_error,
            elapsed=round(time.monotonic() - started, 2),
        )
        return content, is_error

    def notice(self, message: str) -> None:
        self.emit("notice", text=message)

    def info(self, message: str) -> None:
        self.emit("info", text=message)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _request_approval(self, call_id: str, name: str, description: str, tool_input: dict) -> bool:
        approval = _Approval(call_id)
        self._pending = approval
        with self._lock:
            self._set_status(STATUS_WAITING)
        self.emit("approval_request", id=call_id, name=name, description=description, input=tool_input)
        try:
            while not approval.decided.wait(0.25):
                self._check_interrupt()
            self._check_interrupt()
        finally:
            self._pending = None
            with self._lock:
                self._set_status(STATUS_WORKING)
        self.emit("approval_result", id=call_id, approved=approval.approved)
        return approval.approved

    def _check_interrupt(self) -> None:
        if self._interrupt.is_set():
            raise Interrupted()

    def _set_status(self, status: str) -> None:
        if status != self.status:
            self.status = status
            self.emit("status", status=status)

    def emit(self, t: str, **fields) -> None:
        event = {"t": t, "ts": round(time.time(), 3)}
        event.update(fields)
        self._emit(event)
