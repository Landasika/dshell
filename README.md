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

### 2. Local development Host (no global `dsh`)

If `dsh` is not on `PATH`, use the development wrappers. They boot a Host with
the plugin in an isolated `.dsh-dev/` home (never touching `~/.dsh`) and
auto-detect a bundled DSH runtime:

```bash
# terminal 1 — Host and Web UI
./scripts/dev-host.sh

# terminal 2 — TUI against that Host
./scripts/dev-tui.sh
```

`./scripts/dev-host.sh` installs this checkout into a dedicated `dshell`
profile and rebuilds the profile when the plugin changes. Override `DSH_BIN`,
`DSH_HOME`, or `DSH_PROFILE` to use another CLI/home/profile.

### 3. Install the CLI

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

### 4. Open the TUI

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

The terminal is a daily tool, so the first screen is the session list you
actually need — no splash art:

```text
◆ dshell · DeepSeek Harness
────────────────────────────────────────────────────────────────────────────

choose session
/home/landasika/dshell

↑/↓ move · enter attach · n new session · q quit

▸ Socket client hardening                                    live 2m ago
  TUI redesign notes                                        cold 1h ago
  Release checklist                                         cold 3d ago
```

Inside a session:

```text
◆ dshell · session title                              ● running · /project
────────────────────────────────────────────────────────────────────────────
  transcript: streaming markdown, reasoning, tool cards, diffs, approvals
⚓ thinking · 412 tok · ctrl+o expand
│ 先确认每个应用的启动方式，再分派给子代理。
│ venv 已就绪，可以直接跑冒烟门。
⇢ agent started  接入 OctoPrint harness · 18b9d1cc
⢿ Running command · rg reconnect src · 12s · ctx 84%
▸ 1/3 · Adding bounded backoff                                    ctrl+t hide
────────────────────────── ctx ▰▰▰▱▱▱▱▱▱▱ 25% · 42 tps
❯ ask anything
──────────────────────────────────────────────────────────────────────
  enter send · / commands · @ files · ctrl+r history · ? help
deepseek-relay/deepseek-v4.1-flash  ~/dshell  main [↑10]  ✓ agents 1/1  cache ▰▰▰▰▰ 91%  ↑12.4k ↓840
```

- startup picker: drawn before the first Host round-trip, so the chat shell
  never flashes while connecting. Rows use the DSH title snapshot (the same
  one the Web UI shows) and fall back to `untitled session`, never to a bare
  UUID; subagent child sessions are hidden and remain reachable through the
  parent's `Ctrl-G` roster. Listing is scoped to the current workspace, cached
  for a few seconds, and titles are resolved progressively so a large shared
  `~/.dsh` stays responsive.
- header: brand, session title, status (idle / running / approval / error) and
  working directory.
- thinking: folded to a `⚓ thinking · N tok · ctrl+o` header plus the last
  three reasoning lines on a dim rail. `Ctrl-O` expands the full text; live
  reasoning streams on the same rail while the model is thinking.
- subagents: a `⇢ agent started` card when a child is spawned, updated to
  `✓ finished` / `✗ failed` from the durable settlement notice. `Ctrl-G` (or
  `/agents`) lists every child with its status; `Enter` opens that child's
  transcript in a read-only panel.
- live activity: spinner, current tool/verb, elapsed turn time and context
  pressure. Only shown while a turn runs; the header carries the idle state.
- scrolling: the mouse wheel (and `PgUp`/`PgDn`) scrolls the transcript, never
  the composer. While scrolled up a right-aligned `↓ N new · End` pill appears
  above the composer; click it, press `End`/`Enter`, or `Esc` to return to the
  live tail. `DSHELL_NO_MOUSE=1` disables mouse capture so the terminal keeps
  its own scrollback and text selection.
- composer (frameless, Claude-Code style): a horizontal rule, the `❯` input,
  another rule, then a dim shortcut hint. The top rule carries the context
  gauge (`ctx ▰▰▰▱▱▱▱▱▱▱ 25%`) and token speed (`42 tps`) right-aligned. Wide
  terminals get the 10-cell bar with TPS; narrower ones drop TPS, then collapse
  the bar to a plain percentage, then drop the gauge. Rules never wrap.
- usage rail (bottom, under the composer): provider/model route (`provider/model`),
  the cwd (`~/…`), the Git branch with ahead/behind counts (`main [↑10]`, `*`
  when dirty), subagent progress (`✓ agents 1/1`, `✗` plus a failed count),
  the cache hit rate (`cache ▰▰▰▰▰ 91%`) and, when space allows, session
  input/output totals and estimated spend (`~¥`). On narrow terminals it drops
  totals → spend → cwd → git → agents → cache, keeping the model route.
  Model and provider details, the peak/idle split and per-model rows live in
  `Ctrl-B`.
- context bar: measured occupancy from the latest usage, split into
  system / prompt / assistant / thinking / tools; amber at 80%, red at 95%.
  The bar is the readout's boundary, local estimates only divide the used span.
- todo strip: current task and completion count, foldable with `Ctrl-T`; the
  session panel keeps the full list.
- status strip (above the composer, only when non-empty):
  `✓ agents 1/1  ● jobs 1  ● todo 0/6`. `✓` means every subagent settled,
  `●` a child/job is still running; `✗` flags failed jobs. Jobs are folded from
  durable `job/registered` / `job/settled` events, so the count survives
  reconnects and history replay.
- composer: rounded frame that grows with the draft (up to seven rows); the
  shortcut hint sits in its bottom border.

### Spend estimate

DSH reports tokens, not money. The usage rail converts durable
`assistant/message.usage` events with DeepSeek's published per-million-token
rates (CNY, idle price; peak hours are doubled). Cache reads use the hit rate;
cache writes and uncached input use the miss rate; output uses the output rate.
Peak hours are Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00.

`~¥0.42` is an **estimate, not a bill**: prices can change, and the balance is
deducted on DeepSeek's side. Models missing from the rate table show tokens but
no amount (`unpriced`); the same applies to routes whose billing differs from
the official API.

### Keys

| Key | Action |
| --- | --- |
| `Enter` | send / run command |
| `Alt+Enter`, `Ctrl-J` | newline |
| `Tab` | complete `/` command or `@` file |
| `↑`/`↓`, `Ctrl-P/N` | completion, picker, or prompt history (seeded from the session's durable transcript) |
| `Alt+↑`/`Alt+↓` | scroll the transcript three lines (same as the wheel) |
| `PgUp`/`PgDn`, wheel | page or line scroll of the transcript |
| drag | select transcript text and copy it (OSC 52); `Shift+drag` uses the terminal's own selection |
| `Ctrl-R` | search prompts sent in this session |
| `Ctrl-B` | session panel: context breakdown, session spend, tokens, speed, todos, agents |
| `Ctrl-G` | subagent list; `Enter` opens that child's transcript |
| `q` | quit from the startup picker |
| `End` / `Enter` / `Esc` | jump back to the live tail while scrolled up |
| wheel, `PgUp`/`PgDn` | scroll the transcript |
| `Ctrl-T` | fold/show the todo strip |
| `Ctrl-O` | expand/fold thinking and lifecycle blocks |
| `?` | help & shortcuts (when the composer is empty) |
| `Esc` | close a menu/overlay or clear the composer; double-`Esc` on an empty idle composer opens rewind |
| `Ctrl-C` | clear input, cancel a running turn, or quit |
| `Ctrl-D` | quit when the composer is empty |

`Ctrl-C`/`Ctrl-D`/`Esc` quitting only closes this view; it never cancels the
Host turn. Cancel explicitly with `Ctrl-C` while a turn is running or
`/cancel`.

Commands: `/sessions` (aliases `/session`, `/resume`), `/workspaces`, `/new`,
`/attach`, `/cancel`, `/clear`,
`/reconnect`, `/rewind`, `/history`, `/panel`, `/status`, `/agents`, `/model`,
`/provider`, `/verbose`, `/help`, `/quit`. Approvals are modal: `a` allow once, `r` reject, `d` details.

### Models

`/model` asks the Host for its live provider/model catalog and opens a picker:

- `↑/↓` move, `Enter` switches the current session
- models that declare reasoning levels step into a level list first
  (`off` / `low` / `high` / `max`, each with its own description); `Enter`
  there commits model **and** level in one selection
- `e` reopens the level list for the highlighted model, `←` goes back
- `d` saves the highlighted model (and shown level) as the default
- `/model provider/model` switches directly; `/model default provider/model`
  saves a default without touching the current session

Switching is a Host operation, not a TUI guess: the `dshell-host` plugin
bridges DSH's `sessionController.modelCatalog()` and `selectModel()`, so the
same catalog the Web UI shows is used. DSH applies the selection on the next
request and appends a durable "model changed" notice; the selection also
becomes the saved default. The level a model was last switched with is
remembered per `provider/model` and shown in the bottom rail
(`deepseek-official/deepseek-flash · high`).

### Providers

`/provider` lists the provider rows of the patch file the Host booted with
(`$DSH_HOME/cordis.patch.yml`, else the active profile's), read through the
`dshell-host` plugin:

- `Enter` opens a field editor for `baseURL`, `apiKeyEnv` and `displayName`
- `Enter` on a field edits it, `Ctrl-U` clears it, `Enter` commits the field
- `s` writes the changed fields back and raises a confirmation:
  `Restart the Host now?` — `y` re-execs the Host and reattaches the session,
  `n` keeps the file change for the next manual start
- `a` adds a provider: `id`, optional `displayName` / `apiKeyEnv`, `baseURL`
  and a comma- or space-separated model list; the block is appended to the
  `providers` map and the same restart confirmation follows
- `x` deletes the selected provider (after a `y` confirmation, then the same
  restart prompt). The last remaining provider cannot be deleted
- `r` restarts the Host without editing

The editor only touches the lines it needs — a field edit rewrites that
scalar, `a` inserts one block, `x` splices one block out — so comments, model
lists and `!!js` expressions elsewhere in the patch file survive, and an
add/delete round trip leaves the file byte-identical. API keys themselves are
never stored there: the file carries the environment-variable name
(`apiKeyEnv`) and the secret stays in the environment or DSH's credential
store. Providers are read at Host boot, so an edit needs the restart the
confirmation offers — there is no live provider reload.

### Herdr

Run the TUI inside a [Herdr](https://herdr.dev) pane and it integrates itself:

- the pane shows `dshell` with `working`, `blocked` (approval waiting) or
  `idle` state in Herdr's sidebar and in `herdr agent list`
- the DSH session id and a resume command are reported, so a Herdr server
  restart reopens the same conversation in that pane
- quitting releases the agent from the pane
- outside Herdr it is a no-op; `DSHELL_NO_HERDR=1` disables it explicitly

Unlike Claude Code, which needs `herdr integration install claude` to write a
`SessionStart` hook into its settings, dshell speaks Herdr's
`pane.report_agent` socket protocol directly (the "Add Herdr support to your
agent" path), so there is no hook or settings file to install.

See [TUI design](docs/TUI-DESIGN.md) for the palette, metric sources and
responsive rules.

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
| `HOST_NOT_RUNNING` / no socket | Start `dsh --profile web` with the plugin installed, or run `./scripts/dev-host.sh`. |
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
pnpm test          # 30 tests
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
