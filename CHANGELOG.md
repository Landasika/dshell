# Changelog

All notable changes to `@landasika/dshell` are documented here.
The project follows [Semantic Versioning](https://semver.org/) independently of DSH.

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
