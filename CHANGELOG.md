# Changelog

All notable changes to `@landasika/dshell` are documented here.
The project follows [Semantic Versioning](https://semver.org/) independently of DSH.

## [Unreleased]

### Changed

- `/model` switches in one Enter: a model with reasoning levels applies with
  the remembered level (or the catalog default) instead of detouring through
  the level submenu first. The explicit list stays on `e` / `→`.

## [0.4.0] — 2026-10-31

### Changed

- Provider failures that arrive as `<status> {json}` (a relay forwarding its
  upstream's body) are unwrapped for display: `429 · Upstream rate limit
  exceeded, please retry later` replaces a truncated JSON blob in the notice
  row, the toast and the transcript's failure block.
- The activity spinner reports the retry ladder while the host backs off —
  `Retrying · attempt 4/5 · RATE_LIMIT · 4s` — and a scheduled retry clears the
  dead attempt's stream preview, so a 429 ladder no longer reads as `Writing`.

- Mouse selections are tracked in transcript coordinates instead of screen
  rows, so the highlight follows the text through wheel scrolling (clipped at
  the transcript band) and a drag held past the top or bottom edge keeps
  scrolling one line per tick — a range can span more than one screen and is
  copied in full, not just its visible part. Scrolling inside a panel still
  clears the highlight, because panels repaint their own rows.

### Changed

- Exit semantics split by key: `Ctrl-Z` detaches (the turn keeps running in
  the Host, `/sessions` reattaches), while `Ctrl-C` on a running turn now
  stops the run and quits — the cancel carries a kill-subagents flag that
  aborts the session's live subagents too, so nothing of it outlives the TUI.
  `Ctrl-D` stays a plain detach.

### Added

- `/provider` rows can sync against the upstream (`u`): the Host diffs the
  declared models against `GET {baseURL}/models` and offers the result — `a`
  adopts new ids, `r` also drops the gone ones. Hand-tuned capacities on kept
  rows survive byte-identical; the router picks the change up live, and running
  sessions keep the model they already selected.

- `/provider` rows can sync against the upstream (`u`): the Host diffs the
  declared models against `GET {baseURL}/models` and offers the result — `a`
  adopts new ids, `r` also drops the gone ones. Hand-tuned capacities on kept
  rows survive byte-identical; the router picks the change up live, and running
  sessions keep the model they already selected.

- `/provider`'s add panel can fetch model ids from the upstream (`f`): the Host
  interrogates `GET {baseURL}/models` through its own discovery seam and fills
  the draft — adoption, not sync, because a listing carries no capacities. The
  panel also gains an `api` field (default `anthropic-messages`) that
  `provider/create` now writes; a model outside the installed catalog is
  invalid without it.

- The provider editor accepts pasted values (`ctrl-v`/middle-click from a
  password manager, bracketed paste) in every field, and the ask panel's custom
  answer box does too.
- Pasting a raw key (`sk-…`) into `apiKeyEnv` stores it in the Host credential
  store (`~/.dsh/.credentials.yaml`) and points the field at the reference it
  resolves through — the secret never lands in the patch file. New
  `provider/api-key` message and `provider-key` capability back it.

- `$` at the start of the composer opens the skill menu; picking a row inserts
  a `$name` mention that stays visible in the composer — the send path rewrites
  it into the `/name` gesture the Host parses, so invocation is two keys away
  without the visual jump to a slash.

- `skills/dsh-config`: a skill that documents the layer order, the
  patch-row semantics (per-key replacement, `name` matching, `insert`), the
  provider and model schemas, preset structure (persona, tools, skills), the
  verification commands, and the hot-reload rules — so "add a provider" or
  "change the agent prompt" is a config edit the model can do, not a UI to
  maintain.

- `/harness` lists the agent presets the Host composes sessions from: each
  preset's id, enabled/total plugin rows, whether the profile patch owns it,
  which one is the default, and the selected preset's first rows with the
  persona prompt and disabled tools called out. Read-only for now; it is the
  surface a preset editor will grow on.

## [0.3.0] — 2026-10-29

### Changed

- Background jobs read plainly and sit where the eye already is: the chip no
  longer says `✗ jobs 0 · ✗ 2` (which meant "none running, two failed" and
  looked like "zero failed") but `✗ 2 jobs failed`, and it rides the right edge
  of `✻ Worked for 48s · done 23:24` instead of taking a footer row of its own.

- The model's question is a bottom-pane wizard now, not a page: the transcript
  stays readable above it and the wizard takes the composer's place, one
  question per tab (`☐ Package manager  ☑ Checks  ✓ Submit`), a review page
  before anything is sent, `←/→` to move between questions, `1-9` to answer at
  once, and `Other` typed in place. It follows what Codex
  ([#9904](https://github.com/openai/codex/pull/9904)), mayfly's
  `question-wizard` and Claude Code all do: one question at a time, then a
  submission summary, instead of a wall of every question at once.

### Fixed

- `ask_user_question` now reaches the terminal at all. The Host's tool blocks
  inside a `user-questions/request` waterfall whose only answerer was the Web
  UI, so a Host driven purely from `dshell` failed the call with `NO_PROVIDER`
  the moment the model asked — nothing could ever be shown. The Host plugin now
  registers as that answerer for sessions a TUI client is watching and forwards
  the request as a live `question/request` (durable events remain the replay and
  late-answer path). Aborting the turn or losing the last client closes the
  overlay, and a second window's late answer is refused (`QUESTION_NOT_PENDING`)
  instead of steering a duplicate reply.

- A waiting model question no longer hides behind a panel. When the ask arrives
  while `/model` (or any other secondary page) owns the keyboard, the footer
  says `the model asks · close this panel (esc) to answer`; closing that panel
  opens the ask straight away instead of leaving it invisible — and the composer
  taking the answer as a prompt — until the next session event arrives.

- Model questions read like questions everywhere: the focus hint and the
  detail viewer show `Ask(which package manager?)` instead of
  `ask_user_question`, and the viewer lays out every header, question and option
  (`○` for one choice, `☐` for multi-select) then `id → answer` rows once
  answered, instead of the raw `questions=[{…}]` arguments. An answer batch whose call is gone is labelled `Ask` rather than
  `tool result` with JSON in the headline, and the custom answer row carries the
  `▸` cursor like every other row.

- A custom answer row behaves like the rest of the ask overlay: `Esc` backs out
  of the text field before hiding the ask, the footer swaps to a typing hint,
  and `Enter` commits and submits a single-question answer in one press.

- Answering a question no longer lets it pop back open: the answered call is
  dismissed locally until the Host settles it, and a failed submission restores
  the overlay instead of leaving it closed.

- The durable log can start at `seq: 0`: the first event is no longer hidden by
  the `/clear` watermark (`clearedAtSeq` starts at `-1`).

- Reading history while a turn streams no longer drags the transcript: the
  viewport anchors a reader who scrolled up to their first visible line, so
  rows appended below the window (and rows the composer grows into) move the
  scroll offset instead of sliding the text away.

- `/skills` now reads the catalog through the session's agent scope, so
  DSH-native skills (`~/.agents/skills`, preset-mounted discovery) show up
  instead of an empty list.

### Changed

- Every secondary page drops the box frame for a title, one horizontal rule and
  plain rows: `/model` and its reasoning-level page, the tool/subagent/skill
  viewers opened with `Alt+↑` → `Enter`, the pickers, the session panel,
  approvals and model questions. A drag selection no longer drags `│` border
  columns into the clipboard, and a centered block now aligns every row on its
  widest line instead of centering rows one by one.

### Added

- `/name args` reaches the model as a skill gesture: an unknown dshell command
  whose name is a user-invocable skill is forwarded as a prompt, and `i` in the
  `/skills` panel writes the invocation into the editor.

- `/skills` browses the Host's `ctx.skills` catalog: every source, with the
  hub roots, and `Enter` renders the skill body as Markdown.
- A configurable **skill hub**: directories of `SKILL.md` bundles served
  through `ctx.skills` (default `$DSH_HOME/dshell-skills`, override with
  `DSHELL_SKILL_HUB` or the `skillHub` plugin config). Skills from the hub
  show up in the Web UI and the `skill` tool too, and outrank user roots
  without shadowing project skills.
- Protocol capability `skills` plus `skills/list` and `skills/get`.


### Added

- A scripted promo/tutorial video: `docs/promo/` drives the real TUI with a
  fake backend, records every repaint, and renders a 1080p video
  (`record.sh` regenerates it in one command).

### Fixed

- Enter on a focused block now opens it even when the transcript is scrolled
  up. Previously that key press was consumed by "jump to live tail", although
  the focus hint promised `enter open`.

## [0.2.0] — 2026-10-28

### Added

- The TUI can answer `ask_user_question` calls. A pending ask (or one whose
  timed wait expired) opens an interactive overlay — `↑↓` move, `space`
  toggles options (radio or checkbox per `multi_select`), `c` types a custom
  answer, `enter` submits. Answers travel a new `question/answer` protocol
  command; the Host plugin steers a `user-question-reply` user message into
  the session, which is the same channel the Web UI's late answers use, so
  CLI and Web can answer each other's questions. `Esc` hides the overlay
  until that call settles; dismissed asks reopen only for a new call.

- Thinking blocks open in the detail panel: `Alt+↑/↓` to a `⚓ thinking`
  row, then `Enter` shows the full reasoning trace of that turn with its
  step count.

- Large pastes fold into a `[Pasted text #N +20 lines]` placeholder in the
  composer (more than 4 lines or 200 cells); the full content is substituted
  back when the prompt is sent. Pasted text is normalized on insert: CRLF
  becomes LF and trailing whitespace is stripped from every line.

### Fixed

- The composer cursor now moves after a typed space. The composer no longer
  reuses the transcript wrapper (which trims and collapses whitespace); its
  own WYSIWYG wrap keeps every typed space in a cell, so the cursor column
  tracks typing, and spaces beyond the line width are clamped instead of
  silently dropped.

### Changed

- The `v*` release workflow can now publish the verified tarball to npm
  automatically: it signs with npm provenance and runs only when the
  `NPM_TOKEN` repository secret is configured; without the secret it is a
  no-op and publication stays manual.

- Fenced code blocks in messages print verbatim: the language label row and
  the `│ ` gutter are gone, and the raw source line is emitted directly.

- `Alt+↑`/`Alt+↓` walk a selection across the transcript — user and assistant
  messages, tool calls, subagent rows, then the queued prompts — with the
  focused row banded and named above the composer. `Enter` opens the selection:
  a tool call shows its arguments and result in a scrollable panel, a subagent
  row opens the `/agents` list, and a queued prompt is pulled back into the
  composer for editing. `Alt+Backspace` deletes the selected queued prompt
  (through a new `queue/remove` Host command; `queue/edit` rewrites it in
  place), and `Esc` clears the selection.

### Added

- Markdown tables render as a box-drawn grid: column alignment follows the
  `:---` / `:--:` / `---:` markers, wide tables shrink and wrap their cells to
  the terminal width, escaped `\|` stays inside its cell, and pipes inside
  code fences are left alone.

### Changed

- The user-prompt band is a translucent slate (`#343c4b`, the old grey mixed
  over the panel colour) instead of a solid grey block.


- The queue below the transcript is now the Host's real inbox: dshell folds
  the durable `agent/inbox/spliced` events (the same projection the Web UI
  uses) instead of only remembering what this client sent. Prompts queued by a
  second terminal or the Web UI appear there too, edit/delete works on the
  shared inbox, and `Ctrl-C` re-queues everything that was still waiting.


- dshell signs itself with a whale: the header, the startup splash and the
  first assistant block of each turn use `🐳` instead of the `◆` diamond; the
  transcript header keeps the name (`🐳 dshell`) so it stays legible.

- User prompts render on a light-grey band with white text, so what you sent
  is easy to find when scrolling back.
- Only the first assistant block of a turn carries the `dshell` header; later
  steps after tools stay label-free.
- Newline is `Ctrl+Enter` now. dshell enables the kitty keyboard protocol
  (`CSI > 1 u`, popped on exit) so the terminal reports it distinctly; `Ctrl-J`
  and `Shift+Enter` keep working everywhere.

- Queueing a prompt for the next turn is `Alt+Q` now. Many terminals claim
  `Alt+Enter` for fullscreen (WezTerm and Windows Terminal do) and never pass
  it to the TUI, which made the key look broken; `Alt+Enter` still works where
  the terminal forwards it.

- Tool calls are folded to one line, Claude-Code style — `✓ Bash(ls -la)`,
  `✓ Read(src/tui/app.ts)`, `✓ Grep(reconnect)` — instead of dumping their
  output into the transcript; long calls end in `…` at the terminal width. `Ctrl-O` expands them inline, and
  `Alt+↑/↓` + `Enter` opens the detail panel; failures still show their first
  two output lines so errors stay visible.

- The session list (startup picker and `/sessions`) shows the **last edit**
  time instead of the creation time and is ordered by it. The Host now carries
  `updatedAt` from the session-list activity projection; sessions that the
  projection has not seen yet still fall back to `createdAt`.

- `Ctrl-C` in a running turn aborts that turn and then continues the `Alt+Enter`
  queue: an abort drops the Host inbox, so the TUI re-queues the prompts it is
  still tracking (the Host then starts them as soon as the abort settles —
  verified: `turn/end aborted` → `turn/start` → `user/message`).
- `Enter` while a turn is running now **steers**: the prompt joins the running
  turn instead of waiting behind it (Claude Code's default). `Alt+Enter` is the
  queue key that waits for the current turn to finish; `Ctrl-J` (and
  `Shift+Enter` on terminals that report it) inserts a newline. Both modes are
  labelled above the composer (`◷ steering · …` / `◷ queued · …`) until the
  Host writes the message into the transcript, so a prompt never looks
  swallowed.

### Fixed

- Focus reports no longer leak into the composer: terminals that report window
  focus send `ESC [ I` / `ESC [ O`, which the parser treated as an unknown
  escape and then typed the leftovers, so switching back to the terminal left a
  literal `[I` in the prompt. They now map to a `focus` key (the TUI refreshes
  the session list when the window regains focus), and any other unrecognised
  CSI/SS3 report is swallowed whole instead of falling through as text. The app
  also asks for focus reporting (`1004h`) and turns it off on exit.

- **No more full-screen flicker**: `TerminalScreen.draw` now rewrites only the
  rows whose text changed instead of clearing and repainting every row on
  every tick; a stable screen costs a handful of cursor bytes per frame, so the
  header, transcript and banner stop visibly flashing (measured: ~300 bytes per
  3 idle seconds, previously one full frame per redraw).
- A repeated failed turn no longer re-toasts on every retry: the same failure
  message is toasted once per 30 seconds while the header banner keeps it
  visible.

- **Rejected commands no longer look frozen**: an `error` reply from the Host
  now rejects the pending request immediately (it used to be dropped, leaving
  the TUI to wait out its 25 s timeout). A level the provider refuses, a stale
  session id after a Host restart and an unknown provider/model now surface as
  a toast with the Host's own message — 8 ms instead of 25 s of silence.
- **The TUI now survives a Host plugin reload**: the plugin is installed as a
  link into the profile, so touching the package (a rebuild, an update, a
  config edit) makes DSH re-create it, which drops every open socket. The
  client detects that drop and reattaches on its own — `host connection lost ·
  reconnecting` → `host back · reattached` — instead of turning every later
  command into `dshell-host connection is closed`. A failed background session
  poll no longer paints a permanent error either.
- `/model` rows that cannot be switched explain themselves: `Enter` on a
  provider header jumps to its first model, a failed provider row shows the
  failure reason, and switching to a model without reasoning levels says
  `(no reasoning levels)` instead of silently skipping the level step.

### Added

- **Reasoning levels (档位) in `/model`**: models that declare `reasoning.efforts`
  now open a Codex-style level list (`off`/`low`/`high`/`max`, each with its
  description); `Enter` commits model + level in one `model/select`, `e`
  reopens the list, `←` goes back, `d` saves the default with the level. The
  last level is remembered per `provider/model` and shown in the bottom rail
  as `provider/model · high`. Inside a picker `Shift+Enter` (LF) now commits
  like `Enter`, and `1`-`9` in the level list jump straight to that level.
- **Provider editor (`/provider`)**: lists the providers declared in the patch
  file the Host booted with (`$DSH_HOME/cordis.patch.yml`, else the active
  profile's), edits `baseURL` / `apiKeyEnv` / `displayName` in place, writes
  only the targeted YAML scalar lines (comments and model lists survive), and
  then asks `Restart the Host now?`. `a` appends a whole provider block
  (`id`, optional `displayName`/`apiKeyEnv`, `baseURL`, model list) and `x`
  removes one (never the last); both end in the same restart prompt, and a
  create-then-delete round trip restores the file byte for byte. Restart
  re-execs the Host with its own
  argv and the TUI reattaches the session automatically; declining keeps the
  file change for the next start. Secrets stay out of the file — only the
  env-var name is stored.
- **`providers` capability + protocol messages**: `provider/list`,
  `provider/update` and `host/restart` on the Host side, so the TUI never
  guesses a config path or spawns a process itself.
- **Model switching from the TUI**: `/model` reads DSH's live catalog through
  `sessionController`, switches the current session (`Enter`) and can save the
  deployment default (`d`, or `/model default provider/model`). The bottom rail
  updates optimistically until the next request header lands.
- **`/resume` alias**: `/resume` (and `/session`) open the same picker as
  `/sessions`, and `/resume` now appears in completion and help.
- **Retry visibility**: while a provider request is being retried, the activity
  line says `Retrying · attempt 3/5 · TRANSPORT` (with the live elapsed time)
  instead of a bare `Thinking`, so a long backoff no longer looks like a stuck
  turn.
- **Frameless composer**: the boxed prompt is now Claude-Code-style horizontal
  rules — top rule (with the context gauge and token speed right-aligned),
  the `❯` input, a bottom rule, then a dim shortcut hint. Input text starts
  two columns from the left edge and grows the same way as before.
- **Context and speed in the prompt rule**: `ctx ▰▰▰▱▱▱▱▱▱▱ 25% · 42 tps`
  degrades with width (bar + TPS → bar → pct + TPS → pct → TPS → nothing)
  instead of wrapping; the bar is skipped below 32 columns. Both moved out of
  the bottom rail to avoid showing them twice.
- **Herdr integration**: when dshell runs inside a Herdr pane it reports its
  agent state (`working` / `blocked` on approvals / `idle`), the DSH session id
  and a resume command over Herdr's socket API, and releases the pane on quit.
  Herdr can then restore the same session after a server restart. Being a
  native reporter (the "Add Herdr support" protocol) avoids the SessionStart
  hook that the Claude Code integration installs. `DSHELL_NO_HERDR=1` opts out.
- **Richer bottom rail**: one line now shows the provider/model route, `~/…`
  cwd, the Git branch with ahead/behind counts (and `*` when dirty), subagent
  progress, the cache hit rate and context pressure as segmented `▰/▱` bars,
  followed by token totals, spend and TPS when the width allows. Git is read
  asynchronously every few seconds and cached; segments drop by priority
  instead of wrapping.
- **Quoted prompts**: user messages render as `> hello` (continuation lines
  indented) instead of a separate `you` header, matching the composer and the
  Claude Code/Codex transcript style.
- **Visible turn failures**: a `turn/end` error (quota, auth, provider outage)
  now renders `! turn failed: <reason>` in the transcript, turns the header
  status red (`● error`) and raises a toast, instead of being hidden behind
  verbose mode. A prompt that gets no answer now explains itself.
- **Prompt history from the transcript**: `↑`/`↓` now recall prompts sent
  before this TUI attached, not just the ones typed in the current run. History
  is seeded from the durable `user/message` events whenever a session is
  opened or resumed (injected context and slash commands excluded, last 100
  prompts kept).
- **Text selection and transcript scroll keys**: the wheel, `PgUp/PgDn` and
  `Alt+↑/↓` scroll the transcript, while `↑/↓` keep their readline job of
  recalling prompt history. Dragging with the mouse selects transcript text,
  highlights it in reverse video and copies it through OSC 52; `Shift+drag`
  keeps the terminal's native selection.
- **One thinking block per turn**: reasoning used to render a three-line rail
  per assistant message (91 rails in one real session). It now folds to a
  single `⚓ thinking · N tok · N steps · ctrl+o expand` header per turn, and
  `Ctrl-O` expands the full text.
- **Startup picker titles**: the picker is painted before the first Host call
  (no chat-shell flash), lists only the current workspace's top-level
  sessions, and shows DSH title snapshots instead of session UUIDs. Subagent
  children are hidden from the picker and remain in the `Ctrl-G` roster.
  Session enumeration is cached and scoped, and titles resolve progressively.
- **Transcript scrolling**: SGR mouse capture routes the wheel to the
  transcript (3 lines per tick); `PgUp`/`PgDn` page. While scrolled up a
  clickable `↓ N new · End` pill returns to the live tail, as do `End`,
  `Enter`, `Esc`, or scrolling back. `DSHELL_NO_MOUSE=1` restores the
  terminal's native scrollback/selection.
- **Subagent visibility**: `subagent/catalog` spawns render as `⇢ agent
  started` cards that settle to `✓`/`✗` from the durable settlement notice;
  `Ctrl-G`/`/agents` lists the roster and `Enter` opens a child transcript.
  `Ctrl-B` gains an `agents` section.
- **Status strip**: one row above the composer summarising the session:
  `✓ agents 1/1  ● jobs 1  ● todo 0/6`. Agents fold from the subagent roster,
  jobs from `job/registered` / `job/settled`, todos from `todo/write`. Failed
  jobs show `✗ N`; the row disappears when all three are empty.
- **Thinking display**: reasoning folds to `⚓ thinking · N tok · ctrl+o` plus
  the last three lines; `Ctrl-O` expands. Live `reasoning-delta` stream chunks
  render on the same rail while the model thinks.
- **TUI design layer**: truecolor mist-blue palette with 256-colour fallback,
  list-only session picker, rounded composer with the shortcut hint in its
  bottom border, segmented context bar, live activity line with elapsed time,
  and a `Ctrl-B` session panel.
- **Usage & spend rail** below the composer: session input / cache / output
  totals, estimated DeepSeek spend (`~¥`, CNY, peak/idle rates), model, context
  pressure and live TPS. The panel adds cache read/write, the peak/idle split,
  per-model rows and unpriced tokens.
- **Spend estimation** (`src/tui/cost.ts`) from durable
  `assistant/message.usage`, deduplicated per `turn`/`step`; unknown models are
  reported as unpriced rather than guessed.
- **Navigation**: prompt history search (`Ctrl-R`), double-`Esc` rewind that
  restores a previous prompt into the composer, `Ctrl-T` todo folding,
  `Ctrl-O` detail toggle, `?` shortcut help, and `/rewind`, `/history`,
  `/panel`, `/status` commands.
- Metrics are derived from the durable log only (`assistant/message.usage`,
  `request/context`, todos, tool calls); no second source of truth.
- `scripts/dev-host.sh` and `scripts/dev-tui.sh`: boot an isolated
  `.dsh-dev` Host with the plugin loaded and open the TUI against it, including
  auto-detection of a bundled DSH runtime when `dsh` is not on `PATH`.

### Removed

- The pixel-whale launch art and block wordmark. The TUI is a daily tool; the
  launch screen is now the session list.

### Fixed

- Host handshake no longer enumerates sessions before replying. A slow or
  contended DSH home could block the welcome for minutes and make a listening
  Host look absent (`timed out waiting for dshell-host`). Session listing is
  now a separate request, bounded to 4s, with a 1.5s title-fold budget.
- Composer now grows with the draft instead of always reserving seven rows.
- Splash and panel layouts adapt to terminal width/height without clipping the
  picker or composer.

## [0.1.0] — 2026-10-23

First V1 candidate for Linux.

### Added

- **P0 feasibility**: Host plugin architecture, approval bridge, fail-closed
  decisions, compatibility risks.
- **P1 packaging**: `@landasika/dshell` DSH bundle, `dshell` bin, Node 22/24 CI,
  local pack gate.
- **P2 adapter**: `DshellBackend` / `SessionHandle` contract, `SocketBackend`,
  `FakeBackend`, error/capability mapping.
- **P3 session core**: protocol v2, workspace/session creation, history paging,
  cancel/steer, multi-session/multi-client fanout, first-answer-wins approval
  bridge between Web and CLI.
- **P4 TUI**: full-screen Claude Code-style terminal, durable transcript,
  streaming preview, markdown/tool/todo/diff blocks, composer/history,
  session/workspace switchers, approval overlay, CJK/ANSI safety.
- **P5 product CLI**: `dshell -p`, stdin, `text`/`json`/`stream-json`,
  stable exit codes, SIGINT/timeout, non-interactive approvals fail closed.

### Known limitations

- Linux only (macOS/Windows are not supported in V1).
- Tested DSH version: `0.2.1-rc.2`; other DSH versions are best-effort.
- One dshell Host per `DSH_HOME`; do not start a second Host.
- TUI watches one active session at a time; other sessions are polled every 5s.
- No npm publication in this repository's automated release workflow; the
  `v*` workflow produces a verified tarball and SHA256SUMS.

[0.3.0]: https://github.com/Landasika/dshell/releases/tag/v0.3.0
[0.2.0]: https://github.com/Landasika/dshell/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Landasika/dshell/releases/tag/v0.1.0

[0.4.0]: https://github.com/Landasika/dshell/releases/tag/v0.4.0
