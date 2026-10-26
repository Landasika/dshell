# dshell

`dshell` is a Claude Code-style terminal frontend for an already-running
DeepSeek Harness (DSH) Host. The Web UI and the terminal are two frontends over
the same live Agents and durable Sessions:

```text
                    one dsh Host
        ┌──────────────────────────────────┐
        │ ctx.agents / ctx.sessions        │
        │ ctx.workspaceRegistry            │
        │ ctx.sessionQuery / ctx.approval  │
        └───────────────┬──────────────────┘
                        │
        ┌───────────────┴──────────────────┐
        │  @landasika/dshell Host plugin   │
        │  $DSH_HOME/run/dshell.sock       │
        └───────────────┬──────────────────┘
                        │ NDJSON, no token
             ┌──────────┴──────────┐
             │   dshell TUI / CLI  │
             └─────────────────────┘
```

The CLI never starts a second Host, never copies durable events into a second
truth, and never owns an Agent. Quitting a terminal only closes its view.

**V1 supports Linux only.** See [Supported versions](docs/SUPPORTED-VERSIONS.md).

## Status

P0–P6 are complete for the V1 candidate `0.1.0`:

- full-screen TUI, plus scriptable `dshell -p`;
- text / JSON / NDJSON output;
- workspace and session creation, history, cancel, steer;
- first-answer-wins approval bridge shared with the Web UI;
- fail-closed approvals for non-interactive and disconnected frontends;
- Node 22/24 CI and a verified npm tarball.

## Requirements

- Linux (x64 tested)
- Node `^22.19.0 || >=24.0.0`
- pnpm 11.x for development
- DSH `0.2.1-rc.2` (tested; other versions are best-effort)
- an already-running `dsh --profile web`

## Quick start

### 1. Build and install the Host plugin

```bash
git clone https://github.com/Landasika/dshell.git
cd dshell
pnpm install
pnpm build

# Load the plugin into the DSH web profile. The package is a DSH bundle, so
# this updates dsh.profile.bundles automatically.
dsh plugin --profile web add "$PWD"
```

Start the Host:

```bash
dsh --profile web
```

Look for:

```text
[dshell-host] listening on /home/<user>/.dsh/run/dshell.sock
```

The plugin must be present when the Host boots; it cannot be injected into an
already-running Host.

### 2. Install the CLI

While developing, run the built binary directly:

```bash
node dist/bin/dshell.js doctor
node dist/bin/dshell.js
```

Or install it globally:

```bash
npm install -g @landasika/dshell
# or, before npm publication, from a verified tarball:
npm install -g ./landasika-dshell-0.1.0.tgz
```

### 3. Open the TUI

```bash
dshell
```

In a non-TTY (pipe, CI), `dshell` prints help instead of writing control
sequences.

## TUI

```text
dshell
dshell --resume <sessionId>
dshell --no-color
```

- Enter sends; `Alt+Enter` / `Ctrl-J` inserts a newline.
- `Tab` completes `/` commands and `@` file paths.
- `PgUp`/`PgDn` scroll; `Ctrl-C` clears input, cancels a running turn, or exits.
- `Ctrl-D` exits when the composer is empty.
- startup chooser: pick an existing session in the current workspace or create a new one;
  if the workspace does not exist yet, create it or quit;
- `/sessions`, `/workspaces`, `/new`, `/attach`, `/cancel`, `/clear`,
  `/reconnect`, `/verbose`, `/help`, `/quit`.
- Approvals appear as a modal: `a` allow once, `r` reject, `d` details.
- Exiting never cancels the Host turn. Cancel explicitly with `Ctrl-C` or
  `/cancel`.

## Scriptable CLI

```bash
dshell -p "summarize this repository"
dshell -p --session <sessionId> "continue"
dshell -p --new --cwd /path/to/project "initialize the project"
printf 'summarize this repo\n' | dshell -p

dshell -p --json "..."                       # one JSON result object
dshell -p --output-format stream-json "..."  # NDJSON start/event/result
```

`-p` writes only the result to stdout; diagnostics go to stderr. It never
prompts: any approval is rejected and the exit code is `5` (fail closed).

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | turn completed |
| 1 | Host/connection/protocol/internal error |
| 2 | invalid usage |
| 3 | turn failed, cancelled, or abnormal end |
| 4 | `--timeout` reached |
| 5 | approval denied in non-interactive mode |
| 130 | SIGINT |

### Low-level commands

```bash
dshell doctor
dshell workspaces
dshell list [workspaceId]
dshell new [cwd]
dshell attach <sessionId>
dshell prompt <sessionId> '…'
dshell steer <sessionId> '…'
dshell cancel <sessionId>
```

Options:

```text
--socket <path>       control socket override
--timeout <ms>        turn timeout (default 120000)
--verbose             context/lifecycle diagnostics
--resume <id>, -r     TUI: open a session directly
--no-color            disable ANSI colors
-p, --print           one-shot mode
--output-format <f>   text | json | stream-json
--json                shorthand for --output-format json
-s, --session <id>    use an existing session
-w, --workspace <id>  workspace for a new session
--cwd <path>          cwd for a new session
--new                 always create a session
```

Environment:

```text
DSH_HOME              DSH home (default: ~/.dsh)
DSHELL_SOCKET         control socket override
```

## Approvals and safety

- DSH approval is answered by a Host bridge. The Web UI and a CLI/TUI can race;
  the **first valid answer wins**.
- The bridge registers with `{ global: true, prepend: true }` so the agent-scoped
  Web answerer cannot block it.
- Timeout, Host shutdown, request abort, and last-watcher disconnect return
  `unavailable`; they never auto-allow.
- `dshell prompt` on a TTY asks `[a]llow once / [r]eject`; non-TTY rejects.
- `dshell -p` always rejects and exits `5`.
- Approval request ids come from the Host bridge, never from a replayed
  `approval/asked` durable event.

The socket is `$DSH_HOME/run/dshell.sock`, directory `0700`, socket `0600`.
There is no token or Cookie. Run dshell as the same user that started the Host.

## Design notes

- The Host owns all live Agents and Sessions.
- The plugin holds the Agent handles it resumes; a CLI disconnect only drops
  subscriptions.
- Durable truth is `session/event`; `agent/assistant-stream` is a live
  presentation channel only.
- One Host per `DSH_HOME`. A second Host refuses to bind the same socket.
- The plugin is a DSH bundle (`package.json:dsh.bundle.patch`); no DSH source
  changes are required.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `HOST_NOT_RUNNING` / no socket | Start `dsh --profile web` with the plugin installed. |
| `PLUGIN_MISSING` | The Host booted without `dshell-host`; add the plugin to the web profile and restart. |
| `PROTOCOL_MISMATCH` | Install the CLI and plugin from the same dshell version. |
| `SOCKET_PERMISSION_DENIED` | Run dshell as the Host user; check `DSH_HOME` ownership and socket mode `0600`. |
| `[warn] dsh version` in doctor | Your DSH is outside the tested matrix; see [Supported versions](docs/SUPPORTED-VERSIONS.md). |
| Approval seems to wait | Check the Web UI and any other dshell client; only one answer wins. Disconnect/unanswered requests fail closed. |
| TUI won't start in a pipeline | It needs a TTY. Use `dshell -p` for scripts. |
| Second Host fails to start | Stop the first Host; only one dshell Host per `DSH_HOME`. |

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test          # 28 tests
./scripts/ci.sh    # full local gate, including clean pack/install
```

Release artifacts are verified with `scripts/verify-pack.sh`. The tag workflow
`.github/workflows/release.yml` runs the same gate and uploads the tarball plus
`SHA256SUMS`; npm publication is a manual, credentialed step.

## Documentation

Stage docs:

- [P0 — feasibility](docs/dev/00-feasibility.md)
- [P1 — packaging](docs/dev/01-packaging.md)
- [P2 — adapter](docs/dev/02-adapter.md)
- [P3 — session core](docs/dev/03-session-core.md)
- [P4 — TUI](docs/dev/04-tui.md)
- [P5 — product CLI](docs/dev/05-product-cli.md)
- [P6 — compatibility and release](docs/dev/06-compatibility-release.md)

Reference:

- [Supported versions](docs/SUPPORTED-VERSIONS.md)
- [Changelog](CHANGELOG.md)
- [Architecture](find/architecture.md)
- [P3 evidence](find/p3-evidence.md)
- [P4 evidence](find/p4-evidence.md)
- [P5 evidence](find/p5-evidence.md)
- [P6 evidence](find/p6-evidence.md)
