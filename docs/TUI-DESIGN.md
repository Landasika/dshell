# TUI design

`dshell` is a terminal frontend over a live DSH Host. The TUI follows three
rules:

1. **Terminal-native.** Every screen is plain ANSI text; no images, no mouse
   requirement, no alternate widget toolkit. It works over SSH and in a 24-row
   terminal.
2. **One truth.** The durable session log is the only source. Metrics are
   projections of `SessionView.events`; the TUI never keeps a second counter
   that can drift from the Host.
3. **Responsive by dropping optional fields.** The usage rail drops cache,
   model, gauge and TPS before it drops totals or cost. The launch picker and
   the composer are never clipped to make room for decoration.

## Screen regions

```
┌ header ────────────────────────────────────────────────────────────────┐
│ ◆ dshell · title                       ● status · cwd                  │
├ rule ──────────────────────────────────────────────────────────────────┤
│ transcript (markdown, reasoning, tool cards, diffs, approvals)         │
│                                                                        │
├ activity (only while a turn runs) ─────────────────────────────────────┤
│ ⠹ Running command · detail · 12s · ctx 84%                             │
├ todo strip (only when todos exist) ────────────────────────────────────┤
│ ▸ 1/3 · current task                                      ctrl+t hide  │
├ composer ──────────────────────────────────────────────────────────────┤
│ ╭─ prompt ────────────────────────────────────────────────────────────╮ │
│ │ ❯ draft                                                            │ │
│ ╰─ enter send · / commands · @ files · ctrl+r history · ? help ───────╯ │
├ usage rail ────────────────────────────────────────────────────────────┤
│ ↑12.4k  cache 3k  ↓840  ~¥0.42  model      ctx ███░░░░░ 25% · 42 tps  │
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

- Usage-rail fields drop in this order: cache (76) → context gauge (72) →
  TPS (64) → model (92). Input, output and cost never drop.
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
