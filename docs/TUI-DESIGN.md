# TUI design

`dshell` is a terminal frontend over a live DSH Host. The TUI follows three
rules:

1. **Terminal-native.** Every screen is plain ANSI text; no images, no mouse
   requirement, no alternate widget toolkit. It works over SSH and in a 24-row
   terminal.
2. **One truth.** The durable session log is the only source. Metrics are
   projections of `SessionView.events`; the TUI never keeps a second counter
   that can drift from the Host.
3. **Responsive by dropping optional fields.** The prompt frame keeps `ctx`
   longest but trades the bar for a percentage and then drops it; the usage
   rail keeps the model route longest and drops totals, spend, cwd, git,
   agents and cache first. The launch picker and the composer are never
   clipped to make room for decoration.

## Screen regions

```
┌ header ────────────────────────────────────────────────────────────────┐
│ ◆ dshell · title                       ● status · cwd                  │
├ rule ──────────────────────────────────────────────────────────────────┤
│ transcript (markdown, reasoning, tool cards, diffs, approvals)         │
│                                                                        │
├ thinking (folded, Ctrl-O expands) ─────────────────────────────────────┤
│ ⚓ thinking · 412 tok · ctrl+o expand                                   │
│ │ last three reasoning lines                                          │
├ agent card (spawn/settle) ─────────────────────────────────────────────┤
│ ⇢ agent started  接入 OctoPrint harness · 18b9d1cc                     │
├ activity (only while a turn runs) ─────────────────────────────────────┤
│ ⠹ Running command · detail · 12s · ctx 84%                             │
├ todo strip (only when todos exist) ────────────────────────────────────┤
│ ▸ 1/3 · current task                                      ctrl+t hide  │
├ status strip (only when agents/jobs/todos exist) ──────────────────────┤
│ ✓ agents 1/1  ● jobs 1  ● todo 0/6                                     │
├ composer ──────────────────────────────────────────────────────────────┤
│ ╭─ prompt ─────────── ctx ▰▰▰▱▱▱▱▱▱▱ 25% · 42 tps ───────────────────╮ │
│ │ ❯ draft                                                            │ │
│ ╰─ enter send · / commands · @ files · ctrl+r history · ? help ───────╯ │
├ jump pill (only while scrolled up) ────────────────────────────────────┤
│                                        ↓ 12 new · End                 │
├ usage rail ────────────────────────────────────────────────────────────┤
│ deepseek-relay/deepseek-v4.1-flash  ~/dshell  main [↑10]  ✓ agents 1/1 │
│ cache ▰▰▰▰▰ 91%  ↑12.4k ↓840  ~¥0.42                                    │
└────────────────────────────────────────────────────────────────────────┘
```

The launch screen is a plain, keyboard-first list — no splash art:

```
◆ dshell · DeepSeek Harness
────────────────────────────────────────────────────────────────────

choose session
/home/user/project

↑/↓ move · enter attach · n new session · q quit

▸ Socket client hardening                                    live 2m ago
  TUI redesign notes                                        cold 1h ago
```

`choose session` and `workspace not created` are the two launch states; the
second replaces the list with `c`/`enter` create and `q`/`esc` quit.

## Palette

The default family is **mist blue** (`src/tui/theme.ts`):

| Token | Hex | Use |
| --- | --- | --- |
| `accent` | `#4d6bfe` | brand, focus, prompt caret |
| `accentSoft` | `#8aa2ff` | secondary emphasis, model name, section titles |
| `text` | `#dce3f0` | body text |
| `muted` | `#7b879c` | hints, secondary labels |
| `border` | `#2f3a4f` | rules and frames |
| `success` | `#48c78e` | completion, comfortable context |
| `warning` | `#f5b451` | context ≥ 80%, approvals |
| `error` | `#f26d78` | failures, context ≥ 95% |

The context bar uses a five-step blue ramp (`contextSystem` → `contextTools`).
`COLORTERM=truecolor` selects 24-bit sequences; otherwise the theme emits the
nearest xterm-256 colour. `NO_COLOR` / `DSHELL_NO_COLOR` disable styling while
keeping block glyphs readable; `DSHELL_TRUECOLOR=1|0` overrides detection.

## Metrics

`src/tui/metrics.ts` projects one `SessionView`:

| Field | Source |
| --- | --- |
| model / provider / context window | latest `request/context` (fallback `request/header.config`) |
| input/output/cache usage | latest `assistant/message` `usage`, normalized across camelCase/snake_case variants |
| used tokens | `usage.total`, else the sum of usage fields, else local estimates |
| composition | estimates from system/user/assistant/reasoning/tool event text, scaled to the measured total |
| activity | pending approval → approval; unmatched `tool/call` → tool; live stream → writing; running → thinking; completed turn → done |
| elapsed / last turn | `turn/start` / `turn/end` timestamps |
| todos | latest `todo/write` or `todo/update` snapshot |
| TPS | stream-growth tokens per second, sampled at most every 700 ms |
| session spend | `assistant/message.usage` folded by `turn`/`step`, priced with the DeepSeek CNY table; peak/idle split |
| per-model spend | provider/model from `request/context` or `request/header`, one entry per route |

The context bar's boundary always comes from measured occupancy. Local
composition estimates only divide the used span, so the readout and the bar
cannot disagree. Without a context window the rail drops the gauge, keeps the
percentage only, and omits the pressure colour.

## Spend estimate

`src/tui/cost.ts` is a pure fold over durable usage events:

| Field | Rate |
| --- | --- |
| `input` | miss rate |
| `cacheWrite` | miss rate |
| `cacheRead` | hit rate |
| `output` | output rate |

Peak hours (Beijing time, Mon–Fri 09:00–12:00 / 14:00–18:00) double the rate.
The table is keyed by model prefix, longest match first:
`deepseek-v4.1-flash`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
`deepseek-flash` all use the Flash price. Unknown models contribute
`unpricedTokens` and never invent an amount.

One `(turn, step)` settles once, so replayed snapshots and history pages cannot
double-bill a step. Retry events (`llm/retry`, `llm/retry-started`) carry no
usage and are ignored.

`~¥0.42` is an estimate, not a bill. The panel shows the peak/idle split, the
per-model breakdown and the unpriced remainder; the rail keeps only the total.

## Startup

The picker is the first frame: `runTui` installs a `loading` startup state
before `screen.start()`, so a slow Host cannot flash the chat shell. The boot
sequence then loads workspaces, resolves the workspace for the cwd, and asks
the Host for that workspace's sessions only. While the answer is in flight the
picker accepts only `q`/`Ctrl-C`; `Enter`/`n` are ignored so a stray keypress
cannot create a session.

Session rows come from `SessionSummary.title`, which the Host folds from the
DSH title snapshot (falling back to the session header). Rows without a title
show `untitled session`, never the raw UUID, and sessions whose header carries
`origin: "subagent"` (or a `parentSession`) are excluded: children belong to
their parent's roster, not the global picker. Session lists are cached for a
few seconds and titles resolve a few rows per poll, because a shared `~/.dsh`
can hold hundreds of sessions and every snapshot read costs hundreds of
milliseconds.

## Selection and clipboard

Mouse reporting is enabled for the wheel, but a left-button drag is captured
and rendered as a reverse-video selection over the last frame. On release the
app extracts the selected display cells (wide CJK/emoji aware, ANSI stripped,
trailing padding trimmed) and writes it to the terminal clipboard with OSC 52,
showing `copied N lines`/`copied N chars`. Holding Shift still hands the drag
to the terminal's native selection for environments where OSC 52 is disabled.
`DSHELL_NO_MOUSE=1` disables the whole mouse protocol.

## Herdr

Inside a Herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`) the
TUI reports to Herdr's local socket directly: `pane.report_agent` for the
semantic state and DSH session, `pane.release_agent` on quit. State is
`working` while a turn runs, `blocked` with the tool name while an approval is
waiting, and `idle` otherwise. The resume command is `dshell --resume <id>`
when `dshell` is on `PATH`, otherwise `node <current bin> --resume <id>`.

Reports are fire-and-forget with a 400 ms timeout; at most one request is in
flight and intermediate states collapse into the newest, so a slow or dead
Herdr can never stall rendering. Sequence numbers are millisecond timestamps,
which Herdr uses to discard late reports. This is the protocol from Herdr's
"Add Herdr support to your agent" guide; no hook installation or settings
merge is involved, unlike the Claude Code integration.

## Scrolling, agents and thinking

**Scrolling.** The alternate screen enables SGR mouse reporting
(`1007l`, `1000h`, `1006h`); the wheel scrolls the transcript three lines per
tick and never the composer. `PgUp`/`PgDn` page by a viewport. While the
offset is non-zero the renderer emits a right-aligned `↓ N new · End` pill
above the composer and remembers its 1-based row for click hit-testing. `End`,
`Enter`, `Esc`, a click on the pill, or scrolling back to the bottom all
restore the tail; `N` counts transcript lines appended since the last time the
tail was visible. `DSHELL_NO_MOUSE=1` skips mouse capture (native scrollback),
and `Shift`+drag still selects in most terminals.

**Subagents.** The roster is a pure fold over durable events:
`subagent/catalog` opens a row (`childId`, `label`, `mode`, `childCreatedAt`),
and a spliced `agent/inbox/spliced` item whose `source.kind` is
`subagent-settled` closes it as `done` or `failed` (the notice text decides).
`subagent/start`/`end`/`status` are accepted for hosts that emit them. The
transcript shows the spawn as a `⇢ agent started` card that flips to `✓`/`✗`;
`Ctrl-G`/`/agents` lists the roster and `Enter` attaches the child session for
a read-only transcript view (`backspace` returns to the list).

**Status strip.** One row above the composer folds three independent
projections: agents (settled/total, `✓` when all settled), background jobs
(`running`, plus `✗ N` failures) and todo completion. All three come from the
durable log, so replaying history on attach reconstructs the same strip; the
row is omitted entirely when every section is empty.

**Thinking.** Each `assistant/message` reasoning part becomes a folded block:
a `⚓ thinking · N tok · ctrl+o expand` header plus the last three reasoning
lines on a `│ ` rail. `Ctrl-O` rebuilds the transcript expanded and shows the
full reasoning (the hint flips to `ctrl+o fold`). Live `reasoning-delta`
stream chunks render on the same rail above the streaming text as
`✻ thinking · live`, so the model's reasoning is visible without leaving the
turn.

## Interaction

- `?` opens help only when the composer is empty, so `?` remains typable.
- `Ctrl-R` searches prompts sent in this session; `Enter` restores the match
  into the composer without sending.
- Double-`Esc` on an empty idle composer opens **rewind**. V1 rewind restores a
  previous prompt into the composer; it does **not** truncate the durable
  session, because the protocol has no rewind operation. The overlay says so.
- `Ctrl-B` opens the session panel with the compact context legend, session
  spend (peak/idle, per model), token usage, speed history and todos. Esc
  closes it; the body is clipped to the viewport and keeps its footer hint.
- `Ctrl-T` folds the todo strip; the panel still shows the list.
- Approvals remain first-answer-wins between the Web UI and every terminal.
  Timeout, disconnect, and non-TTY frontends fail closed.

## Responsiveness

- The prompt frame's `ctx`/TPS variants degrade with width: bar + TPS, bar,
  percentage + TPS, percentage, TPS only, then nothing. The frame is always
  exactly `columns` wide.
- Usage-rail segments drop in this order: input/output totals → spend → cwd →
  git breadcrumb → agents → cache. The provider/model route never drops. The
  cache bar only appears from 96 columns; below that it collapses to a
  percentage.
- The jump pill is one row; it shortens to `↓ N new · End` / `↓ Jump to
  bottom · End` rather than wrapping over the transcript.
- The session panel clips its body to the viewport; the todo section is
  dropped first, then the tail, and the footer hint always survives.
- Activity detail is capped at 45% of the row; the whole line is truncated to
  the terminal width with ANSI-aware width accounting.
- The composer grows with the draft up to seven rows and scrolls its internal
  window to keep the caret visible.
- The launch list keeps at least one session row and never scrolls the
  terminal itself.

## Non-goals (V1)

- mouse support, image protocols, pixel rendering, splash art;
- true session rewind/fork (not in protocol v2);
- multiple simultaneous live transcripts (one active session; others polled).
