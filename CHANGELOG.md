# Changelog

All notable changes to `@landasika/dshell` are documented here.
The project follows [Semantic Versioning](https://semver.org/) independently of DSH.

## [Unreleased]

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

[0.1.0]: https://github.com/Landasika/dshell/releases/tag/v0.1.0
