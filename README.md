# kcoder

```
██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗
██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗
█████╔╝ ██║     ██║   ██║██║  ██║█████╗  ██████╔╝
██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗
██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
```

A terminal coding agent developed by Kyle Niedzwiecki. kcoder chats with you
in your terminal and can actually **read/write files and run shell commands**
in your current working directory — not just talk about it.

Sessions live in a local daemon (`kcoderd`), so you can run many agents at
once, detach and re-attach from any terminal, and nothing is lost if a
terminal closes. The terminal client is one view onto the daemon; a browser
"wall of sessions" is the other (coming in the next phase).

## Features

- Interactive REPL with streamed, markdown-rendered responses
- **Many sessions at once** — each session runs in the `kcoderd` daemon;
  `kcoder ls` / `kcoder attach <id>` to move between them, and sessions
  survive terminal closes, daemon restarts, and crashes (history is persisted)
- **Live progress wheel** while the model works, showing elapsed time and a
  running token estimate, then exact `in → out` token counts when it finishes
- **Multi-line paste support** — paste or drag-and-drop content of any length
  (far past 10 lines) and it lands as a single message
- **Image input** — drag an image file onto the prompt and it's sent to the
  model as `[Image #1]` (works with vision-capable models)
- Works on **any folder you can reach** — your current directory, or projects
  in `~/Desktop`, `~/Downloads`, etc. (no sandbox)
- **Multiple providers**: Anthropic (Claude), Xiaomi MiMo, DeepSeek, Qwen,
  Kimi (Moonshot), GLM (Zhipu), MiniMax, and XiaoKai
- Agentic tool use: `read_file`, `write_file`, `edit_file`, `list_dir`, `run_bash`
- Safety prompts before any write, edit, or shell command (y/n approval)
- Auto-approve mode via `--yes` / `-y` flag or the `/auto` command
- Provider and model switching mid-session with `/provider` and `/model`

## Install

```bash
git clone <this repo>  # or just cd into the kcoder directory
cd kcoder
pip install -e .
```

## Setup

None needed — just run `kcoder`. The first time you launch it, kcoder shows a
provider picker and walks you through a one-time connection setup: it opens
the provider's API-key page in your browser, you paste the key, it's
validated and saved to `~/.config/kcoder/credentials.json` (permissions `600`).
For Anthropic you can alternatively sign in with your browser — if the
Anthropic CLI (`ant`) isn't installed yet, kcoder offers to install it for
you via `brew install anthropics/tap/ant` and then launches the sign-in.

After that, `kcoder` starts straight into the chat with your last-used
provider. Keys for each provider are remembered separately, so switching
back and forth never re-asks. To wipe everything, run `kcoder --logout`.

### Providers

| Provider | id | Default model | Env var (optional) |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| Xiaomi MiMo | `xiaomi` | `MiMo-V2.5-Pro` | `XIAOMI_MIMO_API_KEY` |
| DeepSeek | `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| Qwen (Alibaba) | `qwen` | `qwen3-max` | `DASHSCOPE_API_KEY` |
| Kimi (Moonshot) | `kimi` | `kimi-latest` | `MOONSHOT_API_KEY` |
| GLM (Zhipu / Z.ai) | `glm` | `glm-4.6` | `ZAI_API_KEY` |
| MiniMax | `minimax` | `MiniMax-M2` | `MINIMAX_API_KEY` |
| XiaoKai | `xiaokai` | `xiaokai` | `XIAOKAI_API_KEY` |

Anthropic models include `claude-fable-5` (Anthropic's most capable model),
`claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001` —
switch with `/model`. When using Fable, kcoder automatically enables a
server-side fallback to Opus 4.8, so if Fable's safety classifiers decline
a benign request the answer is re-served by Opus inside the same call
(kcoder prints a dim note when that happens).

If a provider's env var is set, it takes priority over saved credentials.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `KCODER_MODEL` | provider default | Model used at startup |
| `KCODER_BASH_TIMEOUT` | `120` | Default `run_bash` timeout (seconds) |

## Usage

```bash
kcoder                      # new session in this directory (offers to attach if one exists here)
kcoder --yes                # auto-approve mode: runs tools without asking
kcoder --provider deepseek  # start with a specific provider
kcoder --model NAME         # start with a specific model
kcoder --name api-work      # name the session (default: directory name)
kcoder --new                # always start fresh, don't offer to attach
kcoder --logout             # forget all saved credentials

kcoder ls                   # list every session in the daemon
kcoder attach api-work      # attach to a session by name or id prefix
kcoder rm api-work          # close and delete a session
kcoder ui                   # open the browser app (phase 2)
kcoder daemon status        # start | stop | status | run (foreground)
```

The first `kcoder` command starts `kcoderd` in the background automatically.
Leaving a session with `/exit` or Ctrl+D **detaches** — the session keeps
running in the daemon and you can come back to it with `kcoder attach`. Use
`/close` to end a session for good.

Then just talk to it:

```
you> add a --verbose flag to scripts/deploy.py and run the tests
```

kcoder will read files, make edits (asking for approval first), run commands,
and keep going until the task is done.

While it works, a spinner shows the elapsed time and a live token estimate for
the current turn; when the turn finishes, kcoder prints the exact prompt and
response token counts (e.g. `✓ 4.2s · 12,043 in → 587 out tokens`).

You can paste as much as you want into the `you>` prompt — multi-line snippets,
logs, or whole files. The entire paste is captured as one message (kcoder
notes `… +N pasted lines`), so you're not limited to a single line.

**Images:** drag an image file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) onto
the prompt — optionally with a question — and kcoder attaches it to your
message as `[Image #1]` and sends it to the model. You can include several
images in one message; they're numbered in order. Other dragged file or folder
paths are kept as clean text in your message (escaped spaces and brackets are
tidied up automatically), so the agent can read them with its tools.

### Working on a folder

kcoder isn't sandboxed to the directory you start it in — it can read and write
anywhere your user account can, including projects in `~/Desktop` and
`~/Downloads`. There are two easy ways to point it at a project:

- **Start kcoder inside the project** (recommended — the agent treats it as home):

  ```bash
  cd ~/Downloads/my-project && kcoder
  ```

- **Switch directories from inside a session** with `/cd`:

  ```
  you> /cd ~/Downloads/my-project   # change the working directory
  you> /cd                          # back to your home directory
  ```

- **Drag and drop the folder onto the prompt.** Most terminals paste the
  folder's absolute path. If you drop a folder on its own line, kcoder offers
  to switch the working directory to it; otherwise just reference the path in
  your message:

  ```
  you> set up tests for the project at /Users/you/Downloads/my-project
  ```

  Quoted paths and backslash-escaped spaces (how terminals encode folders with
  spaces in the name) are handled automatically, and because kcoder captures
  full multi-line pastes, dropping a path mid-sentence won't break your prompt.

After a `/cd`, every new request runs against the new directory — the agent's
tools and shell commands all operate from there.

### Commands

| Command | Action |
|---|---|
| `/exit`, `/quit` | Detach; the session keeps running in kcoderd |
| `/close` | End this session and detach |
| `/clear` | Reset conversation history |
| `/cd [path]` | Change working directory (no arg → home; or drag a folder in) |
| `/provider` | List providers and pick one interactively |
| `/provider deepseek` | Switch provider immediately (asks for a key the first time) |
| `/model` | List the active provider's models and pick one |
| `/model deepseek-reasoner` | Switch model immediately (any name accepted) |
| `/auto` | Toggle auto-approve for tool execution |
| `/name [name]` | Rename this session |
| `/sessions` | List all sessions in the daemon |
| `/help` | List commands |

Switching providers clears the conversation history (the two API families
store history in different formats).

## Safety

By default, kcoder prints every `write_file`, `edit_file`, and `run_bash`
action and asks for confirmation before executing it. Read-only tools
(`read_file`, `list_dir`) run without prompting. Use `--yes` or `/auto`
at your own discretion.

`kcoderd` can run shell commands, so it only ever binds to `127.0.0.1` and
every client must present the token stored in `~/.local/share/kcoder/token`
(mode `600`) as its first message. Browser clients are additionally limited
to same-origin connections.

## Architecture

```
 terminal(s)            browser (phase 2)
  kcoder attach  ──┐   ┌── kcoder ui
                   ▼   ▼
             ┌──────────────┐   WebSocket, 127.0.0.1 only, token-authenticated
             │   kcoderd    │
             │  ┌────────┐  │   one Engine per session, each turn on its own thread
             │  │ Engine │… │   emits structured events, accepts input + approvals
             │  └────────┘  │
             └──────┬───────┘
                    ▼
         ~/.local/share/kcoder/sessions/<id>/   meta.json · messages.json · events.jsonl
```

| Module | Role |
|---|---|
| `kcoder/engine.py` | Headless agent loop. No terminal I/O: emits events (`text`, `tool_call`, `approval_request`, `usage`, `turn_end`, …) and takes `send()`, `approve()`, `interrupt()`. |
| `kcoder/providers.py` | Anthropic and OpenAI-compatible backends; drive the tool loop through the engine's hooks. |
| `kcoder/daemon.py` | `kcoderd`: owns sessions, runs them concurrently, persists them, streams events over WebSocket. |
| `kcoder/client.py` | Small synchronous client used by the CLI (auto-starts the daemon). |
| `kcoder/cli.py` | The terminal UI: a thin client that renders events and answers approvals. |
| `kcoder/tools.py` | Tool definitions and executors, scoped to each session's working directory. |

Daemon data lives in `~/.local/share/kcoder/` (override with `KCODER_DATA_DIR`);
the port defaults to `47321` (`KCODER_PORT`). Every model call is appended to
`usage.jsonl` for per-session and fleet-wide token accounting.
