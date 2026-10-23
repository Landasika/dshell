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

This repository is at the P1 scaffold stage:

- CLI: `doctor`, `list`, `attach`, `prompt`;
- Host plugin: `dshell-host`, mounted through a DSH profile bundle;
- transport: `$DSH_HOME/run/dshell.sock` with mode `0600`;
- protocol: NDJSON, version 1.

TUI, approval answering, commands, todo/plan/subagent panels, and `-p` are not
implemented yet. The `poc/` directory contains earlier probes and the M1 spike.

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

For local development, build first and install the package into the profile:

```bash
pnpm build
dsh plugin --profile web add "$PWD"
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
dshell doctor
dshell list
dshell attach <sessionId>
dshell prompt <sessionId> 'Reply with exactly DSH_OK'
```

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

- [`find/architecture.md`](./find/architecture.md)
- [`find/p1-revision.md`](./find/p1-revision.md)
- [`find/P0.md`](./find/P0.md)
