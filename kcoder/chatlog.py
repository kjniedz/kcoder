"""Helpers over a chat's message history: turn boundaries, event
reconstruction (for forks and old chats), markdown export, and search."""

from __future__ import annotations

import json
import os
import re
import time

from .tools import describe_tool_call


def is_user_turn(msg: dict) -> bool:
    """A real user message (not a tool-result carrier)."""
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    return False


def user_turn_indices(messages: list) -> list:
    return [i for i, m in enumerate(messages) if is_user_turn(m)]


def user_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def user_images(msg: dict) -> int:
    content = msg.get("content")
    if isinstance(content, list):
        return sum(1 for b in content if isinstance(b, dict) and b.get("type") in ("image", "image_url"))
    return 0


def assistant_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def auto_title(messages: list, fallback: str = "") -> str:
    for m in messages:
        if is_user_turn(m):
            text = user_text(m).strip()
            if not text:
                continue
            first = text.splitlines()[0].strip()
            first = re.sub(r"\s+", " ", first)
            first = re.sub(r"^[#>*\-\s]+", "", first)
            if len(first) > 60:
                first = first[:57].rstrip() + "…"
            return first or fallback
    return fallback


def events_from_messages(messages: list, ts: float | None = None) -> list:
    """Rebuild a display event stream from a message history (both the
    Anthropic and OpenAI formats)."""
    ts = ts or time.time()
    out = []

    def ev(t, **f):
        e = {"t": t, "ts": ts}
        e.update(f)
        out.append(e)

    pending_calls: dict[str, tuple[str, dict]] = {}
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "user":
            if is_user_turn(m):
                ev("turn_start")
                ev("user", text=user_text(m), images=[f"image {i + 1}" for i in range(user_images(m))])
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        name, _ = pending_calls.get(b.get("tool_use_id"), ("tool", {}))
                        res = b.get("content")
                        if isinstance(res, list):
                            res = "\n".join(x.get("text", "") for x in res if isinstance(x, dict))
                        ev("tool_result", id=b.get("tool_use_id"), name=name,
                           content=str(res or "")[:4000], is_error=bool(b.get("is_error")))
        elif role == "tool":
            name, _ = pending_calls.get(m.get("tool_call_id"), ("tool", {}))
            ev("tool_result", id=m.get("tool_call_id"), name=name,
               content=str(m.get("content") or "")[:4000], is_error=str(m.get("content", "")).startswith("Error"))
        elif role == "assistant":
            text = assistant_text(m)
            if text:
                ev("assistant_start")
                ev("assistant_end", text=text)
            blocks = content if isinstance(content, list) else []
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    pending_calls[b.get("id")] = (b.get("name"), b.get("input") or {})
                    ev("tool_call", id=b.get("id"), name=b.get("name"), input=b.get("input") or {},
                       description=describe_tool_call(b.get("name"), b.get("input") or {}))
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {"raw": fn.get("arguments")}
                pending_calls[tc.get("id")] = (fn.get("name"), args)
                ev("tool_call", id=tc.get("id"), name=fn.get("name"), input=args,
                   description=describe_tool_call(fn.get("name"), args))
    return out


def export_markdown(meta: dict, messages: list) -> str:
    lines = [f"# {meta.get('title') or meta.get('name') or 'kcoder chat'}", ""]
    lines.append(f"- project: `{(meta.get('project') or {}).get('path') or meta.get('cwd')}`")
    lines.append(f"- model: `{meta.get('model')}`")
    lines.append(f"- session: `{meta.get('id')}`")
    lines.append("")
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "user" and is_user_turn(m):
            lines += ["## You", "", user_text(m).strip(), ""]
        elif role == "user" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    res = b.get("content")
                    if isinstance(res, list):
                        res = "\n".join(x.get("text", "") for x in res if isinstance(x, dict))
                    lines += ["<details><summary>tool result</summary>", "", "```", str(res or "").strip(), "```", "", "</details>", ""]
        elif role == "tool":
            lines += ["<details><summary>tool result</summary>", "", "```", str(m.get("content") or "").strip(), "```", "", "</details>", ""]
        elif role == "assistant":
            text = assistant_text(m).strip()
            if text:
                lines += ["## kcoder", "", text, ""]
            blocks = content if isinstance(content, list) else []
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    lines += [f"> ⚙ `{describe_tool_call(b.get('name'), b.get('input') or {})}`", ""]
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                lines += [f"> ⚙ `{fn.get('name')}: {fn.get('arguments')}`", ""]
    return "\n".join(lines).rstrip() + "\n"


def search_messages(messages: list, query: str, max_hits: int = 3) -> list:
    """Case-insensitive substring search; returns snippets."""
    q = query.lower()
    hits = []
    for i, m in enumerate(messages):
        if m.get("role") == "user" and is_user_turn(m):
            text, who = user_text(m), "you"
        elif m.get("role") == "assistant":
            text, who = assistant_text(m), "kcoder"
        else:
            continue
        low = text.lower()
        pos = low.find(q)
        if pos < 0:
            continue
        start = max(0, pos - 60)
        end = min(len(text), pos + len(q) + 80)
        snippet = re.sub(r"\s+", " ", text[start:end]).strip()
        hits.append({"index": i, "who": who, "snippet": ("…" if start else "") + snippet + ("…" if end < len(text) else "")})
        if len(hits) >= max_hits:
            break
    return hits
