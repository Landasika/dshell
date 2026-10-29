/** Shared terminal chrome: panels, header, composer frame and hint rows. */
import { blockBar } from './activity.js'
import { BRAND_ICON, BRAND_NAME } from './brand.js'
import type { EditorState } from './editor.js'
import { composerLines } from './editor.js'
import { formatPercent, pressureStyle } from './metrics.js'
import { paint, type Theme, type ThemeStyle } from './theme.js'
import { displayWidth, pad, truncate } from './width.js'

export interface PanelOptions {
  tone?: ThemeStyle
  /** Rows appended under the body, separated from it by a blank line. */
  footer?: readonly string[]
}

/**
 * The one panel used by every overlay: a title, a horizontal rule, the body.
 *
 * A boxed panel is nice to look at but painful to copy from: a drag selection
 * picks up the `│` on both edges of every row, so pasting into a prompt or an
 * issue drags the frame along. Every secondary page (`/model`, tool and
 * subagent viewers opened with Alt+↑, pickers, approvals) is therefore framed
 * by rules only — chrome is horizontal, the rows stay plain text.
 */
export function panelRule(
  theme: Theme,
  title: string,
  body: readonly string[],
  width: number,
  options: PanelOptions = {},
): string[] {
  const total = Math.max(16, Math.floor(width))
  const tone: ThemeStyle = options.tone ?? 'border'
  const heading = options.tone === undefined
    ? paint(theme, 'bold', paint(theme, 'accentSoft', truncate(title, total)))
    : paint(theme, 'bold', paint(theme, tone, truncate(title, total)))
  const lines = [
    heading,
    paint(theme, tone, '─'.repeat(total)),
    ...body.map((line) => (displayWidth(line) > total ? truncate(line, total) : line)),
  ]
  if (options.footer !== undefined && options.footer.length > 0) {
    lines.push('')
    for (const line of options.footer) {
      lines.push(displayWidth(line) > total ? truncate(line, total) : line)
    }
  }
  return lines
}

/** One-line application header with brand, session title and status. */
export function renderHeader(
  theme: Theme,
  options: {
    columns: number
    title: string
    cwd: string
    status: string
    statusStyle: ThemeStyle
    model?: string
  },
): string {
  const left = `${paint(theme, 'bold', paint(theme, 'accent', `${BRAND_ICON} ${BRAND_NAME}`))} ${paint(theme, 'muted', '·')} ${paint(theme, 'bold', truncate(options.title, 42))}`
  const model = options.model === undefined ? '' : ` ${paint(theme, 'muted', `[${truncate(options.model, 18)}]`)}`
  const right = `${paint(theme, options.statusStyle, `● ${options.status}`)} ${paint(theme, 'muted', '·')} ${paint(theme, 'muted', truncate(options.cwd, Math.max(8, options.columns - 52)))}`
  const gap = Math.max(1, options.columns - displayWidth(left) - displayWidth(model) - displayWidth(right))
  return `${left}${model}${' '.repeat(gap)}${right}`
}

export interface ComposerFrame {
  lines: string[]
  /** 0-based row inside `lines` where the terminal cursor belongs. */
  cursorRow: number
  /** 1-based absolute column. */
  cursorColumn: number
  height: number
}

export interface ComposerStatus {
  /** Measured context occupancy, 0-100. */
  contextPct?: number
  /** Live or last-turn token speed. */
  tps?: number
}

/**
 * Top rule of the composer. Context/TPS are right-aligned; rich variants are
 * tried first and fall back to a bare percentage, then to a plain rule, so the
 * line never wraps.
 */
function composerTop(theme: Theme, total: number, status: ComposerStatus | undefined): string {
  const ctxPct = status?.contextPct === undefined
    ? undefined
    : Math.max(0, Math.min(100, status.contextPct))
  const style: ThemeStyle = ctxPct === undefined ? 'muted' : pressureStyle(ctxPct) ?? 'muted'
  const tps = status?.tps !== undefined && status.tps > 0 ? status.tps : undefined
  const tpsText = tps === undefined ? undefined : `${tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)} tps`
  const ctxLabel = paint(theme, 'muted', 'ctx')
  const tpsLabel = tpsText === undefined ? undefined : paint(theme, 'muted', tpsText)
  const variants: { plain: string; painted: string }[] = []
  if (ctxPct !== undefined) {
    const pct = paint(theme, style, formatPercent(ctxPct))
    const plainPct = formatPercent(ctxPct)
    // A 10-cell bar is only worth its width once the terminal can afford it.
    if (total >= 32) {
      const bar = blockBar(theme, ctxPct, 10, style)
      if (tpsText !== undefined) {
        variants.push({
          plain: `ctx ${'▰'.repeat(10)} ${plainPct} · ${tpsText}`,
          painted: `${ctxLabel} ${bar} ${pct} ${paint(theme, 'muted', '·')} ${tpsLabel}`,
        })
      }
      variants.push({
        plain: `ctx ${'▰'.repeat(10)} ${plainPct}`,
        painted: `${ctxLabel} ${bar} ${pct}`,
      })
    }
    if (tpsText !== undefined) {
      variants.push({
        plain: `ctx ${plainPct} · ${tpsText}`,
        painted: `${ctxLabel} ${pct} ${paint(theme, 'muted', '·')} ${tpsLabel}`,
      })
    }
    variants.push({ plain: `ctx ${plainPct}`, painted: `${ctxLabel} ${pct}` })
  }
  if (tpsText !== undefined && tpsLabel !== undefined) {
    variants.push({ plain: tpsText, painted: tpsLabel })
  }
  for (const variant of variants) {
    const width = displayWidth(variant.plain)
    if (width > total - 2) continue
    const fill = Math.max(1, total - width - 1)
    return `${paint(theme, 'border', '─'.repeat(fill))} ${variant.painted}`
  }
  return paint(theme, 'border', '─'.repeat(total))
}

/**
 * Claude-Code-style composer: two horizontal rules with the `❯` input between
 * them, optional dim shortcut hint underneath.
 *
 *     ─────────────────── ctx ▰▰▰▰▱▱▱▱▱▱ 46% · 42 tps
 *     ❯ write a message
 *     ──────────────────────────────────────────────────
 *       enter send · / commands · ? help
 */
export function renderComposer(
  theme: Theme,
  editor: EditorState,
  columns: number,
  maxLines = 7,
  hint?: string,
  status?: ComposerStatus,
): ComposerFrame {
  const total = Math.max(20, columns)
  const gutter = 2
  const textWidth = Math.max(4, total - gutter)
  const all = composerLines(editor.text, textWidth)
  const before = composerLines(editor.text.slice(0, editor.cursor), textWidth)
  const visualLine = Math.max(0, before.length - 1)
  const visualColumn = displayWidth(before.at(-1) ?? '')
  const limit = Math.max(1, maxLines)
  const visibleCount = Math.min(limit, Math.max(1, all.length))
  const offset = all.length <= visibleCount
    ? 0
    : Math.max(0, Math.min(all.length - visibleCount, visualLine - visibleCount + 1))
  const visible: string[] = []
  for (let index = 0; index < visibleCount; index += 1) {
    visible.push(all[offset + index] ?? '')
  }
  const marker = (index: number): string => {
    if (offset > 0 && index === 0) return paint(theme, 'muted', '↳ ')
    if (offset + index === 0) return paint(theme, 'accent', '❯ ')
    return '  '
  }
  const body = visible.map((line, index) => `${marker(index)}${pad(line, textWidth)}`)
  const top = composerTop(theme, total, status)
  const rule = paint(theme, 'border', '─'.repeat(total))
  const lines = [top, ...body, rule]
  if (hint !== undefined && hint.trim().length > 0) {
    lines.push(pad(paint(theme, 'muted', truncate(`  ${hint}`, total)), total))
  }
  const cursorRow = 1 + Math.max(0, visualLine - offset)
  const cursorColumn = Math.min(total - 1, Math.max(3, 3 + visualColumn))
  return { lines, cursorRow, cursorColumn, height: lines.length }
}

/** Width-aware shortcut hint row. */
export function renderHintLine(theme: Theme, columns: number): string {
  const text = columns >= 112
    ? 'enter steer/send · alt+q queue · ctrl+enter newline · / commands · @ files · ctrl+r history · ? help'
    : columns >= 84
      ? 'enter steer/send · alt+q queue · / commands · @ files · ? help'
      : 'enter send · / commands · ? help'
  return paint(theme, 'muted', truncate(text, columns))
}

/**
 * Center a block horizontally inside `columns`, using the widest row so every
 * line starts at the same column. Centering each row by its own width would
 * ragged-edge a borderless panel; boxed panels are padded to one width, so
 * they are unaffected.
 */
export function centerBlock(lines: readonly string[], columns: number): string[] {
  const width = lines.reduce((widest, line) => Math.max(widest, displayWidth(line)), 0)
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)))
  return lines.map((line) => (line.length === 0 ? '' : `${indent}${line}`))
}

/** Vertically center a block inside `rows`, returning empty padding rows too. */
export function centerVertically(lines: readonly string[], rows: number): string[] {
  if (lines.length >= rows) return lines.slice(0, rows)
  const top = Math.max(0, Math.floor((rows - lines.length) / 2))
  const bottom = Math.max(0, rows - top - lines.length)
  return [
    ...Array.from({ length: top }, () => ''),
    ...lines,
    ...Array.from({ length: bottom }, () => ''),
  ]
}

/** Right-aligned "jump to bottom" pill shown while the transcript is scrolled up. */
export function renderJumpToBottom(theme: Theme, unseen: number, columns: number): string {
  const label = unseen > 0
    ? `${paint(theme, 'text', `${unseen} new`)} ${paint(theme, 'muted', '· End')}`
    : `${paint(theme, 'text', 'Jump to bottom')} ${paint(theme, 'muted', '· End')}`
  const styled = `${paint(theme, 'accent', '↓')} ${label}`
  const width = displayWidth(styled)
  if (width >= columns) return truncate(styled, columns)
  return `${' '.repeat(columns - width)}${styled}`
}
