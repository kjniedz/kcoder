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


KCODER_MESSAGE_PREFIXES = ("Background job ", "Your push ", "Your commit ", "Your connector request ")


def auto_title(messages: list, fallback: str = "") -> str:
    for m in messages:
        if is_user_turn(m):
            text = user_text(m).strip()
            if not text or text.startswith(KCODER_MESSAGE_PREFIXES):
                continue        # messages kcoder sends itself (job results, approvals) do not name a session
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


def export_html(meta: dict, messages: list, commits: list | None = None) -> str:
    """A single self-contained HTML page of the session: readable anywhere,
    no network, nothing to install. Markdown is rendered in the page by the
    vendored marked.js; tool calls and results are folded."""
    import html as _html
    import json as _json
    import os as _os
    vendor = _os.path.join(_os.path.dirname(__file__), "web", "vendor", "marked.min.js")
    try:
        with open(vendor, "r", encoding="utf-8") as f:
            marked_js = f.read()
    except OSError:
        marked_js = ""
    turns = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "user" and is_user_turn(m):
            turns.append({"who": "you", "md": user_text(m).strip()})
        elif role == "user" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    res = b.get("content")
                    if isinstance(res, list):
                        res = "\n".join(x.get("text", "") for x in res if isinstance(x, dict))
                    turns.append({"who": "result", "text": str(res or "").strip()[:20000]})
        elif role == "tool":
            turns.append({"who": "result", "text": str(m.get("content") or "").strip()[:20000]})
        elif role == "assistant":
            text = assistant_text(m).strip()
            if text:
                turns.append({"who": "kcoder", "md": text})
            blocks = content if isinstance(content, list) else []
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    turns.append({"who": "tool", "text": describe_tool_call(b.get("name"), b.get("input") or {})})
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                turns.append({"who": "tool", "text": f"{fn.get('name')}: {fn.get('arguments')}"})
    title = meta.get("title") or meta.get("name") or "kcoder chat"
    u = meta.get("usage") or {}
    import datetime as _dt
    def when(ts):
        return _dt.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M") if ts else ""
    facts = [("project", (meta.get("project") or {}).get("name") or _os.path.basename(str(meta.get("cwd") or ""))),
             ("branch", (meta.get("worktree") or {}).get("branch") or ""), ("model", f"{meta.get('provider') or ''}/{meta.get('model') or ''}".strip("/")),
             ("started", when(meta.get("created"))), ("last activity", when(meta.get("last_activity"))),
             ("turns", str(u.get("turns") or "")), ("tokens", f"{int(u.get('input') or 0) + int(u.get('output') or 0):,}")]
    pr = meta.get("pr") or {}
    if pr.get("url"):
        facts.append(("PR", pr["url"]))
    facts_html = "".join(f"<span><b>{_html.escape(k)}</b> {('<a href=\"' + _html.escape(v) + '\">' + _html.escape(v) + '</a>') if v.startswith('http') else _html.escape(v)}</span>" for k, v in facts if v)
    commits_html = ""
    if commits:
        rows = "".join(f"<li><code>{_html.escape(str(c.get('sha', ''))[:7])}</code> {_html.escape(str(c.get('subject') or ''))} <span class=dim>({c.get('files') or 0} files, +{c.get('insertions') or 0} / -{c.get('deletions') or 0})</span></li>" for c in commits[:50])
        commits_html = f"<section class=commits><h2>Commits</h2><ul>{rows}</ul></section>"
    data = _json.dumps(turns, ensure_ascii=False).replace("</", "<\\/")
    css = """
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--dim:#6a737d;--line:#d0d7de;--you:#eef3ff;--code:#f6f8fa;--accent:#0969da}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--you:#161b2e;--code:#161b22;--accent:#58a6ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}h1{font-size:24px;margin:0 0 6px}.facts{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--dim);font-size:13px;margin-bottom:22px}.facts b{color:var(--fg);font-weight:600}
.turn{margin:14px 0;padding:10px 14px;border:1px solid var(--line);border-radius:8px}.turn.you{background:var(--you)}.turn .who{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
.turn.you .who{color:var(--accent)}details{margin:6px 0;font-size:13px}details summary{cursor:pointer;color:var(--dim)}details pre{max-height:360px;overflow:auto}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}:not(pre)>code{background:var(--code);padding:1px 5px;border-radius:4px}
.md p{margin:.5em 0}.md h1,.md h2,.md h3{font-size:1.05em;margin:.9em 0 .3em}.md table{border-collapse:collapse}.md td,.md th{border:1px solid var(--line);padding:3px 8px}.md img{max-width:100%}
.commits ul{padding-left:18px}.dim{color:var(--dim)}footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:10px}a{color:var(--accent)}
"""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{_html.escape(title)} · kcoder</title><style>{css}</style></head>
<body><main><h1>{_html.escape(title)}</h1><div class="facts">{facts_html}</div><div id="t"></div>{commits_html}
<footer>Exported from kcoder on {_html.escape(_dt.datetime.now().strftime('%Y-%m-%d %H:%M'))}. Secrets are masked; tool output is folded.</footer></main>
<script>{marked_js}</script>
<script>
const TURNS = {data};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({{'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}})[c]);
if (window.marked) marked.use({{ renderer: {{ html: (t) => esc(typeof t === 'string' ? t : (t && t.text) || '') }} }});   // raw HTML in a transcript stays text
const md = (s) => {{ try {{ return window.marked ? marked.parse(s || '') : '<pre>' + esc(s) + '</pre>'; }} catch (e) {{ return '<pre>' + esc(s) + '</pre>'; }} }};
document.getElementById('t').innerHTML = TURNS.map((t) => t.who === 'you' ? `<div class="turn you"><div class="who">you</div><div class="md">${{md(t.md)}}</div></div>`
  : t.who === 'kcoder' ? `<div class="turn"><div class="who">kcoder</div><div class="md">${{md(t.md)}}</div></div>`
  : t.who === 'tool' ? `<details><summary>⚙ ${{esc(t.text)}}</summary></details>`
  : `<details><summary>tool result (${{(t.text || '').length}} chars)</summary><pre>${{esc(t.text)}}</pre></details>`).join('');
</script></body></html>
"""


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
