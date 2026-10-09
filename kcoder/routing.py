"""Model routing and provider fallback.

Routing: a session (or task) whose model is "auto" gets a cheaper model for
small tasks and a stronger one for large or multi-file work, per provider
tier table (config `routing.tiers.<provider> = {"small": ..., "large": ...}`
overrides the defaults below). Setting a concrete model on a session or a
task turns routing off for it.

Fallback candidates are chosen by the daemon (see Manager.fallbacks): the
next configured provider, never from a subscription (Claude Code, kind
"claude") to a pay-per-token API key unless config `fallback.to_api` is on,
and never to a paid provider once the daily spend cap is reached.
"""

from __future__ import annotations

import re

AUTO = "auto"

TIERS = {
    "claude": {"small": "sonnet", "large": "opus"},   # stays on the plan (Fable bills credits)
    "anthropic": {"small": "claude-haiku-4-5-20251001", "large": "claude-opus-4-8"},
}

_MULTI = re.compile(
    r"\b(refactor|migrat\w*|across|all (?:the )?files|every file|multiple files|whole (?:repo|project|codebase)|"
    r"everywhere|implement|build|architect\w*|end-to-end|integration|redesign|rewrite|overhaul|upgrade)\b", re.I)
_PATHS = re.compile(r"[\w./-]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|md|json|yml|yaml|css|html|sql|sh)\b")


def tiers_for(provider, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    custom = ((cfg.get("routing") or {}).get("tiers") or {}).get(provider.id) or {}
    base = dict(TIERS.get(provider.id) or {})
    base.update({k: v for k, v in custom.items() if v})
    return base


def has_tiers(provider, cfg: dict | None = None) -> bool:
    t = tiers_for(provider, cfg)
    return bool(t.get("small") and t.get("large"))


def enabled(cfg: dict | None) -> bool:
    return bool(((cfg or {}).get("routing") or {}).get("enabled", True))


def classify(text: str, context_tokens: int = 0) -> str:
    """'small' or 'large' for one turn."""
    t = (text or "").strip()
    if context_tokens and context_tokens > 60_000:
        return "large"
    words = len(t.split())
    if words > 120 or t.count("\n") > 15:
        return "large"
    if _MULTI.search(t) or len(set(_PATHS.findall(t))) >= 2:
        return "large"
    return "small"


def model_for(provider, tier: str, cfg: dict | None = None) -> str:
    return tiers_for(provider, cfg).get(tier) or provider.default_model


def pick(provider, text: str, context_tokens: int, cfg: dict | None = None) -> tuple:
    """(model, tier) for a turn on a session whose model is `auto`."""
    tier = classify(text, context_tokens)
    return model_for(provider, tier, cfg), tier


def default_model(provider, cfg: dict | None = None) -> str:
    """What a new session gets when no model was chosen."""
    return AUTO if enabled(cfg) and has_tiers(provider, cfg) else provider.default_model
