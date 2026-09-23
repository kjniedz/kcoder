"""Model pricing (USD per million tokens) and cost calculation.

Anthropic first-party rates as of 2026-06. Other providers are approximate
and can be overridden in ~/.config/kcoder/config.json under "pricing":

    "pricing": {"deepseek-chat": {"input": 0.27, "output": 1.10}}

Unknown models cost $0 (tracked as tokens only).
"""

from __future__ import annotations

# model id prefix -> (input $/M, output $/M). Longest prefix wins.
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-mythos-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    # approximate list rates for other providers
    "deepseek-chat": (0.27, 1.10),
    "deepseek-reasoner": (0.55, 2.19),
    "kimi-k2": (0.60, 2.50),
    "kimi-latest": (0.60, 2.50),
    "glm-4.6": (0.60, 2.20),
    "glm-4.5-air": (0.20, 1.10),
    "qwen3-max": (1.20, 6.00),
    "qwen-plus": (0.40, 1.20),
    "qwen-turbo": (0.05, 0.20),
    "MiniMax-M2": (0.30, 1.20),
}

CACHE_READ_FACTOR = 0.1     # cache reads bill at ~10% of input
CACHE_WRITE_FACTOR = 1.25   # cache writes bill at 125% of input

_overrides: dict[str, tuple[float, float]] = {}


def set_overrides(table: dict) -> None:
    _overrides.clear()
    for model, p in (table or {}).items():
        try:
            _overrides[model] = (float(p["input"]), float(p["output"]))
        except (KeyError, TypeError, ValueError):
            continue


def rates(model: str) -> tuple[float, float] | None:
    model = model or ""
    best = None
    for table in (_overrides, PRICES):
        for prefix, p in table.items():
            if model.startswith(prefix) and (best is None or len(prefix) > best[0]):
                best = (len(prefix), p)
        if best:
            return best[1]
    return None


def cost(model: str, input_tokens: int, output_tokens: int,
         cache_read: int = 0, cache_write: int = 0) -> float:
    """USD for one call. `input_tokens` is the uncached portion."""
    r = rates(model)
    if not r:
        return 0.0
    inp, out = r
    return (
        input_tokens * inp
        + cache_read * inp * CACHE_READ_FACTOR
        + cache_write * inp * CACHE_WRITE_FACTOR
        + output_tokens * out
    ) / 1_000_000


def fmt_usd(amount: float) -> str:
    if amount >= 100:
        return f"${amount:,.0f}"
    if amount >= 10:
        return f"${amount:,.1f}"
    return f"${amount:,.2f}"
