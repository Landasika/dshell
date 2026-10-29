/** Live work line, speed gauge and todo strip. */
import type { Activity, TodoItem, TpsSample } from './metrics.js'
import { formatDuration, formatPercent, formatTokens, pressureStyle, todoCounts } from './metrics.js'
import { formatCostCny } from './cost.js'
import { paint, type Theme, type ThemeStyle } from './theme.js'
import { displayWidth, pad, truncate } from './width.js'

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function spinnerFrame(now: number, intervalMs = 90): string {
  const index = Math.floor(now / intervalMs) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? '·'
}

export function activityColor(activity: Activity): ThemeStyle {
  switch (activity.phase) {
    case 'approval':
      return 'warning'
    case 'tool':
      return 'accentSoft'
    case 'streaming':
    case 'thinking':
      return 'accent'
    case 'done':
      return 'success'
    default:
      return 'muted'
  }
}

/**
 * One-line live activity readout:
 * `⠹ Running command · echo hi · 12s · ctx 84%`.
 * The context-pressure prefix only appears from 80% occupancy.
 */
export function renderActivityLine(
  theme: Theme,
  activity: Activity,
  options: { now: number; elapsedMs?: number; contextPct?: number; width: number },
): string {
  const { now, elapsedMs, contextPct, width } = options
  const parts: string[] = []
  const working = activity.phase !== 'done' && activity.phase !== 'idle'
  let marker: string
  if (working) marker = paint(theme, activityColor(activity), spinnerFrame(now))
  else if (activity.phase === 'done') marker = paint(theme, 'success', '✓')
  else marker = paint(theme, 'muted', '·')

  parts.push(paint(theme, activity.phase === 'approval' ? 'warning' : 'text', activity.verb))
  if (activity.detail !== undefined && activity.detail.trim().length > 0) {
    const detailWidth = Math.max(8, Math.min(48, Math.floor(width * 0.45)))
    parts.push(paint(theme, 'muted', truncate(activity.detail.replace(/\s+/g, ' ').trim(), detailWidth)))
  }
  if (working && elapsedMs !== undefined && elapsedMs > 0) {
    parts.push(paint(theme, 'muted', formatDuration(elapsedMs)))
  }
  if (contextPct !== undefined && contextPct >= 80) {
    const style = pressureStyle(contextPct) ?? 'warning'
    parts.push(paint(theme, style, `ctx ${formatPercent(contextPct)}`))
  }
  return truncate(`${marker} ${parts.join(paint(theme, 'muted', ' · '))}`, Math.max(1, width))
}

const GAUGE_LEN = 8
const GAUGE_FLOOR = 40
const HBLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const TRACK = '░'
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

function speedStyle(tps: number): ThemeStyle {
  if (tps >= 50) return 'success'
  if (tps >= 15) return 'accent'
  return 'muted'
}

/** `▕█████░░░▏` — an 8-cell gauge scaled against the session peak. */
export function renderTpsGauge(theme: Theme, tps: number, peak: number): string {
  const scale = Math.max(peak, GAUGE_FLOOR)
  const fraction = Math.min(1, Math.max(0, scale > 0 ? tps / scale : 0))
  const eighths = Math.round(fraction * GAUGE_LEN * 8)
  const full = Math.floor(eighths / 8)
  const remainder = eighths % 8
  let fill = '█'.repeat(full)
  if (full < GAUGE_LEN && remainder > 0) fill += HBLOCKS[remainder] ?? ''
  const track = TRACK.repeat(Math.max(0, GAUGE_LEN - displayWidth(fill)))
  const color = speedStyle(tps)
  return `${paint(theme, 'muted', '▕')}${paint(theme, color, fill)}${paint(theme, 'muted', track)}${paint(theme, 'muted', '▏')}`
}

/** Min-max normalized 12-sample sparkline. */
export function renderTpsSparkline(theme: Theme, samples: readonly TpsSample[]): string {
  const values = samples.slice(-12).map((sample) => sample.tps)
  if (values.length === 0) return paint(theme, 'muted', TRACK.repeat(12))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  return values
    .map((value) => {
      const norm = range < 0.000001 ? (max > 0 ? 4 : 0) : Math.round(((value - min) / range) * 7)
      return paint(theme, speedStyle(value), SPARK[Math.max(0, Math.min(7, norm))] ?? '▁')
    })
    .join('')
}

/** Footer strip: `☐ 1/5 · ▸ current task · ctrl+t hide`. */
export function renderTodoStrip(
  theme: Theme,
  todos: readonly TodoItem[],
  options: { width: number; now: number; folded: boolean },
): string {
  if (todos.length === 0) return ''
  const counts = todoCounts(todos)
  const marker = counts.active === undefined ? '☐' : '▸'
  const label = counts.active?.activeForm ?? counts.active?.content
  const summary = `${marker} ${counts.completed}/${counts.total}`
  const right = paint(theme, 'muted', options.folded ? 'ctrl+t show' : 'ctrl+t hide')
  const fixed = displayWidth(summary) + displayWidth('ctrl+t hide') + 5
  const body = label === undefined
    ? paint(theme, 'muted', 'todos')
    : paint(theme, counts.active === undefined ? 'muted' : 'text', truncate(label, Math.max(6, options.width - fixed)))
  return `${summary}${paint(theme, 'muted', ' · ')}${body}${' '.repeat(Math.max(1, options.width - displayWidth(summary) - displayWidth(body) - displayWidth(right) - 4))}${right}`
}

/** Boxed dashboard list of todos with status glyphs. */
export function renderTodoList(theme: Theme, todos: readonly TodoItem[], width: number): string[] {
  if (todos.length === 0) return [paint(theme, 'muted', 'no todos for this session')]
  return todos.map((todo) => {
    const mark = todo.status === 'completed'
      ? paint(theme, 'success', '✓')
      : todo.status === 'in_progress'
        ? paint(theme, 'accent', '▸')
        : paint(theme, 'muted', '○')
    const text = todo.status === 'in_progress' ? todo.activeForm ?? todo.content : todo.content
    const style: ThemeStyle = todo.status === 'completed' ? 'muted' : todo.status === 'in_progress' ? 'text' : 'muted'
    return `${mark} ${paint(theme, style, truncate(text, Math.max(4, width - 2)))}`
  })
}

export interface StatusStripInput {
  agentsDone: number
  agentsTotal: number
  agentsRunning: number
  jobsRunning: number
  jobsFailed: number
  jobsTotal: number
  todosDone: number
  todosTotal: number
  width: number
}

/**
 * Claude-Code-style status strip above the composer: settled agent count,
 * running background jobs and todo progress. Renders nothing when the session
 * has none of them, so idle sessions keep their two-line footer.
 */
export function renderStatusStrip(theme: Theme, input: StatusStripInput): string {
  const segments: string[] = []
  if (input.agentsTotal > 0) {
    const settled = input.agentsRunning === 0
    const glyph = settled && input.agentsDone === input.agentsTotal ? '✓' : '●'
    const style: ThemeStyle = settled ? 'success' : 'info'
    segments.push(`${paint(theme, style, glyph)} ${paint(theme, 'muted', `agents ${input.agentsDone}/${input.agentsTotal}`)}`)
  }
  if (input.jobsRunning > 0) {
    const failed = input.jobsFailed > 0 ? paint(theme, 'error', ` · ✗ ${input.jobsFailed} failed`) : ''
    segments.push(`${paint(theme, 'info', '●')} ${paint(theme, 'muted', 'jobs')} ${paint(theme, 'text', String(input.jobsRunning))}${failed}`)
  } else if (input.jobsFailed > 0) {
    // Nothing is running: counting "0" would read as "0 failed".
    const label = input.jobsFailed === 1 ? 'job failed' : 'jobs failed'
    segments.push(`${paint(theme, 'error', '✗')} ${paint(theme, 'error', `${String(input.jobsFailed)} ${label}`)}`)
  }
  if (input.todosTotal > 0) {
    const done = input.todosDone === input.todosTotal
    const glyph = done ? '✓' : '●'
    const style: ThemeStyle = done ? 'success' : input.todosDone > 0 ? 'info' : 'muted'
    segments.push(`${paint(theme, style, glyph)} ${paint(theme, 'muted', `todo ${input.todosDone}/${input.todosTotal}`)}`)
  }
  if (segments.length === 0) return ''
  const line = segments.join('  ')
  return displayWidth(line) <= input.width ? line : truncate(line, input.width)
}

/** Compact status chip used by the header. */
export function splitLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right))
  return `${left}${' '.repeat(gap)}${right}`
}

export interface UsageRailInput {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost?: number
  model?: string
  provider?: string
  /** Reasoning level currently selected for the model, when it has levels. */
  effort?: string
  cwd?: string
  git?: { branch: string; ahead: number; behind: number; dirty: boolean }
  agents?: { done: number; total: number; running: number; failed?: number }
  width: number
}

function truncateLeft(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of Array.from(text).reverse()) {
    const cells = displayWidth(char)
    if (used + cells + 1 > width) break
    out = char + out
    used += cells
  }
  return `…${out}`
}

/** `~/dshell` instead of `/home/name/dshell`, with a left-truncated fallback. */
export function shortCwd(cwd: string, width = 28): string {
  const home = process.env.HOME
  const tildified = home !== undefined && (cwd === home || cwd.startsWith(`${home}/`))
    ? `~${cwd.slice(home.length)}`
    : cwd
  return truncateLeft(tildified, width)
}

export function blockBar(theme: Theme, pct: number, cells: number, style: ThemeStyle): string {
  const bounded = Math.max(0, Math.min(100, pct))
  const filled = Math.min(cells, Math.max(0, Math.round((bounded / 100) * cells)))
  return `${paint(theme, style, '▰'.repeat(filled))}${paint(theme, 'muted', '▱'.repeat(cells - filled))}`
}

/**
 * The bottom-most line under the composer: model route, workspace, git
 * breadcrumb, agent count, cache hit rate and context pressure, followed by
 * token totals, spend and TPS when the terminal is wide enough. Segments drop
 * from the least important end instead of wrapping.
 */
export function renderUsageRail(theme: Theme, input: UsageRailInput): string {
  const width = Math.max(20, input.width)
  const segments: { text: string; drop: number; compact?: string }[] = []
  const model = input.model === undefined
    ? undefined
    : input.provider === undefined
      ? input.model
      : `${input.provider}/${input.model}`
  if (model !== undefined && model.length > 0) {
    const text = paint(theme, 'accentSoft', truncate(model, 40))
    const level = input.effort === undefined || input.effort.length === 0
      ? ''
      : paint(theme, 'muted', ` · ${input.effort}`)
    segments.push({ text: `${text}${level}`, drop: 0 })
  }
  if (input.cwd !== undefined && input.cwd.length > 0) {
    segments.push({ text: paint(theme, 'muted', shortCwd(input.cwd)), drop: 6 })
  }
  if (input.git !== undefined) {
    const git = input.git
    const ahead = git.ahead > 0 ? ` ↑${git.ahead}` : ''
    const behind = git.behind > 0 ? ` ↓${git.behind}` : ''
    const marks = ahead.length + behind.length > 0 ? paint(theme, 'muted', ` [${`${ahead}${behind}`.trim()}]`) : ''
    segments.push({
      text: `${paint(theme, 'text', `${git.branch}${git.dirty ? '*' : ''}`)}${marks}`,
      drop: 5,
    })
  }
  if (input.agents !== undefined && input.agents.total > 0) {
    const agents = input.agents
    const failed = agents.failed ?? 0
    const settled = agents.running === 0
    const glyph = failed > 0 ? '✗' : settled ? '✓' : '●'
    const style: ThemeStyle = failed > 0 ? 'error' : settled ? 'success' : 'info'
    const detail = failed > 0 ? ` · ✗ ${failed}` : ''
    const base = `${paint(theme, style, glyph)} ${paint(theme, 'muted', `agents ${agents.done}/${agents.total}`)}`
    segments.push({
      text: `${base}${paint(theme, 'error', detail)}`,
      drop: 4,
      ...(detail.length === 0 ? {} : { compact: base }),
    })
  }
  const cacheTotal = input.tokens.cacheRead
  const cacheBase = cacheTotal + input.tokens.input
  if (cacheTotal > 0 && cacheBase > 0) {
    const pct = (cacheTotal / cacheBase) * 100
    const label = `${paint(theme, 'muted', 'cache')} ${paint(theme, 'info', formatPercent(pct))}`
    const bar = width >= 96 ? `${blockBar(theme, pct, 5, 'info')} ` : ''
    segments.push({
      text: `${paint(theme, 'muted', 'cache')} ${bar}${paint(theme, 'info', formatPercent(pct))}`,
      drop: 3,
      ...(bar.length === 0 ? {} : { compact: label }),
    })
  }
  if (input.tokens.input > 0 || input.tokens.output > 0) {
    segments.push({
      text: `${paint(theme, 'muted', '↑')}${paint(theme, 'text', formatTokens(input.tokens.input))} ${paint(theme, 'muted', '↓')}${paint(theme, 'text', formatTokens(input.tokens.output))}`,
      drop: 7,
    })
  }
  if (input.cost !== undefined && input.cost > 0) {
    segments.push({ text: paint(theme, 'warning', `~${formatCostCny(input.cost)}`), drop: 8 })
  }

  const join = (): string => segments.map((segment) => segment.text).join(paint(theme, 'muted', '  '))
  while (displayWidth(join()) > width) {
    let candidate = -1
    let rank = 0
    for (const [index, segment] of segments.entries()) {
      if (segment.drop > rank && segment.drop > 0) {
        rank = segment.drop
        candidate = index
      }
    }
    // Token totals / spend go first; the cache bar collapses to a percentage
    // only after those, and cwd, git, agents and cache are dropped last.
    if (candidate >= 0 && rank >= 7) {
      segments.splice(candidate, 1)
      if (segments.length === 0) break
      continue
    }
    const degradable = segments.findIndex((segment) => segment.compact !== undefined && segment.text !== segment.compact)
    if (degradable >= 0) {
      const segment = segments[degradable]
      if (segment?.compact !== undefined) segment.text = segment.compact
      continue
    }
    if (candidate < 0) break
    segments.splice(candidate, 1)
    if (segments.length === 0) break
  }
  if (segments.length === 0) return pad('', width)
  return pad(truncate(join(), width), width)
}
