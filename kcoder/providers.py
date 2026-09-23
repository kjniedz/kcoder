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
from dataclasses import dataclass, field

import anthropic
import openai

from .tools import TOOLS

ANTHROPIC_MAX_TOKENS = 64000


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
            prompt_tokens = (
                usage.input_tokens
                + (getattr(usage, "cache_read_input_tokens", 0) or 0)
                + (getattr(usage, "cache_creation_input_tokens", 0) or 0)
            )
            hooks.usage(prompt_tokens, usage.output_tokens)

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


def make_backend(provider: Provider, api_key: str | None, base_url: str | None = None):
    if provider.kind == "anthropic":
        return AnthropicBackend(provider, api_key)
    return OpenAIBackend(provider, api_key or "", base_url)
