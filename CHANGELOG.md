# Changelog

All notable changes to `@landasika/dshell` are documented here.
The project follows [Semantic Versioning](https://semver.org/) independently of DSH.

## [Unreleased]

### Added

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
