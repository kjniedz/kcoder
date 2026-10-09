"""Provider registry and chat backends for kcoder.

Two backend kinds:
- "anthropic": the Anthropic Messages API (Claude models)
- "openai":    any OpenAI-compatible /chat/completions API, which covers
               DeepSeek, Xiaomi MiMo, Qwen, Kimi, GLM, MiniMax, and most
               other providers (plus local servers like Ollama/vLLM)

Backends are headless. `run_turn` drives the agentic loop and reports
everything through a `hooks` object (see `kcoder.engine.Engine`):

    hooks.on_stream(text_iterator)          consume streamed assistant text
    hooks.usage(input_tokens, output_tokens)
    hooks.handle_tool_call(name, input)     -> (result_content, is_error)
    hooks.notice(message)                   something the user must see
    hooks.info(message)                     low-key informational line

History (`messages`) is a list of plain JSON-serialisable dicts in the
provider's native format so it can be persisted and resumed.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field

import anthropic
import openai

from .tools import TOOLS

ANTHROPIC_MAX_TOKENS = 64000


class ProviderOutage(Exception):
    """The provider refused the turn for capacity reasons (rate limit, usage
    limit, overloaded, unreachable). The engine may fall back to another
    configured provider."""


_OUTAGE_TEXT = ("rate limit", "rate_limit", "usage limit", "overloaded", "capacity", "too many requests", "quota")


@dataclass
class Provider:
    id: str
    label: str
    kind: str  # "anthropic" | "openai"
    key_env: str
    key_url: str
    base_url: str | None
    models: list = field(default_factory=list)
    default_model: str = ""


PROVIDERS = {
    "claude": Provider(
        id="claude",
        label="Claude Code (your Claude plan)",
        kind="claude",
        key_env="",
        key_url="https://claude.com/product/claude-code",
        base_url=None,
        # Claude Code aliases resolve to the plan's current models. Fable is listed last:
        # on Kyle's Max plan Fable turns are billed as overage credits, so it is never a default.
        models=["opus", "sonnet", "haiku", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "fable", "claude-fable-5-1"],
        default_model="opus",
    ),
    "anthropic": Provider(
        id="anthropic",
        label="Anthropic (Claude)",
        kind="anthropic",
        key_env="ANTHROPIC_API_KEY",
        key_url="https://platform.claude.com/settings/keys",
        base_url=None,
        models=[
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001",
        ],
        default_model="claude-opus-4-8",
    ),
    "xiaomi": Provider(
        id="xiaomi",
        label="Xiaomi MiMo",
        kind="openai",
        key_env="XIAOMI_MIMO_API_KEY",
        key_url="https://platform.xiaomimimo.com",
        base_url="https://api.xiaomimimo.com/v1",
        models=["MiMo-V2.5-Pro", "MiMo-V2.5", "MiMo-V2-Pro", "MiMo-V2-Flash"],
        default_model="MiMo-V2.5-Pro",
    ),
    "deepseek": Provider(
        id="deepseek",
        label="DeepSeek",
        kind="openai",
        key_env="DEEPSEEK_API_KEY",
        key_url="https://platform.deepseek.com/api_keys",
        base_url="https://api.deepseek.com",
        models=["deepseek-chat", "deepseek-reasoner"],
        default_model="deepseek-chat",
    ),
    "qwen": Provider(
        id="qwen",
        label="Qwen (Alibaba)",
        kind="openai",
        key_env="DASHSCOPE_API_KEY",
        key_url="https://modelstudio.console.alibabacloud.com",
        base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        models=["qwen3-max", "qwen-plus", "qwen-turbo"],
        default_model="qwen3-max",
    ),
    "kimi": Provider(
        id="kimi",
        label="Kimi (Moonshot)",
        kind="openai",
        key_env="MOONSHOT_API_KEY",
        key_url="https://platform.moonshot.ai/console/api-keys",
        base_url="https://api.moonshot.ai/v1",
        models=["kimi-latest", "kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
        default_model="kimi-latest",
    ),
    "glm": Provider(
        id="glm",
        label="GLM (Zhipu / Z.ai)",
        kind="openai",
        key_env="ZAI_API_KEY",
        key_url="https://z.ai/manage-apikey/apikey-list",
        base_url="https://api.z.ai/api/paas/v4",
        models=["glm-4.6", "glm-4.5-air"],
        default_model="glm-4.6",
    ),
    "minimax": Provider(
        id="minimax",
        label="MiniMax",
        kind="openai",
        key_env="MINIMAX_API_KEY",
        key_url="https://platform.minimax.io",
        base_url="https://api.minimax.io/v1",
        models=["MiniMax-M2"],
        default_model="MiniMax-M2",
    ),
    "xiaokai": Provider(
        id="xiaokai",
        label="XiaoKai",
        kind="openai",
        key_env="XIAOKAI_API_KEY",
        key_url="",
        # TODO: point this at the real XiaoKai endpoint once it's live.
        base_url="https://api.xiaokai.ai/v1",
        models=["xiaokai"],
        default_model="xiaokai",
    ),
}


def _openai_tools() -> list:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in TOOLS
    ]


class AnthropicBackend:
    kind = "anthropic"

    def __init__(self, provider: Provider, api_key: str | None = None):
        self.provider = provider
        # api_key=None lets the SDK resolve env vars / `ant auth login` profiles
        self.client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    def validate(self) -> None:
        """Raise anthropic.AuthenticationError if credentials are bad. Free call."""
        self.client.models.retrieve("claude-opus-4-8")

    def run_turn(self, messages: list, model: str, system: str, hooks) -> None:
        """Run the agentic loop until the model stops requesting tools.

        Mutates `messages` (Anthropic Messages format, plain dicts) in place.
        """
        while True:
            kwargs = dict(
                model=model,
                max_tokens=ANTHROPIC_MAX_TOKENS,
                system=system,
                tools=TOOLS,
            )
            # Adaptive thinking is supported on Fable/Opus/Sonnet, not Haiku 4.5
            if not model.startswith("claude-haiku"):
                kwargs["thinking"] = {"type": "adaptive"}

            # Fable 5's safety classifiers can decline benign coding requests
            # (false positives happen on e.g. security-adjacent work). Opt into
            # the server-side fallback so a decline is transparently re-served
            # by Opus 4.8 inside the same call instead of failing the turn.
            if model.startswith(("claude-fable", "claude-mythos")):
                kwargs["betas"] = ["server-side-fallback-2026-06-01"]
                kwargs["fallbacks"] = [{"model": "claude-opus-4-8"}]
                stream_cm = self.client.beta.messages.stream(messages=messages, **kwargs)
            else:
                stream_cm = self.client.messages.stream(messages=messages, **kwargs)

            with stream_cm as stream:
                hooks.on_stream(stream.text_stream)
                response = stream.get_final_message()

            usage = response.usage
            cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
            cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
            hooks.usage(
                usage.input_tokens + cache_read + cache_write,
                usage.output_tokens,
                cache_read=cache_read,
                cache_write=cache_write,
            )

            # Preserve full content (thinking/text/tool_use blocks) in history,
            # as plain dicts so the conversation can be saved and resumed.
            # Informational "fallback" blocks are not valid input, so drop them.
            content = []
            for block in response.content:
                if getattr(block, "type", None) == "fallback":
                    hooks.info(
                        f"{block.from_.model} declined; answer served by {block.to.model}"
                    )
                    continue
                content.append(block.to_dict())
            messages.append({"role": "assistant", "content": content})

            if response.stop_reason == "refusal":
                hooks.notice("kcoder declined this request for safety reasons.")
                return
            if response.stop_reason == "max_tokens":
                hooks.notice("Response hit the output token limit and may be incomplete.")
                return

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                return

            results = []
            for block in tool_uses:
                content, is_error = hooks.handle_tool_call(
                    block.name, dict(block.input), call_id=block.id
                )
                result = {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": content,
                }
                if is_error:
                    result["is_error"] = True
                results.append(result)
            messages.append({"role": "user", "content": results})


class OpenAIBackend:
    kind = "openai"

    def __init__(self, provider: Provider, api_key: str, base_url: str | None = None):
        self.provider = provider
        self.client = openai.OpenAI(
            api_key=api_key or "EMPTY",  # local servers often need a placeholder
            base_url=base_url or provider.base_url,
        )
        self.tools = _openai_tools()

    def validate(self) -> None:
        """Raise openai.AuthenticationError if the key is bad.

        Uses /models, which most providers implement; providers that don't
        (or that error for other reasons) are accepted and any real problem
        surfaces on the first chat request.
        """
        try:
            self.client.models.list()
        except openai.AuthenticationError:
            raise
        except Exception:
            pass

    def run_turn(self, messages: list, model: str, system: str, hooks) -> None:
        """Agentic loop over an OpenAI-compatible /chat/completions API.

        Mutates `messages` (OpenAI chat format) in place.
        """
        while True:
            stream = self.client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}] + messages,
                tools=self.tools,
                stream=True,
            )

            state = {"text": "", "calls": {}, "finish": None, "usage": None}

            def text_iter():
                for chunk in stream:
                    if getattr(chunk, "usage", None):
                        state["usage"] = chunk.usage
                    if not chunk.choices:
                        continue
                    choice = chunk.choices[0]
                    if choice.finish_reason:
                        state["finish"] = choice.finish_reason
                    delta = choice.delta
                    if delta is None:
                        continue
                    if delta.content:
                        state["text"] += delta.content
                        yield delta.content
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            slot = state["calls"].setdefault(
                                tc.index, {"id": "", "name": "", "args": ""}
                            )
                            if tc.id:
                                slot["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    slot["name"] = tc.function.name
                                if tc.function.arguments:
                                    slot["args"] += tc.function.arguments

            hooks.on_stream(text_iter())

            # Some providers attach usage to the final chunk without being asked
            if state["usage"] is not None:
                hooks.usage(state["usage"].prompt_tokens, state["usage"].completion_tokens)

            calls = [state["calls"][i] for i in sorted(state["calls"])]
            assistant: dict = {"role": "assistant", "content": state["text"]}
            if calls:
                assistant["tool_calls"] = [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": c["name"], "arguments": c["args"] or "{}"},
                    }
                    for c in calls
                ]
            messages.append(assistant)

            if not calls:
                if state["finish"] == "length":
                    hooks.notice("Response hit the output token limit and may be incomplete.")
                return

            for c in calls:
                try:
                    tool_input = json.loads(c["args"]) if c["args"] else {}
                    content, is_error = hooks.handle_tool_call(c["name"], tool_input, call_id=c["id"])
                except json.JSONDecodeError as exc:
                    content = f"Error: tool arguments were not valid JSON: {exc}"
                messages.append({
                    "role": "tool",
                    "tool_call_id": c["id"],
                    "content": content,
                })


# ----------------------------------------------------------------------
# Claude Code: drive the `claude` CLI so usage comes out of the user's
# Claude plan instead of API tokens. Claude Code runs the tools itself;
# we mirror its stream-json events into kcoder's event stream.
# ----------------------------------------------------------------------

CLAUDE_BIN = "claude"
_CLAUDE_FALLBACKS = [
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.claude/local/claude",
    "~/.local/bin/claude", "~/.bun/bin/claude", "~/.npm-global/bin/claude",
]


def claude_path() -> str | None:
    """Absolute path of the `claude` CLI: PATH first, then the usual install spots."""
    found = shutil.which(CLAUDE_BIN)
    if found:
        return found
    for cand in _CLAUDE_FALLBACKS:
        cand = os.path.expanduser(cand)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def claude_available() -> bool:
    return claude_path() is not None


def _spawn_claude(args: list, cwd: str, attempts: int = 4):
    """Popen the claude CLI, retrying briefly when the binary is missing.

    Claude Code updates itself by replacing its binary in place, so for a
    second or two `claude` does not exist on disk; without the retry a turn
    that lands in that window dies with FileNotFoundError.
    """
    last: Exception | None = None
    for attempt in range(attempts):
        args[0] = claude_path() or CLAUDE_BIN
        try:
            return subprocess.Popen(
                args, cwd=cwd, env=_claude_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, start_new_session=True,
            )
        except FileNotFoundError as exc:
            last = exc
            if attempt < attempts - 1:
                time.sleep(1.5)
    raise RuntimeError(
        "the `claude` CLI could not be started (not on PATH, or Claude Code was mid-update). "
        f"Try again in a moment. ({last})"
    )


def _claude_env() -> dict:
    from . import identity
    env = identity.git_env()          # commits inside Claude Code are signed as the user's GitHub account
    for k in list(env):
        if k.startswith("CLAUDE_CODE") or k in ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"):
            env.pop(k, None)   # nested Claude Code sessions refuse to start
    return env


def _claude_settings() -> str | None:
    """Inline settings for `claude --settings`: no AI attribution on commits
    unless the user configured a trailer."""
    from . import identity
    if identity.trailer():
        return None
    import json as _json
    return _json.dumps({"includeCoAuthoredBy": False, "attribution": {"commit": "", "pr": ""}})


def describe_claude_tool(name: str, inp: dict) -> str:
    inp = inp or {}
    if name == "Bash":
        return f"Bash: {inp.get('command', '')}"
    if name in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit"):
        return f"{name}: {inp.get('file_path') or inp.get('notebook_path') or ''}"
    if name in ("Grep", "Glob"):
        return f"{name}: {inp.get('pattern', '')}" + (f" in {inp['path']}" if inp.get("path") else "")
    if name in ("WebFetch", "WebSearch"):
        return f"{name}: {inp.get('url') or inp.get('query') or ''}"
    if name == "Task":
        return f"Task: {inp.get('description') or ''}"
    if name == "TodoWrite":
        return "TodoWrite"
    short = json.dumps(inp)
    return f"{name}: {short[:160]}" + ("…" if len(short) > 160 else "")


class ClaudeCodeBackend:
    kind = "claude"

    def __init__(self, provider: Provider):
        self.provider = provider
        self.session_id: str | None = None   # Claude Code's own session, persisted by the daemon

    def validate(self) -> None:
        if not claude_available():
            raise RuntimeError("the `claude` CLI is not installed")
        subprocess.run([claude_path() or CLAUDE_BIN, "--version"], capture_output=True, timeout=20)

    def run_turn(self, messages: list, model: str, system: str, hooks) -> None:
        from .engine import Interrupted

        last = messages[-1]
        prompt = _prompt_text(last)
        trust = getattr(hooks, "trust", "read")
        args = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if model:
            args += ["--model", model]
        if trust == "auto":
            args += ["--dangerously-skip-permissions"]
        elif trust == "write":
            args += ["--permission-mode", "acceptEdits"]
        else:
            args += ["--permission-mode", "default"]   # headless: anything needing approval is denied
        if self.session_id:
            args += ["--resume", self.session_id]
        if system:
            args += ["--append-system-prompt", system]
        settings = _claude_settings()
        if settings:
            args += ["--settings", settings]
        cwd = getattr(hooks, "cwd", None) or os.getcwd()
        proc = _spawn_claude(args, cwd)
        if hasattr(hooks, "proc"):
            hooks.proc = proc
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

        lines: queue.Queue = queue.Queue()

        def reader():
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)

        threading.Thread(target=reader, daemon=True).start()

        emit = getattr(hooks, "emit", None)
        blocks: list = []          # content blocks of the current assistant message
        text = ""                  # text of the current streaming text block
        streaming = False
        got_result = False
        pending_tools: dict[str, str] = {}

        def flush_assistant():
            nonlocal blocks
            if blocks:
                messages.append({"role": "assistant", "content": blocks})
                blocks = []

        try:
            while True:
                try:
                    line = lines.get(timeout=0.25)
                except queue.Empty:
                    check = getattr(hooks, "_check_interrupt", None)
                    if check:
                        check()
                    continue
                if line is None:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = d.get("type")
                if t == "system" and d.get("subtype") == "init":
                    self.session_id = d.get("session_id") or self.session_id
                elif t == "stream_event":
                    ev = d.get("event") or {}
                    et = ev.get("type")
                    if et == "content_block_start" and (ev.get("content_block") or {}).get("type") == "text":
                        text = ""
                        streaming = True
                        if emit:
                            emit("assistant_start")
                    elif et == "content_block_delta":
                        delta = ev.get("delta") or {}
                        if delta.get("type") == "text_delta" and streaming:
                            piece = delta.get("text") or ""
                            text += piece
                            if emit and piece:
                                emit("text", delta=piece)
                    elif et == "content_block_stop" and streaming:
                        streaming = False
                        if emit:
                            emit("assistant_end", text=text)
                elif t == "assistant":
                    for b in (d.get("message") or {}).get("content") or []:
                        bt = b.get("type")
                        if bt == "text":
                            blocks.append({"type": "text", "text": b.get("text", "")})
                            if not emit:
                                hooks.on_stream(iter([b.get("text", "")]))
                        elif bt == "tool_use":
                            blocks.append({"type": "tool_use", "id": b.get("id"), "name": b.get("name"), "input": b.get("input") or {}})
                            pending_tools[b.get("id")] = b.get("name")
                            desc = describe_claude_tool(b.get("name"), b.get("input") or {})
                            if hasattr(hooks, "on_external_tool_call"):
                                hooks.on_external_tool_call(b.get("id"), b.get("name"), b.get("input") or {}, desc)
                elif t == "user":
                    flush_assistant()
                    results = []
                    for b in (d.get("message") or {}).get("content") or []:
                        if b.get("type") != "tool_result":
                            continue
                        content = b.get("content")
                        if isinstance(content, list):
                            content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict))
                        content = str(content or "")
                        results.append({"type": "tool_result", "tool_use_id": b.get("tool_use_id"), "content": content,
                                        **({"is_error": True} if b.get("is_error") else {})})
                        if hasattr(hooks, "on_external_tool_result"):
                            hooks.on_external_tool_result(b.get("tool_use_id"), pending_tools.get(b.get("tool_use_id"), "tool"),
                                                          content, bool(b.get("is_error")))
                    if results:
                        messages.append({"role": "user", "content": results})
                elif t == "result":
                    got_result = True
                    self.session_id = d.get("session_id") or self.session_id
                    u = d.get("usage") or {}
                    cr = int(u.get("cache_read_input_tokens") or 0)
                    cw = int(u.get("cache_creation_input_tokens") or 0)
                    hooks.usage(int(u.get("input_tokens") or 0) + cr + cw, int(u.get("output_tokens") or 0),
                                cache_read=cr, cache_write=cw, cost=float(d.get("total_cost_usd") or 0.0))
                    if d.get("is_error") or d.get("subtype") not in (None, "success"):
                        text_ = f"{d.get('subtype') or ''} {str(d.get('result') or '')}"
                        if any(k in text_.lower() for k in _OUTAGE_TEXT):
                            _kill(proc)
                            raise ProviderOutage(f"Claude Code: {text_.strip()[:200]}")
                        hooks.notice(f"Claude Code: {d.get('subtype')}: {str(d.get('result') or '')[:500]}")
        except Interrupted:
            _kill(proc)
            raise
        finally:
            if hasattr(hooks, "proc"):
                hooks.proc = None
        flush_assistant()
        code = proc.wait(timeout=10)
        if not got_result:
            err = (proc.stderr.read() or "").strip()
            if "not logged in" in err.lower() or "login" in err.lower():
                raise RuntimeError("Claude Code is not logged in - run `claude` once in a terminal and sign in.")
            raise RuntimeError(f"claude exited with {code}: {err[-600:] or 'no output'}")


def _prompt_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    parts = []
    imgs = 0
    for b in content or []:
        if b.get("type") == "text":
            parts.append(b["text"])
        elif b.get("type") in ("image", "image_url"):
            imgs += 1
    if imgs:
        parts.append(f"({imgs} image(s) were attached; see the uploads folder of this session)")
    return "\n".join(parts)


def _kill(proc) -> None:
    import signal
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, AttributeError):
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass


def make_backend(provider: Provider, api_key: str | None, base_url: str | None = None):
    if provider.kind == "claude":
        return ClaudeCodeBackend(provider)
    if provider.kind == "anthropic":
        return AnthropicBackend(provider, api_key)
    return OpenAIBackend(provider, api_key or "", base_url)
