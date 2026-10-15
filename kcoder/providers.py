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
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

import anthropic
import openai

from . import compat
from .tools import TOOLS

ANTHROPIC_MAX_TOKENS = 64000


class ProviderOutage(Exception):
    """The provider refused the turn for capacity reasons (rate limit, usage
    limit, overloaded, unreachable). The engine may fall back to another
    configured provider."""


class PlanLimitReached(Exception):
    """A Claude plan limit is used up, or the next request would be billed as
    extra usage credits. kcoder stops here: no retry, no fallback, no credits."""

    def __init__(self, message: str, *, resets_at: float | None = None, scope: str = "all", limit: str | None = None):
        super().__init__(message)
        self.resets_at = resets_at
        self.scope = scope
        self.limit = limit


class NotOnPlan(Exception):
    """Claude Code is not signed in with a Claude subscription (no login, or an
    API key / Console / cloud account that bills per token). The fix is to
    reconnect the Claude account; kcoder never runs Claude Code that way."""


_OUTAGE_TEXT = ("rate limit", "rate_limit", "usage limit", "session limit", "weekly limit", "credit balance", "overloaded",
                "capacity", "too many requests", "quota")


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
        # Fable draws on its own weekly allowance, so it is never a default; at any limit kcoder stops (no credits).
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


# models that take images. Claude (plan and API) always does; for the OpenAI-compatible
# providers only the multimodal models are listed, so a screenshot is never sent to a model
# that would error or silently ignore it.
_VISION_ALL = {"claude", "anthropic"}
_VISION_MODELS = {
    "kimi": ("kimi-latest",),
    "xiaomi": ("MiMo-V2.5-Pro", "MiMo-V2.5"),
}
_VISION_HINT = re.compile(r"(vl|vision|omni|-v\d|4o|gpt-5|gemini|pixtral|llava)", re.I)


def supports_images(provider_id: str, model: str | None) -> bool:
    if provider_id in _VISION_ALL:
        return True
    m = (model or "").strip()
    if m in _VISION_MODELS.get(provider_id, ()):
        return True
    return bool(m) and bool(_VISION_HINT.search(m))


def vision_models(provider) -> list | str:
    """'all' or the subset of `provider.models` that accept images (for the app)."""
    if provider.id in _VISION_ALL:
        return "all"
    return [m for m in provider.models if supports_images(provider.id, m)]


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
    "~/.local/bin/claude.exe", "~/AppData/Roaming/npm/claude.cmd",   # Windows: native installer, npm
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


def _spawn_claude(args: list, cwd: str, attempts: int = 4, env: dict | None = None):
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
                args, cwd=cwd, env=env or _claude_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", **compat.own_group(),
            )
        except FileNotFoundError as exc:
            last = exc
            if attempt < attempts - 1:
                time.sleep(1.5)
    raise RuntimeError(
        "the `claude` CLI could not be started (not on PATH, or Claude Code was mid-update). "
        f"Try again in a moment. ({last})"
    )


# Claude Code bills whatever credential it finds first. Any of these in its
# environment would move a turn off the Claude plan onto per-token billing.
_PAID_AUTH_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
                  "ANTHROPIC_VERTEX_PROJECT_ID", "AWS_BEARER_TOKEN_BEDROCK")


def _claude_env() -> dict:
    from . import identity
    env = identity.git_env()          # commits inside Claude Code are signed as the user's GitHub account
    for k in list(env):
        if k.startswith("CLAUDE_CODE") or k in ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"):
            env.pop(k, None)   # nested Claude Code sessions refuse to start (also drops CLAUDE_CODE_USE_BEDROCK/VERTEX)
        elif k in _PAID_AUTH_ENV:
            env.pop(k, None)   # plan only: never hand Claude Code an API key
    # shell tools get ten minutes (an hour when the model asks); longer work goes through `kcoder job`
    env.setdefault("BASH_DEFAULT_TIMEOUT_MS", "600000")
    env.setdefault("BASH_MAX_TIMEOUT_MS", "3600000")
    return env


# ----------------------------------------------------------------------
# plan only: which login Claude Code uses, and the limits it reports
# ----------------------------------------------------------------------

# `claude auth status` authMethod values that are a Claude subscription login
PLAN_AUTH_METHODS = ("claude.ai", "oauth_token")
_auth_cache: dict = {}
AUTH_CACHE_SECONDS = 60


def claude_auth(refresh: bool = False) -> dict:
    """{installed, logged_in, method, on_plan, email, error} for the login Claude Code would use in a kcoder turn."""
    now = time.time()
    if not refresh and _auth_cache.get("at", 0) > now - AUTH_CACHE_SECONDS:
        return dict(_auth_cache["info"])
    path = claude_path()
    info = {"installed": path is not None, "logged_in": False, "method": None, "on_plan": False, "email": None, "error": None}
    if path:
        try:
            out = subprocess.run([path, "auth", "status", "--json"], capture_output=True, text=True, timeout=20, env=_claude_env())
            data = json.loads(out.stdout or "{}")
            info["logged_in"] = bool(data.get("loggedIn"))
            info["method"] = data.get("authMethod")
            info["email"] = data.get("email")
            info["on_plan"] = info["logged_in"] and info["method"] in PLAN_AUTH_METHODS and data.get("apiProvider", "firstParty") == "firstParty"
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError) as exc:
            info["error"] = str(exc)[:200]
    _auth_cache.update(at=now, info=info)
    return dict(info)


def forget_claude_auth() -> None:
    _auth_cache.clear()


def not_on_plan_reason(info: dict) -> str | None:
    if not info["installed"]:
        return "Claude Code is not installed."
    if not info["logged_in"]:
        return "Claude Code is not signed in to your Claude account."
    if not info["on_plan"]:
        how = {"api_key": "an API key", "api_key_helper": "an API key helper", "third_party": "a cloud provider account"}.get(info["method"], info["method"] or "an unknown login")
        return f"Claude Code is signed in with {how}, which bills per token, not your Claude plan."
    return None


# rateLimitType (from Claude Code's rate_limit_event) -> which models it stops
_LIMIT_SCOPE = {"five_hour": "all", "seven_day": "all", "seven_day_opus": "opus", "seven_day_sonnet": "sonnet",
                "seven_day_overage_included": "fable", "overage": "fable"}
_LIMIT_LABEL = {"five_hour": "5-hour limit", "seven_day": "weekly limit", "seven_day_opus": "weekly Opus limit",
                "seven_day_sonnet": "weekly Sonnet limit", "seven_day_overage_included": "weekly Fable limit",
                "overage": "extra usage"}
_SCOPE_LABEL = {"all": "Claude", "opus": "Opus", "sonnet": "Sonnet", "fable": "Fable"}


def model_family(model: str | None) -> str:
    m = (model or "").lower()
    for fam in ("fable", "opus", "sonnet", "haiku"):
        if fam in m:
            return fam
    return "opus" if not m or m in ("default", "opusplan") else "other"


def _load_limits() -> dict:
    from . import paths
    try:
        with open(paths.PLAN_LIMITS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_limits(data: dict) -> None:
    from . import paths
    paths.ensure_data_dir()
    tmp = paths.PLAN_LIMITS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, paths.PLAN_LIMITS_PATH)


def plan_limits() -> dict:
    """{scope: {until, limit, label, reason}} for limits that have not reset yet."""
    now = time.time()
    data = _load_limits()
    live = {k: v for k, v in data.items() if float(v.get("until") or 0) > now}
    if live != data:
        _save_limits(live)
    return live


def clear_plan_limits() -> None:
    _save_limits({})


def _block(scope: str, until: float, limit: str | None, reason: str) -> None:
    data = plan_limits()
    data[scope] = {"until": until, "limit": limit, "label": _LIMIT_LABEL.get(limit or "", "plan limit"), "reason": reason[:300]}
    _save_limits(data)


def _load_usage() -> dict:
    from . import paths
    try:
        with open(paths.PLAN_USAGE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def record_plan_usage(limit: str, utilization: float | None, resets_at: float | None, status: str | None) -> None:
    """Claude Code reports, with every request, how much of a plan limit is used (0..1)."""
    if not limit or utilization is None:
        return
    from . import paths
    data = _load_usage()
    data[limit] = {"utilization": max(0.0, min(1.0, float(utilization))), "resets_at": resets_at, "status": status or "", "seen": time.time(),
                   "label": _LIMIT_LABEL.get(limit, limit)}
    tmp = paths.PLAN_USAGE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, paths.PLAN_USAGE_PATH)


def plan_usage() -> list:
    """[{limit, label, utilization, resets_at, seen, stale}] newest window first. A window
    whose reset time passed is kept at 0 until the next turn reports it."""
    now = time.time()
    out = []
    for k, v in _load_usage().items():
        stale = bool(v.get("resets_at")) and float(v["resets_at"]) < now
        out.append({"limit": k, "label": v.get("label") or _LIMIT_LABEL.get(k, k), "utilization": 0.0 if stale else float(v.get("utilization") or 0.0),
                    "resets_at": None if stale else v.get("resets_at"), "seen": v.get("seen"), "stale": stale, "status": v.get("status")})
    order = {"five_hour": 0, "seven_day": 1, "seven_day_opus": 2, "seven_day_sonnet": 3, "seven_day_overage_included": 4, "overage": 5}
    return sorted(out, key=lambda r: order.get(r["limit"], 9))


def plan_block_for(model: str | None) -> dict | None:
    lim = plan_limits()
    return lim.get("all") or lim.get(model_family(model))


def _when(ts: float | None) -> str:
    if not ts:
        return "when it resets"
    import datetime
    d = datetime.datetime.fromtimestamp(ts)
    today = datetime.date.today()
    day = "today" if d.date() == today else ("tomorrow" if (d.date() - today).days == 1 else f"{d:%a %b} {d.day}")
    return f"{day} at " + f"{d.hour % 12 or 12}:{d:%M %p}".lower()   # no %-I: Windows strftime rejects it


def plan_limit_message(scope: str, limit: str | None, resets_at: float | None, *, credits: bool) -> str:
    what = _LIMIT_LABEL.get(limit or "", "Claude plan limit")
    who = _SCOPE_LABEL.get(scope, "Claude")
    head = (f"Your {what} is used up and {who} switched to extra usage credits, so kcoder stopped the turn at once. "
            if credits else f"Your {what} is reached, so kcoder stopped instead of spending credits. ")
    tail = f"{who} is available again {_when(resets_at)}."
    if scope != "all":
        tail += " Other models on your plan still work: switch with /model."
    return head + tail


def _claude_settings(sid: str | None = None) -> str | None:
    """Inline settings for `claude --settings`: no AI attribution on commits
    (unless the user configured a trailer), and the connector-approval hook
    that routes every `mcp__*` tool call through kcoder (reads pass, writes
    wait for approval); the same hook applies KCODER.md rules to Edit / Write /
    Bash."""
    import json as _json
    import shlex as _shlex
    from . import identity, paths
    settings: dict = {}
    if not identity.trailer():
        settings.update({"includeCoAuthoredBy": False, "attribution": {"commit": "", "pr": ""}})
    if sid:
        cmd = f"{_shlex.quote(sys.executable)} -P -m kcoder.permit --sid {_shlex.quote(str(sid))} --data-dir {_shlex.quote(paths.DATA_DIR)}"
        settings["hooks"] = {"PreToolUse": [{"matcher": "mcp__.*", "hooks": [{"type": "command", "command": cmd, "timeout": 600}]},
                                            {"matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [{"type": "command", "command": cmd, "timeout": 30}]}]}
    return _json.dumps(settings) if settings else None


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

        blocked = plan_block_for(model)
        if blocked:
            scope = "all" if plan_limits().get("all") else model_family(model)
            raise PlanLimitReached(plan_limit_message(scope, blocked.get("limit"), blocked.get("until"), credits=False),
                                   resets_at=blocked.get("until"), scope=scope, limit=blocked.get("limit"))
        reason = not_on_plan_reason(claude_auth(refresh=True))   # ~0.2s; a stale "on plan" must never let a turn through
        if reason:
            raise NotOnPlan(reason)

        last = messages[-1]
        prompt = _prompt_text(last)
        blocks = _prompt_blocks(last)      # text + image blocks: sent as a stream-json user message
        trust = getattr(hooks, "trust", "read")
        args = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if blocks is not None:
            args += ["--input-format", "stream-json"]
        if model:
            args += ["--model", model]
        if trust == "auto":
            args += ["--dangerously-skip-permissions"]
        elif trust == "write":
            args += ["--permission-mode", "acceptEdits"]
        elif trust == "dry":
            args += ["--permission-mode", "plan"]     # dry run: Claude Code reads and plans, edits are off
        else:
            args += ["--permission-mode", "default"]   # headless: anything needing approval is denied
        if self.session_id:
            args += ["--resume", self.session_id]
        if system:
            args += ["--append-system-prompt", system]
        settings = _claude_settings(getattr(hooks, "sid", None))
        if settings:
            args += ["--settings", settings]
        args += list(getattr(hooks, "claude_args", None) or [])   # one-off calls (recaps) add --tools "" etc.
        cwd = getattr(hooks, "cwd", None) or os.getcwd()
        env = _claude_env()
        if getattr(hooks, "session_env", None):
            env.update({k: v for k, v in hooks.session_env().items() if v})
        proc = _spawn_claude(args, cwd, env=env)
        if hasattr(hooks, "proc"):
            hooks.proc = proc
        try:
            if blocks is not None:
                proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": blocks}}) + "\n")
            else:
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
        prog_in = prog_out = 0      # running token totals for the live status line
        context = 0                 # prompt size of the latest model call (= the context the session is at)

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
                    src = d.get("apiKeySource")
                    if src not in (None, "none", "oauth"):
                        _kill(proc)
                        forget_claude_auth()
                        raise NotOnPlan(f"Claude Code picked up a per-token credential ({src}) instead of your Claude plan.")
                elif t == "rate_limit_event":
                    info = d.get("rate_limit_info") or {}
                    limit = info.get("rateLimitType")
                    resets = info.get("resetsAt")
                    resets = float(resets) / (1000.0 if resets and float(resets) > 1e11 else 1.0) if resets else None
                    credits = bool(info.get("isUsingOverage"))
                    util = info.get("utilization")
                    if util is not None and limit:
                        try:
                            prev_global = (_load_usage().get(limit) or {}).get("utilization")
                            record_plan_usage(limit, float(util), resets, info.get("status"))
                            if getattr(hooks, "plan_usage", None):
                                hooks.plan_usage(limit, float(util), resets, info.get("status"), prev_global)
                        except Exception:  # noqa: BLE001 - bookkeeping never stops a turn
                            pass
                    if credits or info.get("status") == "rejected":
                        _kill(proc)
                        scope = _LIMIT_SCOPE.get(limit or "", "all")
                        msg = plan_limit_message(scope, limit, resets, credits=credits)
                        _block(scope, resets or time.time() + 3600, limit, msg)
                        raise PlanLimitReached(msg, resets_at=resets, scope=scope, limit=limit)
                    if info.get("status") == "allowed_warning" and not getattr(self, "_warned", None) == limit:
                        self._warned = limit
                        hooks.notice(f"Close to your {_LIMIT_LABEL.get(limit or '', 'plan limit')} (resets {_when(resets)}). "
                                     "kcoder stops at the limit instead of using credits.")
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
                    mu = (d.get("message") or {}).get("usage") or {}
                    if mu:
                        call_in = int(mu.get("input_tokens") or 0) + int(mu.get("cache_read_input_tokens") or 0) + int(mu.get("cache_creation_input_tokens") or 0)
                        context = call_in or context
                        if hasattr(hooks, "progress"):
                            prog_in += call_in
                            prog_out += int(mu.get("output_tokens") or 0)
                            hooks.progress(prog_in, prog_out)
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
                    # The result's usage is the sum over every model call of the turn (what the
                    # turn cost), not the size of the conversation: a turn with ten tool calls
                    # at 30k context reports 300k input. The context the session is at is the
                    # prompt size of the last call, taken from the assistant messages above.
                    u = d.get("usage") or {}
                    cr = int(u.get("cache_read_input_tokens") or 0)
                    cw = int(u.get("cache_creation_input_tokens") or 0)
                    total_in = int(u.get("input_tokens") or 0) + cr + cw
                    hooks.usage(total_in, int(u.get("output_tokens") or 0), cache_read=cr, cache_write=cw,
                                cost=float(d.get("total_cost_usd") or 0.0), context=min(context, total_in) if context else None)
                    if d.get("is_error") or d.get("subtype") not in (None, "success"):
                        text_ = f"{d.get('subtype') or ''} {str(d.get('result') or '')}"
                        low = text_.lower()
                        if any(k in low for k in ("usage limit", "hit your limit", "session limit", "weekly limit",
                                                  "credit balance", "out of usage", "extra usage", "out of credits")):
                            _kill(proc)
                            raise PlanLimitReached("Claude Code: " + text_.strip()[:300] +
                                                   ". kcoder stopped instead of spending credits.", scope="all")
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
                forget_claude_auth()
                raise NotOnPlan("Claude Code is not signed in to your Claude account.")
            if code in (143, -15, 137, -9):
                raise RuntimeError(f"Claude Code was stopped from outside this turn ({'SIGKILL' if code in (137, -9) else 'SIGTERM'}, exit {code}): "
                                   "another kcoderd instance, a kill command, or the system ended it. Nothing was re-run; send the message again.")
            raise RuntimeError(f"claude exited with {code}: {err[-600:] or 'no output'}")


def _prompt_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    return "\n".join(b["text"] for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def _prompt_blocks(msg: dict) -> list | None:
    """The user message as Anthropic content blocks when it carries images
    (Claude Code only takes images over stream-json input); None for text."""
    content = msg.get("content")
    if not isinstance(content, list):
        return None
    out = []
    imgs = 0
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            out.append({"type": "text", "text": b.get("text", "")})
        elif b.get("type") == "image":
            out.append(b)
            imgs += 1
        elif b.get("type") == "image_url":   # an OpenAI-style block from an older history
            url = (b.get("image_url") or {}).get("url") or ""
            if url.startswith("data:"):
                header, _, data = url.partition(",")
                out.append({"type": "image", "source": {"type": "base64", "media_type": header[5:].split(";")[0] or "image/png", "data": data}})
                imgs += 1
    return out if imgs else None


def _kill(proc) -> None:
    from . import compat
    try:
        compat.kill_tree(proc.pid)
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
