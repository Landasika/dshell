/**
 * Segmented context-progress bar.
 *
 * The measured occupancy fixes where the used part ends; local estimates only
 * divide that span between system / prompt / assistant / thinking / tools.
 * Used segments are coloured blocks with no letters (the colours are the
 * signal), and the free part carries the right-aligned `13k/64k 19.5%`
 * readout. This is the ANSI twin of the reference TUI's context bar.
 */
import type { ContextSegments } from './metrics.js'
import { formatPercent, formatTokens, pressureStyle } from './metrics.js'
import { paint, type Theme, type ThemeStyle } from './theme.js'
import { displayWidth } from './width.js'

export interface SegmentSpec {
  key: keyof ContextSegments
  label: string
  style: ThemeStyle
}

export const CONTEXT_SEGMENTS: readonly SegmentSpec[] = [
  { key: 'system', label: 'system', style: 'contextSystem' },
  { key: 'prompt', label: 'prompt', style: 'contextPrompt' },
  { key: 'assistant', label: 'assistant', style: 'contextAssistant' },
  { key: 'thinking', label: 'thinking', style: 'contextThinking' },
  { key: 'tools', label: 'tools', style: 'contextTools' },
]

/** Largest-remainder allocation of `width` cells across `values`. */
export function allocateColumns(values: readonly number[], width: number): number[] {
  const cells = Math.max(0, Math.floor(width))
  const out = values.map(() => 0)
  const visible = values.map((value, index) => ({ value, index })).filter((item) => item.value > 0)
  if (cells === 0 || visible.length === 0) return out
  if (cells < visible.length) {
    // Too narrow to give every segment one cell; fall back to pure proportion.
    return largestRemainder(
      values.map((value) => (value > 0 ? value : 0)),
      cells,
    )
  }
  for (const item of visible) out[item.index] = 1
  const extra = largestRemainder(
    values.map((value) => (value > 0 ? value : 0)),
    cells - visible.length,
  )
  return out.map((value, index) => value + (extra[index] ?? 0))
}

function largestRemainder(weights: readonly number[], width: number): number[] {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0)
  const cells = Math.max(0, Math.floor(width))
  if (total <= 0 || cells === 0) return weights.map(() => 0)
  const exact = weights.map((value) => (Math.max(0, value) / total) * cells)
  const floors = exact.map((value) => Math.floor(value))
  let remaining = cells - floors.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction)
  for (const item of order) {
    if (remaining <= 0) break
    floors[item.index] = (floors[item.index] ?? 0) + 1
    remaining -= 1
  }
  return floors
}

export interface ContextBarLayout {
  used: number[]
  unclassified: number
  free: number
}

/** Occupancy fixes the boundary; estimates only split the used span. */
export function contextBarLayout(
  segments: ContextSegments | undefined,
  usedTokens: number,
  contextWindow: number,
  width: number,
): ContextBarLayout {
  const cells = Math.max(0, Math.floor(width))
  const ratio = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0
  const usedWidth = Math.round(cells * ratio)
  if (segments === undefined) {
    return { used: [0, 0, 0, 0, 0], unclassified: usedWidth, free: cells - usedWidth }
  }
  const values = CONTEXT_SEGMENTS.map((segment) => segments[segment.key])
  const used = allocateColumns(values, usedWidth)
  const allocated = used.reduce((sum, value) => sum + value, 0)
  return { used, unclassified: Math.max(0, usedWidth - allocated), free: Math.max(0, cells - usedWidth) }
}

/** Text options for the free-segment readout, widest first. */
export function contextReadoutOptions(usedTokens: number, contextWindow: number): string[] {
  if (contextWindow <= 0) return []
  const percent = formatPercent((usedTokens / contextWindow) * 100)
  return [
    `${formatTokens(usedTokens)}/${formatTokens(contextWindow)} ${percent}`,
    percent,
  ]
}

/**
 * One full-width context bar. Returns an empty string when there is no usable
 * window, so callers can fall back to a plain token line.
 */
export function renderContextBar(
  theme: Theme,
  segments: ContextSegments | undefined,
  usedTokens: number,
  contextWindow: number,
  width: number,
): string {
  if (width <= 0 || contextWindow <= 0) return ''
  const layout = contextBarLayout(segments, usedTokens, contextWindow, width)
  const pct = (usedTokens / contextWindow) * 100
  const style: ThemeStyle = pressureStyle(pct) ?? 'success'
  let used = ''
  for (const [index, spec] of CONTEXT_SEGMENTS.entries()) {
    const count = layout.used[index] ?? 0
    if (count <= 0) continue
    used += paint(theme, spec.style, '█'.repeat(count))
  }
  if (layout.unclassified > 0) used += paint(theme, 'contextAssistant', '█'.repeat(layout.unclassified))
  if (layout.free <= 0) return used

  const options = contextReadoutOptions(usedTokens, contextWindow)
  const chosen = options.find((option) => displayWidth(option) + 1 <= layout.free)
  if (chosen === undefined) return used + paint(theme, 'muted', '░'.repeat(layout.free))
  const gap = layout.free - displayWidth(chosen)
  return `${used}${paint(theme, 'muted', '░'.repeat(gap))}${paint(theme, style, chosen)}`
}

/** Named breakdown for the dashboard / hover replacement row. */
/**
 * Tiny inline occupancy gauge for the bottom usage rail:
 * `█████░░░`. Colour carries pressure, the readout next to it carries the
 * percentage, so the bar needs no legend.
 */
export function renderMiniContextBar(theme: Theme, pct: number | undefined, width = 8): string {
  const cells = Math.max(3, Math.floor(width))
  if (pct === undefined || !Number.isFinite(pct)) return paint(theme, 'muted', '░'.repeat(cells))
  const bounded = Math.max(0, Math.min(100, pct))
  const filled = Math.min(cells, Math.max(0, Math.round((bounded / 100) * cells)))
  const style = pressureStyle(bounded) ?? 'success'
  return `${paint(theme, style, '█'.repeat(filled))}${paint(theme, 'muted', '░'.repeat(cells - filled))}`
}

/**
 * Two-row composition legend for the session panel. The full five-row legend
 * does not fit beside the usage/cost block on a 30-row terminal.
 */
export function renderContextLegendCompact(
  theme: Theme,
  segments: ContextSegments | undefined,
  usedTokens: number,
  width: number,
): string[] {
  if (segments === undefined) return []
  const total = Math.max(1, usedTokens)
  const items = CONTEXT_SEGMENTS.map((spec) => {
    const tokens = segments[spec.key]
    const share = Math.round((tokens / total) * 100)
    return `${paint(theme, spec.style, '█')} ${paint(theme, 'muted', spec.label)} ${paint(theme, 'text', formatTokens(tokens))} ${paint(theme, 'muted', `(${share}%)`)}`
  })
  const lines: string[] = []
  let current = ''
  for (const item of items) {
    const next = current.length === 0 ? item : `${current} · ${item}`
    if (displayWidth(next) > width && current.length > 0) {
      lines.push(current)
      current = item
    } else {
      current = next
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}
