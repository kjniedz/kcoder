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
in your current working directory - not just talk about it.

Sessions live in a local daemon (`kcoderd`), so you can run many agents at
once, detach and re-attach from any terminal, and nothing is lost if a
terminal closes. The terminal client is one view onto the daemon; the
kcoder app (`kcoder app`, or `kcoder ui` for a browser tab) is the other: a
wall of live session panes, a Claude-style chat view with project history,
and a terminal view.

## Features

- Interactive REPL with streamed, markdown-rendered responses
- **Many sessions at once** - each session runs in the `kcoderd` daemon;
  `kcoder ls` / `kcoder attach <id>` to move between them, and sessions
  survive terminal closes, daemon restarts, and crashes (history is persisted)
- **Live progress wheel** while the model works, showing elapsed time and a
  running token estimate, then exact `in → out` token counts when it finishes
- **Claude Code-style input** - bracketed paste means a paste never submits
  by itself; big pastes collapse into a `[Pasted #1 · 142 lines]` chip
  (Alt+E expands it for editing); Enter sends, Option+Enter inserts a
  newline; Up recalls earlier prompts; `/` opens a command menu; anything
  typed while the agent is busy lands in the next prompt
- **Esc interrupts** the agent mid-turn without losing the session, so you can
  redirect it; Ctrl+C once interrupts, twice detaches
- **Headless one-shot mode** - `kcoder "task"` or `echo task | kcoder` runs a
  single turn with no banner or prompts and exits 0 on success
- **Image input** - drag an image file onto the prompt and it's sent to the
  model as `[Image #1]` (works with vision-capable models)
- Works on **any folder you can reach** - your current directory, or projects
  in `~/Desktop`, `~/Downloads`, etc. (no sandbox)
- **Multiple providers**: Anthropic (Claude), Xiaomi MiMo, DeepSeek, Qwen,
  Kimi (Moonshot), GLM (Zhipu), MiniMax, and XiaoKai
- Agentic tool use: `read_file`, `write_file`, `edit_file`, `list_dir`, `run_bash`
- Safety prompts before any write, edit, or shell command (y/n approval)
- Auto-approve mode via `--yes` / `-y` flag or the `/auto` command
- Provider and model switching mid-session with `/provider` and `/model`

## Get kcoder (no terminal experience needed)

On a Mac, open the Terminal app (press Cmd+Space, type Terminal, press
Enter), paste this one line and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/kjniedz/kcoder/main/install.sh | bash
```

It installs Python if your Mac does not have it (your Mac asks for your
password once), installs kcoder, puts **kcoder.app** in your Applications
folder and opens it. Pin it: right-click the kcoder icon in the Dock, choose
Options, then Keep in Dock. From then on you launch kcoder like any other
app, and you can close the Terminal.

The first time the app opens it asks you to **connect your AI**. Pick where
your model lives and sign in once:

- **Claude (your claude.ai subscription):** click "Install Claude Code and
  sign in". A Terminal window opens and does the install, then your browser
  opens so you can sign in to your Claude account. Come back to the app and
  click "Check again". No API key and no per-token billing.
- **Any other provider (Anthropic API, DeepSeek, Qwen, Kimi, GLM, MiniMax,
  Xiaomi MiMo):** click the "Get a key" link, copy the key from your account
  page, paste it into the app and click Connect. The key is checked against
  the provider and saved on your Mac only, in
  `~/.config/kcoder/credentials.json` (permissions `600`).

You can connect more providers at any time from the command palette
(Cmd+K, "connect your AI") and choose one per session. Then click **+ new**,
pick a folder or one of your GitHub repos, type what you want built, and
watch it work.

## Commit identity

Every commit kcoder makes, including commits an agent makes inside a session
and commits Claude Code makes on your Claude plan, is authored and committed
as **the GitHub account signed into `gh` on that machine**. Never as kcoder,
never as an AI, never as whatever the machine's global git config says. On
GitHub each commit shows your avatar.

- The identity comes from `gh auth` (the active account in
  `~/.config/gh/hosts.yml`), resolved to your id, name and public email and
  cached so it works offline. Author and committer are set per commit through
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*`.
- The email defaults to your GitHub noreply address
  (`id+login@users.noreply.github.com`), which links commits to your profile
  without exposing a personal address. If you have a public email on GitHub
  you can pick it instead in the connect dialog (`commit_email: "public"`).
- No AI co-author or "generated by" trailers by default. Set `ai_trailer` in
  the connect dialog (or `~/.config/kcoder/config.json`) if you want one.
- Not signed in? The first-launch "connect your AI" dialog has a **Connect
  GitHub** button (installs the GitHub CLI if needed, signs in with the
  browser, points git's https credentials at that account). Until then
  commits are refused with a plain message rather than made under a
  fallback identity. The same dialog is in the command palette (⌘K,
  "connect GitHub").
- Pushes use the same account's credentials (`gh auth setup-git`). Switch
  accounts with `gh auth switch` or the dialog's Switch account, and the next
  commit follows the new account.
- Stats count commits for the signed-in account only, matched by author
  email (noreply, public, or any verified email when the gh token has the
  `user:email` scope, which the connect step requests). On an existing login
  run `gh auth refresh -h github.com -s user:email` once to let kcoder see
  your verified emails.

## Install for developers

```bash
git clone https://github.com/kjniedz/kcoder.git
cd kcoder
pip install -e .
kcoder app        # or: kcoder (terminal), kcoder ui (browser tab)
```

## Setup

**Using your Claude plan (default):** if the Claude Code CLI (`claude`) is
installed and signed in, kcoder uses it as its default provider. Turns run
through `claude -p` on your Claude subscription, with no API keys and no
per-token billing, and Claude Code runs the tools itself (its own
Read/Write/Edit/Bash, with your trust level mapped onto its permission
modes). The "cost" shown for these sessions is what the calls would have
cost on the API, for reference.

**Using API keys instead:** sign in from the app (command palette, "connect
your AI"), or run `kcoder --provider anthropic` (or any other provider) once
in a terminal. The terminal flow shows a provider picker and walks you
through a one-time connection: it opens the provider's API-key page in your
browser, you paste the key, it is validated and saved to
`~/.config/kcoder/credentials.json` (permissions `600`). For Anthropic you
can alternatively sign in with your browser. If the Anthropic CLI (`ant`)
is not installed yet, kcoder offers to install it for you via
`brew install anthropics/tap/ant` and then launches the sign-in.

After that, `kcoder` starts straight into the chat with your last-used
provider. Keys for each provider are remembered separately, so switching
back and forth never re-asks. To wipe everything, run `kcoder --logout`.

### Providers

| Provider | id | Default model | Env var (optional) |
|---|---|---|---|
| Claude Code (your Claude plan) | `claude` | `opus` | - (uses the `claude` CLI login) |
| Anthropic (Claude) | `anthropic` | `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| Xiaomi MiMo | `xiaomi` | `MiMo-V2.5-Pro` | `XIAOMI_MIMO_API_KEY` |
| DeepSeek | `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| Qwen (Alibaba) | `qwen` | `qwen3-max` | `DASHSCOPE_API_KEY` |
| Kimi (Moonshot) | `kimi` | `kimi-latest` | `MOONSHOT_API_KEY` |
| GLM (Zhipu / Z.ai) | `glm` | `glm-4.6` | `ZAI_API_KEY` |
| MiniMax | `minimax` | `MiniMax-M2` | `MINIMAX_API_KEY` |
| XiaoKai | `xiaokai` | `xiaokai` | `XIAOKAI_API_KEY` |

Anthropic models include `claude-fable-5` (Anthropic's most capable model),
`claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001`.
Switch with `/model`. When using Fable, kcoder automatically enables a
server-side fallback to Opus 4.8, so if Fable's safety classifiers decline
a benign request the answer is re-served by Opus inside the same call
(kcoder prints a dim note when that happens).

If a provider's env var is set, it takes priority over saved credentials.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `KCODER_MODEL` | provider default | Model used at startup |
| `KCODER_BASH_TIMEOUT` | `120` | Default `run_bash` timeout (seconds) |
| `KCODER_NO_ANIMATION` | unset | Disable the banner reveal animation |
| `NO_COLOR` | unset | Disable all colour output |

## Usage

```bash
kcoder                      # new session in this directory (offers to attach if one exists here)
kcoder "add tests for foo"  # one-shot: run one task, print the result, exit
echo "task" | kcoder -y     # headless one-shot (tools allowed with -y; declined otherwise)
kcoder --yes                # auto-approve mode: runs tools without asking
kcoder --no-banner          # skip the startup banner (NO_COLOR is respected too)
kcoder --provider deepseek  # start with a specific provider
kcoder --model NAME         # start with a specific model
kcoder --name api-work      # name the session (default: directory name)
kcoder --new                # always start fresh, don't offer to attach
kcoder --logout             # forget all saved credentials

kcoder ls                   # list every session in the daemon
kcoder attach api-work      # attach to a session by name or id prefix
kcoder rm api-work          # close and delete a session
kcoder app                  # open the app in its own window
kcoder app --install        # macOS: install kcoder.app (Spotlight, Launchpad, Dock)
kcoder ui                   # open the app in a browser tab instead
kcoder daemon status        # start | stop | restart | status | run | install | uninstall
```

## The app

`kcoder app` opens the web app in its own window instead of a browser tab.
It starts `kcoderd` if it isn't running, attaches the daemon token, and picks
the best window it can:

1. a native window with the kcoder icon and name in the Dock and menu bar
   (`pywebview`, installed by default on macOS; `pip install pywebview`
   elsewhere). It runs as its own process, so the terminal is free;
2. otherwise Chrome, Brave, Edge, Chromium or Vivaldi in app mode: a
   chromeless window with its own profile (`kcoder app --chrome` forces this);
3. otherwise your default browser (`kcoder app --browser` forces this).

On macOS, `kcoder app` always goes through `~/Applications/kcoder.app`
(installed or refreshed automatically; `kcoder app --install` does it by
hand). The bundle carries its own copy of the Python interpreter, so the
window belongs to kcoder.app rather than to Python: the Dock shows the kcoder
icon and name, right-click → Options → **Keep in Dock** pins it, and
Spotlight and Launchpad find it. Launching it from the Dock does exactly what
`kcoder app` does: it starts `kcoderd` if needed and opens the window.
`kcoder app --uninstall` removes it.

`kcoder daemon install` registers `kcoderd` as a login item (launchd), so the
daemon is already up when you open the app and comes back after a crash.
`kcoder daemon stop` / `start` / `restart` keep working either way, and
`kcoder daemon uninstall` goes back to starting the daemon on demand.

The page is also an installable web app (it ships a manifest and icons), so
"Install app" in Chrome or "Add to Dock" in Safari works too.

The app and the daemon exchange versions when they connect. When they differ
(a new version was installed under a running daemon) the app restarts the
daemon itself as soon as no session is mid-turn, instead of surfacing
protocol errors; the CLI does the same. `kcoder daemon status` just reports
the mismatch.

## Updates

kcoder runs from your git checkout. When the daemon starts (and once a day)
it fetches the upstream branch and counts new commits; the app offers them
when it opens, and the header shows "N new commits" until you take them.
Accepting pulls with `git pull --ff-only`, reinstalls when `pyproject.toml`
changed, rebuilds kcoder.app when its files changed, checks that the new code
imports, and restarts kcoderd. If the new daemon does not come up healthy the
checkout is reset to the previous commit and the daemon restarts on it.
Working sessions are interrupted and come back paused.

- `kcoder update` lists new commits; `kcoder update --now` takes them.
- Local uncommitted changes or unpushed commits block the pull (nothing is
  overwritten).

## Uninstall

`kcoder uninstall` (or ⌘K → **uninstall kcoder…**) removes the app, the
login item, the daemon, caches and the Python package. It asks before
deleting session history and saved keys and keeps both by default, so a
reinstall picks up where you left off. `kcoder uninstall --dry-run` prints
the script it would run.

## Working from GitHub

In the app's "new session" dialog the repo field accepts a local path,
`owner/name`, or a GitHub URL, and lists your local repos plus your GitHub
repos via the `gh` CLI. A GitHub repo is cloned into `projects_dir`
(`~/kcoder-projects` by default) the first time; after that the existing
clone is reused and fast-forwarded from its remote before the session starts
(skipped, with a note in the session log, if the tree is dirty or offline).
Every session in a git repo also has a `⇣ pull` button (and a "pull from
remote" palette entry) for a fast-forward pull while it is idle. Local
folders with no remote get a private GitHub repo created and pushed when
`auto_publish` is on.

The first `kcoder` command starts `kcoderd` in the background automatically.
Leaving a session with `/exit` or Ctrl+D **detaches** - the session keeps
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
response token counts (e.g. `✓ 4.2s · 12,043 in → 587 out tokens`). Press
**Esc** (or Ctrl+C) to interrupt the agent mid-turn - the session and its
history survive, so you can just tell it what to do differently. Ctrl+C a
second time detaches.

### The prompt

| Key | Action |
|---|---|
| Enter | send |
| Option+Enter | insert a newline (for Shift+Enter, set your terminal to send Option+Enter for it, as Claude Code's `/terminal-setup` does) |
| Up / Down | recall earlier prompts (on the first / last line) |
| paste | never submits by itself; 3+ lines or 400+ chars become a `[Pasted #N · L lines]` chip |
| Alt+E | expand the paste chip under the cursor so you can edit it |
| `/` | slash-command menu with autocomplete (Tab / arrows to pick) |
| Ctrl+C | clear the line; twice on an empty line to detach |

### Headless / one-shot

When stdout isn't a terminal (another program's shell tool, a pipe, CI) kcoder
prints nothing decorative. Give it a task and it runs one turn, streams the
answer to stdout, sends tool activity and errors to stderr, and exits 0 on
success:

```bash
kcoder "summarize what this repo does"
echo "run the tests and fix the failures" | kcoder -y
```

Tool approvals are declined unless `-y` is given (nobody is there to answer).
The one-shot session is deleted afterwards; pass `--keep` to keep it. With no
task at all, kcoder prints a one-line usage hint and exits 0.

### Banner

The KCODER banner fades from kcoder's light blue into deep violet (truecolor,
with 256- and 16-colour fallbacks), sweeps in over ~300ms on launch (any key
skips it; it's off when not a TTY, when the OS "reduce motion" setting is on,
or with `KCODER_NO_ANIMATION=1`), and shows a rotating tagline plus a live
line from the daemon like `4 sessions, 2 running · 1 waiting on you · $3.12
today`. Under 80 columns, or when re-attaching, it's a one-line wordmark.
Edit `~/.config/kcoder/config.json` to change the taglines or turn the banner
or animation off. The banner colour is brand, not state - errors and statuses
are coloured elsewhere.

**Images:** drag an image file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) onto
the prompt - optionally with a question - and kcoder attaches it to your
message as `[Image #1]` and sends it to the model. You can include several
images in one message; they're numbered in order. Other dragged file or folder
paths are kept as clean text in your message (escaped spaces and brackets are
tidied up automatically), so the agent can read them with its tools.

### Working on a folder

kcoder isn't sandboxed to the directory you start it in - it can read and write
anywhere your user account can, including projects in `~/Desktop` and
`~/Downloads`. There are two easy ways to point it at a project:

- **Start kcoder inside the project** (recommended - the agent treats it as home):

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

After a `/cd`, every new request runs against the new directory - the agent's
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

## The web app

```bash
kcoder ui        # opens http://127.0.0.1:47321/ with the daemon token attached
```

Three views of the same sessions, switchable with the header buttons or
<kbd>alt+1/2/3</kbd>:

- **Chat** can show **1, 2 or 3 sessions side by side** in equal panes: `⌘\`
  adds a pane, `⌘1/2/3` focuses one, `⌘⇧W` closes it, `⌘⇧↩` pops the focused
  pane out to fill the window and back, and `⌃⌘F` is native full screen. Put a
  session in a pane by dragging it from the sidebar or clicking the pane's
  name. Every pane has its own input, model, trust, toolbar (which collapses
  into the `⋯` menu when the pane is narrow) and streaming. The layout is
  remembered across restarts. Broadcast (`⇶` in the header) sends one prompt
  to every open pane, handy for comparing models.
- **Transcripts are real text**: drag-select across messages, `⌘A` selects
  the focused pane's transcript, `⌘C` copies clean text (whole messages copy
  as their markdown source, code fences included), and every message has a
  hover copy button. Selections survive streaming; if you scroll up while the
  agent is writing, a "jump to latest" button appears instead of yanking you
  down. `⌘F` finds inside a session, `⌘⇧F` searches across sessions, and you
  can drop files onto a pane to attach them to the prompt.
- **Stats** (header numbers, or `alt+4`): today / 7-day / 30-day / all-time
  tokens, commits, sessions and active agent time; a sortable daily table
  with CSV export; a daily token chart over 7 / 30 / 90 days; breakdowns by
  model, provider (subscription vs API key, with estimated cost for API use)
  and project; top sessions by tokens; and every commit made from a kcoder
  session with its repo, session, lines changed, pushed-or-local state and a
  GitHub link. Commits are detected from local git at turn boundaries, so it
  works offline and for private repos. History lives in
  `~/.local/share/kcoder/usage.jsonl` and `commits.jsonl`, survives daemon
  restarts and updates, is backfilled from session logs, and rolls over at
  local midnight. Sessions that are not in the focused pane raise a macOS
  notification when they finish or need you.
- **Wall** - a dense tiled grid of live panes, one per session, auto-reflowing
  as sessions come and go. Each pane has a title bar (name, repo @ branch,
  model, status dot), a live feed, and a status line (context used, tokens,
  cost, last activity). Status is readable from across the room: working,
  **waiting on you** (bright pulsing border), done, error, paused. Click a
  pane (or press its number) to focus it full-size with its composer and
  actions; <kbd>esc</kbd> goes back to the grid; <kbd>w</kbd> cycles through
  sessions waiting on you; <kbd>v</kbd> flips a pane between chat, terminal,
  and a real shell (xterm.js) in that session's working directory.
- **Chat** - project sidebar on the left with every chat (active and
  archived), full-text search, rendered markdown, syntax-highlighted code
  with copy buttons, collapsible tool call / result blocks, inline diffs for
  edits, live output for running commands (with a kill button), and per-message
  edit-and-resend / fork. Right-click a chat to rename, pin, archive, export,
  or delete it.
- **Terminal** - the same session rendered exactly like the CLI.

Everywhere: <kbd>n</kbd> new session - pick a repo from the list of local
git repos and your GitHub repos (via `gh`), or type `owner/name` / a GitHub
URL and it's cloned into `~/kcoder-projects` on first use - plus model,
trust level, initial task, follow-up tasks, worktree on/off; <kbd>a</kbd> the approval
inbox aggregating pending tool approvals from every session (<kbd>y</kbd> /
<kbd>n</kbd> / <kbd>a</kbd> for all), <kbd>⌘K</kbd> the command palette,
<kbd>?</kbd> keyboard help. The composer behaves like the CLI: Enter sends,
Shift+Enter newlines, pastes never submit (big ones become chips), images can
be pasted or dropped, `/` opens the command menu, `@` fuzzy-completes project
files, <kbd>↑</kbd> recalls prompts, <kbd>esc</kbd> interrupts. A browser
notification and a soft sound fire when a session blocks on you or finishes.

**Multi-monitor:** open the app in several windows and press <kbd>p</kbd>
(or the pin icon) on panes to pin them to that window; a window with pins
shows only those sessions. `?pin=name1,name2&view=wall` in the URL does the
same for bookmarks.

### Worktrees, merge, PR, discard

Every session in a git repo works in its own git worktree on its own
`kcoder/<name>` branch, so parallel sessions on the same repo never touch
each other's files. This is the default from the app and the CLI alike
(uncheck "worktree" in the new-session dialog or pass `--no-worktree` to work
in place; `worktrees: false` in the config changes the default). One-shot
`kcoder "task"` runs in place, because its session is deleted afterwards.
A local folder that is not a repo yet gets `git init` and an initial commit
first. Forks branch from the parent session's branch.

Work gets back to the main branch through **merge** (commits the worktree,
merges `--no-ff` into the main checkout, aborts cleanly on conflict) or
**open PR** (pushes the branch and runs `gh pr create`); **discard** deletes
the worktree and branch. Archiving a session commits any uncommitted work as
a checkpoint on its branch and removes the worktree directory; resuming the
session recreates it from the branch. Deleting a session removes both.

### Review, checkpoints, secrets

- **Changes view** (a focused pane's **changes** button, or ⌘K → changes):
  everything the session changed relative to the branch it started from, as
  a file list plus diff. Each hunk can be accepted, rejected (undone in the
  worktree) or edited. **Approve** records the resulting tree. The setting
  `review_required` (⌘K → set review policy) says when that approval is
  needed: before `push` (the default, and it also covers merges and PRs,
  even with trust `auto`), before every `commit`, or `none`. Enforcement is
  by git hooks in every worktree, so it applies to the agent's own
  `git push` too.
- **Checkpoints + undo**: before every turn the worktree is snapshotted (a
  git tree kept under `refs/kcoder/<session>/`) together with the
  conversation position. **↶ undo to here** on any of your messages restores
  both: files go back, the agent's later commits on the branch are undone,
  and the conversation is cut there. Restores only ever touch the session's
  worktree; kcoder's built-in write tools also refuse paths outside it.
- **Secret scanning**: every commit and push in a worktree is scanned for API
  keys and tokens, private keys, wallet seed phrases and raw private keys,
  `.env` files and credential files. A hit blocks with a plain message that
  names the file and line with the secret redacted. False positives go in
  `.kcoder/allowlist` in the repo (`secret:<fingerprint>`, `path:<glob>` or
  `kind:<kind>`; the changes view has an **allowlist…** button). Detected
  secrets are also masked in session transcripts and exports.
- **One-click PR**: **open PR** commits, checks the review policy, pushes
  (the hooks run) and opens a **draft** PR as the signed-in GitHub user. The
  description is written from the session's work and diff (what changed,
  why, how it was tested; the model drafts it when the session is idle,
  with a deterministic fallback). The pane header then shows the PR number,
  draft state and CI status, refreshed every 90 seconds.
- **Per-repo instructions**: every turn loads the repo's `KCODER.md` plus
  `AGENTS.md` and `CLAUDE.md` when present (Claude Code reads `CLAUDE.md`
  itself, so it is not appended twice). The pane header shows which file is
  active; click it to edit, or to create `KCODER.md`.

### Task queue

The **tasks** tab (alt+5) is a fleet-wide queue: add a task with its repo
(a folder or `owner/name`), model and trust level and it starts as soon as a
slot is free, in its own worktree. `max_concurrent` (the "up to N at once"
field) caps how many sessions the queue keeps running. Drag queued tasks to
reorder them, pause the queue, cancel tasks. A finished task lands in
**review** (its pane shows ⚑ review and the changes view opens from the
tasks tab); nothing is pushed on its own.

### Model routing, fallback, previews, schedules, phone approvals

- **Model routing**: a session or task whose model is **auto** (the default
  for Claude Code and the Anthropic API) gets a cheaper model for small
  turns and a stronger one for large or multi-file work (`sonnet` / `fable`
  on your Claude plan, Haiku / Opus on the API; `routing.tiers` in the config
  overrides). Pick a concrete model on a session or task to turn routing off
  for it. The pane header shows `auto → <model>`.
- **Fallback**: on a rate limit or outage (after the usual retries) the turn
  moves to the next configured provider and the pane header shows
  `⇄ provider/model · since`. kcoder never falls back from your Claude
  subscription to a pay-per-token API key unless you turn that on (⌘K →
  toggle fallback to paid API keys, `fallback.to_api`), never to a paid
  provider once the daily cap is reached, and goes back to the primary
  provider after ten minutes. Between providers with different message
  formats the history is carried over as a flattened transcript.
- **Live preview**: for web projects (npm `dev`/`start` scripts, Django,
  Flask, a static `index.html`, or `.kcoder/preview.json`) the pane's ▶
  preview view starts the dev server inside the session's worktree on its
  own port (4300 to 4399), so parallel sessions never collide, and shows it
  in the pane; static and server-rendered apps reload when files change,
  bundlers use their own hot reload. Dev servers stop when the session is
  idle for `preview_idle_minutes` (20) or archived. PRs of web projects get
  desktop and mobile screenshots committed under `.kcoder/screenshots/`
  and shown in the description (`pr_screenshots`).
- **Scheduled tasks** (tasks tab → schedules): recurring jobs per repo
  (every hour, day or week) feed the task queue. A job missed while the Mac
  slept runs once on wake, never as a backlog. A run that changed nothing
  just logs; one that did opens a draft PR (or lands in review when the
  schedule says so). Failures and runs waiting for review notify you.
  Note: a schedule's automatic draft PR push is exempt from the review
  policy; the draft PR itself is the review.
- **Phone approvals**: opt-in, off by default (⌘K → phone approvals). Your
  Mac never opens a port; `kcoderd` keeps one outbound connection to a
  small relay you host (`relay/`, a Cloudflare Worker with Web Push).
  Pair a phone once by scanning a QR code; when a session waits for you
  the phone gets a notification that opens a page showing exactly what is
  being approved (command, diff summary) with approve / deny. Approvals
  expire after `remote.ttl_minutes` (10); revoking a device is one click.

### Trust levels, queues, caps, compaction

- Trust per session: `auto` (never ask - the default, change it with
  `default_trust` in the config or `⌘K → set default trust`), `write` (shell
  is gated), `read` (writes and shell are gated), `none` (everything is gated).
- Follow-up task queue: sessions keep working through queued tasks after each
  turn (`/queue`, the "+ task" button, or the new-session dialog).
- Daily spend cap (`⌘K → set daily spend cap`, or `daily_cap_usd` in the
  config): sessions pause when today's spend reaches it.
- Context compaction: when the last prompt reached `compact_at` tokens
  (default 150k) the history is summarised before the next turn, with a
  visible marker in the chat. `/compact` does it on demand.
- Rate limits and overloads retry with backoff, shown in the pane status.
- Sessions, their queues and the window layout survive app crashes, daemon
  restarts and reboots. A session that was mid-turn comes back **paused** with
  the turn's text ready behind a **resume** button (and a **dismiss** button);
  nothing is ever re-run without you. Any `claude` or shell process the dead
  daemon left behind is killed on the next start.

## Safety

By default, kcoder prints every `write_file`, `edit_file`, and `run_bash`
action and asks for confirmation before executing it. Read-only tools
(`read_file`, `list_dir`) run without prompting. Use `--yes` or `/auto`
at your own discretion.

`kcoderd` can run shell commands, so it assumes every other app and web page
on the machine is hostile. The CLI talks to it over a Unix socket
(`~/.local/share/kcoder/kcoderd.sock`, user-only). The web app needs HTTP, so
a second listener stays on `127.0.0.1` only, and every request on it must
carry a loopback `Host` header (a page that rebinds its DNS name to 127.0.0.1
gets a 403), WebSocket upgrades from browsers must come from the app's own
origin, pages are served with `frame-ancestors 'none'` and
`Cross-Origin-Resource-Policy: same-origin`, and every client must present
the per-install token stored in `~/.local/share/kcoder/token` (mode `600`) as
its first message. API keys are read from the environment or the
credentials file and are never written to logs or chat history; chat history
lives outside the repo and is gitignored anyway.

## Architecture

```
 terminal(s)            browser (phase 2)
  kcoder attach  ──┐   ┌── kcoder ui
                   ▼   ▼
             ┌──────────────┐   WebSocket over a user-only Unix socket (CLI) or
             │              │   127.0.0.1 with Host/Origin checks (app); token-authenticated
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
| `kcoder/tools.py` | Tool definitions and executors, scoped to each session's working directory; `run_bash` streams output and is killable. |
| `kcoder/projects.py`, `kcoder/chatlog.py` | Projects, KCODER.md, file listing; history helpers (forks, export, search). |
| `kcoder/worktree.py`, `kcoder/shell.py` | Git worktrees + merge/PR/discard; pty shells for the browser. |
| `kcoder/web/` | The browser app (vanilla JS; marked, highlight.js, xterm.js vendored). |

Daemon data lives in `~/.local/share/kcoder/` (override with `KCODER_DATA_DIR`);
the port defaults to `47321` (`KCODER_PORT`). Every model call is appended to
`usage.jsonl` for per-session and fleet-wide token accounting.
