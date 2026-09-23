"""User-editable settings: ~/.config/kcoder/config.json

    {
      "banner": true,              // show the big banner on launch
      "animation": true,           // animated banner reveal (also off when
                                   //   not a TTY or reduce-motion is on)
      "taglines": ["...", "..."],  // one is picked at random under the credit
      "pricing": {"model": {"input": $/M, "output": $/M}}
    }

Credentials stay in credentials.json; nothing secret lives here.
"""

from __future__ import annotations

import json
import os

from . import pricing
from .paths import CONFIG_DIR

CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

DEFAULT_TAGLINES = [
    "ten agents, one keyboard.",
    "ship it before the coffee cools.",
    "the factory floor is quiet. that's the point.",
    "parallel by default.",
    "reads the code so you don't have to. mostly.",
    "less typing, more shipping.",
    "every session earns its keep.",
    "built in the mountains, runs anywhere.",
    "your turn to approve, its turn to build.",
    "small commits, big days.",
]

DEFAULTS = {
    "banner": True,
    "animation": True,
    "taglines": DEFAULT_TAGLINES,
    "pricing": {},
}

_cache: dict | None = None


def load(create: bool = True) -> dict:
    """Read the config, writing the defaults file the first time so the
    user has something to edit."""
    global _cache
    if _cache is not None:
        return _cache
    data = {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except FileNotFoundError:
        if create:
            try:
                os.makedirs(CONFIG_DIR, exist_ok=True)
                with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                    json.dump(DEFAULTS, f, indent=2)
                    f.write("\n")
            except OSError:
                pass
    except json.JSONDecodeError:
        data = {}
    merged = dict(DEFAULTS)
    merged.update(data)
    if not isinstance(merged.get("taglines"), list) or not merged["taglines"]:
        merged["taglines"] = DEFAULT_TAGLINES
    pricing.set_overrides(merged.get("pricing") or {})
    _cache = merged
    return merged
