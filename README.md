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

## Features

- Interactive REPL with streamed, markdown-rendered responses
- **Live progress wheel** while the model works, showing elapsed time and a
  running token estimate, then exact `in → out` token counts when it finishes
- **Multi-line paste support** — paste or drag-and-drop content of any length
  (far past 10 lines) and it lands as a single message
- Works on **any folder you can reach** — your current directory, or projects
  in `~/Desktop`, `~/Downloads`, etc. (no sandbox)
- **Multiple providers**: Anthropic (Claude), Xiaomi MiMo, DeepSeek, Qwen,
  Kimi (Moonshot), GLM (Zhipu), MiniMax — or any OpenAI-compatible endpoint
  (including local servers like Ollama)
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
| Custom OpenAI-compatible URL | `custom` | (you choose) | `KCODER_CUSTOM_API_KEY` |

Anthropic models include `claude-fable-5` (Anthropic's most capable model),
`claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001` —
switch with `/model`. When using Fable, kcoder automatically enables a
server-side fallback to Opus 4.8, so if Fable's safety classifiers decline
a benign request the answer is re-served by Opus inside the same call
(kcoder prints a dim note when that happens).

If a provider's env var is set, it takes priority over saved credentials.
The `custom` provider accepts any OpenAI-compatible `/chat/completions`
endpoint — hosted, or local (e.g. Ollama at `http://localhost:11434/v1`).

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `KCODER_MODEL` | provider default | Model used at startup |
| `KCODER_BASH_TIMEOUT` | `120` | Default `run_bash` timeout (seconds) |

## Usage

```bash
kcoder                      # normal mode: asks y/n before writes/edits/shell commands
kcoder --yes                # auto-approve mode: runs tools without asking
kcoder --provider deepseek  # start with a specific provider
kcoder --logout             # forget all saved credentials
```

Then just talk to it:

```
k> add a --verbose flag to scripts/deploy.py and run the tests
```

kcoder will read files, make edits (asking for approval first), run commands,
and keep going until the task is done.

While it works, a spinner shows the elapsed time and a live token estimate for
the current turn; when the turn finishes, kcoder prints the exact prompt and
response token counts (e.g. `✓ 4.2s · 12,043 in → 587 out tokens`).

You can paste as much as you want into the `k>` prompt — multi-line snippets,
logs, or whole files. The entire paste is captured as one message (kcoder
notes `… +N pasted lines`), so you're not limited to a single line.

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
  k> /cd ~/Downloads/my-project   # change the working directory
  k> /cd                          # back to your home directory
  ```

- **Drag and drop the folder onto the prompt.** Most terminals paste the
  folder's absolute path. If you drop a folder on its own line, kcoder offers
  to switch the working directory to it; otherwise just reference the path in
  your message:

  ```
  k> set up tests for the project at /Users/you/Downloads/my-project
  ```

  Quoted paths and backslash-escaped spaces (how terminals encode folders with
  spaces in the name) are handled automatically, and because kcoder captures
  full multi-line pastes, dropping a path mid-sentence won't break your prompt.

After a `/cd`, every new request runs against the new directory — the agent's
tools and shell commands all operate from there.

### Commands

| Command | Action |
|---|---|
| `/exit`, `/quit` | Leave kcoder |
| `/clear` | Reset conversation history |
| `/cd [path]` | Change working directory (no arg → home; or drag a folder in) |
| `/provider` | List providers and pick one interactively |
| `/provider deepseek` | Switch provider immediately (asks for a key the first time) |
| `/model` | List the active provider's models and pick one |
| `/model deepseek-reasoner` | Switch model immediately (any name accepted) |
| `/auto` | Toggle auto-approve for tool execution |
| `/help` | List commands |

Switching providers clears the conversation history (the two API families
store history in different formats).

## Safety

By default, kcoder prints every `write_file`, `edit_file`, and `run_bash`
action and asks for confirmation before executing it. Read-only tools
(`read_file`, `list_dir`) run without prompting. Use `--yes` or `/auto`
at your own discretion.
