# dshell

`dshell` is a terminal frontend for an already-running DeepSeek Harness Host.
It is the second frontend next to the Web UI:

```text
one dsh Host
  ├─ Web UI
  └─ dshell CLI  ← Unix socket, no token
```

V1 supports **Linux only**. macOS and Windows are out of scope for now.

## Status

This repository has completed **P0–P4** (session core + TUI):

- default `dshell` opens a Claude Code-style full-screen TUI;
- CLI: `doctor`, `workspaces`, `list`, `new`, `attach`, `prompt`, `steer`,
  `cancel`;
- Host plugin: `dshell-host`, mounted through a DSH profile bundle;
- transport: `$DSH_HOME/run/dshell.sock` with mode `0600`;
- protocol: NDJSON, version 2;
- Workspace/Session creation, history paging, cancel/steer;
- approval bridge: CLI and Web can answer the same request; first answer wins,
  timeout/disconnect fail closed.

P5 (product CLI / `-p` / JSON) and P6 (compatibility/release) are still ahead.
The `poc/` directory contains earlier probes and the M1 spike.

## Requirements

- Linux
- Node `^22.19.0 || >=24.0.0`
- pnpm 11.x
- DSH `0.2.1-rc.2`
- an already-running `dsh --profile web`

## Build

```bash
pnpm install
pnpm build
pnpm test
```

The TypeScript build writes to `dist/`. The CLI entry is `dist/bin/dshell.js`;
the Host plugin entry is `dist/plugin/index.js`.

## Install the Host plugin

The package has two consumers:

1. the global CLI binary;
2. the DSH profile that loads the Host plugin.

Until `@landasika/dshell` is published, use the local package. Build first, then
install it into the profile:

```bash
pnpm build
dsh plugin --profile web add "$PWD"
```

After publishing, the same two steps are:

```bash
npm install -g @landasika/dshell
dsh plugin --profile web add @landasika/dshell
```

The plugin is a DSH bundle (`package.json:dsh.bundle.patch`), so `dsh plugin`
adds it to `dsh.profile.bundles` automatically. Start the Host:

```bash
dsh --profile web
```

Look for:

```text
[dshell-host] listening on /home/<user>/.dsh/run/dshell.sock
```

## Use the CLI

```bash
dshell                         # full-screen TUI
dshell --resume <sessionId>    # open a session directly
dshell doctor
dshell workspaces
dshell list [workspaceId]
dshell new [cwd]
dshell attach <sessionId>
dshell prompt <sessionId> 'Reply with exactly DSH_OK'
dshell steer <sessionId> 'Change direction while the turn is running'
dshell cancel <sessionId>
```

`prompt` asks for approval on a TTY (`allow once` / `reject`). On a non-TTY it
rejects anything pending instead of silently allowing it. `steer` requires a
running turn; use `prompt` to start a new one.

Options:

```text
--socket <path>     override the control socket
--timeout <ms>      prompt/turn timeout (default: 120000)
--verbose           print context and lifecycle events
```

Environment:

```text
DSH_HOME            DSH home (default: ~/.dsh)
DSHELL_SOCKET       control socket override
```

`dshell attach` replays the current snapshot and then prints live events; it
does not resume a cold Agent just to read history. `dshell prompt` resumes a
cold session when needed, using the session's preset and model selection.
`dshell new` uses the CLI's current directory when no `cwd` is given, not the
Host process's directory.

`dshell` never starts a second Host. If the socket is missing it prints an
actionable error and exits.

## Design notes

- The Host owns all live Agents and Sessions.
- The plugin holds Agent handles it resumes itself; a CLI disconnect only drops
  subscriptions and never disposes an Agent.
- Durable truth is `session/event`; `agent/assistant-stream` is only a live
  presentation channel.
- The CLI uses no token or Cookie. Access is controlled by the socket's `0600`
  mode and the user's UID.
- The plugin must be loaded when the Host boots; it cannot be injected into an
  already-running Host.

See:

Stage docs:

- [`docs/dev/00-feasibility.md`](./docs/dev/00-feasibility.md)
- [`docs/dev/01-packaging.md`](./docs/dev/01-packaging.md)
- [`docs/dev/02-adapter.md`](./docs/dev/02-adapter.md)
- [`docs/dev/03-session-core.md`](./docs/dev/03-session-core.md)
- [`docs/dev/04-tui.md`](./docs/dev/04-tui.md)

Findings:

- [`find/architecture.md`](./find/architecture.md)
- [`find/p3-evidence.md`](./find/p3-evidence.md)
- [`find/p1-revision.md`](./find/p1-revision.md)
- [`find/p1-implementation.md`](./find/p1-implementation.md)
- [`find/P0.md`](./find/P0.md)
