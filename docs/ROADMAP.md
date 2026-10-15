# kcoder roadmap (agreed 2026-10-12)

Each item ships on its own: built, tested on an isolated daemon (fake `claude`
on PATH whenever a turn could start), committed and pushed. Status is kept
here so any session can pick up where the last one stopped.

| # | Feature | Status |
|---|---|---|
| 1 | **Connector approvals**: connector reads run by themselves; anything that sends or changes (email, calendar, Drive, Linear writes) waits for an approval that shows exactly what would go out. Same inbox / pane / phone flow as tool and push approvals. | done (PreToolUse hook `kcoder/permit.py`; reads by verb, unknown tools ask; 8-minute wait, 10-minute grants for a late approval) |
| 2 | **Long-running work**: commands that outlive the Bash tool's two-minute limit become background jobs with live output, a stop button and a result the session picks up when the job ends. Also lets the push gate wait longer. | done (`kcoder job run -- <cmd>`, `kcoder/jobs.py`; Bash timeouts 10 min / 1 h; review and connector waits 8 min) |
| 3 | **Dry-run sessions**: the agent plans and shows the diff it would make without touching files. | done (trust level `dry`: built-in tools refuse writes and non-read-only shell commands, Claude Code runs in plan mode; pane chip "dry run · do it" switches to a real run) |
| 5 | **Per-repo rules in plain English** (`KCODER.md`): "never touch migrations", "run the tests before committing", enforced as checks. | done (`kcoder/rules.py`: protect / only / never-commit / never-run / run-before-commit / run-before-push; checked in the built-in tools, the Claude Code PreToolUse hook and the worktree git hooks; listed in the instructions dialog) |
| 12 | **Automatic handoff**: at the compaction point kcoder writes the handoff summary and starts a fresh session instead of carrying a giant context. | done (`Engine._maybe_handoff` + `Manager._handoff`: fresh session in the same worktree, pending message and queue move over, panes follow, old session archived; Settings toggle, off = compact in place) |
| 13 | **Plan-limit awareness**: how much of the 5-hour and weekly limits a session is using. | done (utilization from Claude Code's rate_limit_events: status-bar `plan 5h 23% · wk 41%`, bars with reset times and a per-session share in the plan dialog, share on each pane and sidebar row; `kcoder plan` prints it) |
| 9 | **GitHub issues in**: an issue URL as a task; the PR links back and closes it. | done (`kcoder/issues.py`: URL or owner/name#N in a task or first message; repo defaults to the issue's; issue chip; PR title from the issue, body starts with Closes #N, comment on the issue with the PR link) |
| 8 | **Session templates**: one-click starts with repo, model, trust and first prompt. | done (saved from the new-session dialog into config `templates`; template picker there, ⌘K `start: name`, `kcoder start <name>`; daemon request `templates` list / save / remove / run) |
| 7 | **Auto-fix on CI failure**: a red check on a draft PR opens a session with the failing log; the fix lands in review. | done (PR poll loop: `pr.failure_report` via gh pr checks + gh run view --log-failed, sent to the owning session once per head commit, max three per PR; the push goes through the review gate; Settings toggle `ci_autofix`) |
| 10 | **Morning brief**: what every session did, what is waiting, what is in review. | done (`kcoder/brief.py`; request `brief`; dialog opens once a day on the first visit and from ⌘K; `kcoder brief`; copy as markdown) |
| 14 | **Search across transcripts** with filters (repo, date, free text). | done (`kcoder/search.py`: AND terms, phrases, repo:/since:/until:/date:/who:; search dialog with filter chips, hits jump to the message; sidebar quick results; `kcoder search` flags) |
| 16 | **Keyboard-only inbox**: next waiting item, approve, next. | done (one waiting list of approvals, questions, reviews, errors; `w` next item, `y` / `⇧N` answer and advance; inbox: j/k, y/n, ↩ open, a all) |
| 17 | **Export a session as a shareable HTML page**. | done (`chatlog.export_html`: single file, inline styles, vendored marked.js, tool calls and results folded, commits, secrets masked; export chooser on the pane, `kcoder export --html`) |
| 11 | **Voice input** on the phone approval page and the composer. | done (composer microphone + ⌘⇧M via the Web Speech API; phone page "say yes or no" answers the request; relay redeploy needed for the phone part) |
| 15 | **Light-theme pass and a compact density setting**. | done (light theme checked, only the preview frame keeps a fixed white; Settings → Density comfortable / compact, `html[data-density]` overrides) |

Dropped from the list: 4 (per-session budgets), 6 (plan-then-fan-out).

## Daily flow and visibility pass (2026-10-15)

Seven features in two phases; each phase is verified on an isolated daemon
(fake `claude` records what it was sent), committed and pushed.

| # | Feature | Status |
|---|---|---|
| 1 | **Paste screenshots**: ⌘V and drag into any composer and the task composer, several per message; thumbnails above the input (remove, click to view); Retina screenshots scaled to 1568 px on the long side; saved with the session and shown in the transcript; a model that cannot take images is called out before the send. | done (`prepareImage` / `addImage` in app.js; `/uploads/<sid>/<file>?token=` route; Claude Code gets image blocks over `--input-format stream-json`; `providers.supports_images`) |
| 2 | **Weekly plan limit meter**: used, reset, pace and forecast in the status bar, the full meter on the stats page; Claude Code's own numbers when reported, else an estimate from history against a limit and reset day set in Settings, labelled either way; warnings at 75% and 90%; optional quota shift to cheaper models, off by default and always visible when on. | done (`kcoder/quota.py`; requests `quota`, `config` quota_* fields; `Engine.quota_shift`) |
| 3 | **Where we left off**: a recap card on a session idle 24h+ or after an app restart: done, pending, open decisions, branch state; cheap model, cached, rewritten only on new activity; dismissible; `/recap`. | done (`kcoder/recap.py`, request `recap` get / refresh / peek / dismiss; `.recap-slot` in the chat pane) |
| 4 | **Voice input**: on-device macOS transcription in the app window (Speech framework, `requiresOnDeviceRecognition`), biased towards repo names and dev terms; push-to-talk (hold ⌥Space or the mic button), click to toggle; words only land in the input, never sent. | done (`Dictation` in `kcoder/app.py`, `window.kcoderDictation`; Info.plist usage strings; Web Speech API in a browser tab) |
| 5 | **Deploy status per repo**: Cloudflare Pages/Workers, Railway, Supabase targets from the repo's config, read-only through the provider CLIs; badge in the pane header and sidebar; "open in session" sends a failed deploy log to the repo's session. | phase 2 |
| 6 | **Session timeline**: a scrubber with one mark per turn (tools, files, errors, tokens); click jumps the transcript and shows the diff as of that turn; filters; undo to here through the existing checkpoints. | phase 2 |
| 7 | **kcoder Wrapped**: weekly (Monday) and monthly (the 1st) recap cards with an archive on the stats page; PNG export through the save dialog; brand tokens and the KCODER banner. | phase 2 |
