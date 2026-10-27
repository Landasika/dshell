/** Shared terminal chrome: panels, header, composer frame and hint rows. */
import type { EditorState } from './editor.js'
import { composerLines } from './editor.js'
import { paint, type Theme, type ThemeStyle } from './theme.js'
import { displayWidth, pad, truncate } from './width.js'

export interface BoxOptions {
  tone?: ThemeStyle
  /** Rows appended inside the box, separated from the body by a blank line. */
  footer?: readonly string[]
}

/** Rounded panel with an inline title. `width` includes both borders. */
export function panelBox(
  theme: Theme,
  title: string,
  body: readonly string[],
  width: number,
  options: BoxOptions = {},
): string[] {
  const total = Math.max(16, Math.floor(width))
  const inner = total - 4
  const tone: ThemeStyle = options.tone ?? 'border'
  const safeTitle = truncate(title, Math.max(1, inner - 2))
  const titleWidth = displayWidth(safeTitle)
  const top = `${paint(theme, tone, '╭─')} ${paint(theme, 'accentSoft', safeTitle)} ${paint(theme, tone, '─'.repeat(Math.max(0, total - titleWidth - 5)))}${paint(theme, tone, '╮')}`
  const content = body.map((line) => `${paint(theme, tone, '│')} ${pad(line, inner)} ${paint(theme, tone, '│')}`)
  if (options.footer !== undefined && options.footer.length > 0) {
    content.push(`${paint(theme, tone, '│')} ${' '.repeat(inner)} ${paint(theme, tone, '│')}`)
    for (const line of options.footer) {
      content.push(`${paint(theme, tone, '│')} ${pad(line, inner)} ${paint(theme, tone, '│')}`)
    }
  }
  const bottom = paint(theme, tone, `╰${'─'.repeat(total - 2)}╯`)
  return [top, ...content, bottom]
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
  const left = `${paint(theme, 'bold', paint(theme, 'accent', '◆ dshell'))} ${paint(theme, 'muted', '·')} ${paint(theme, 'bold', truncate(options.title, 42))}`
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

/**
 * Prompt composer inside a rounded frame:
 *
 *     ╭─ prompt ───────────────────────────╮
 *     │ ❯ write a message                  │
 *     ╰────────────────────────────────────╯
 */
export function renderComposer(
  theme: Theme,
  editor: EditorState,
  columns: number,
  maxLines = 7,
  hint?: string,
): ComposerFrame {
  const total = Math.max(20, columns)
  const textWidth = Math.max(4, total - 6)
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
  const border = paint(theme, 'border', '│')
  const marker = (index: number): string => {
    if (offset > 0 && index === 0) return paint(theme, 'muted', '↳ ')
    if (offset + index === 0) return paint(theme, 'accent', '❯ ')
    return '  '
  }
  const body = visible.map((line, index) => `${border} ${marker(index)}${pad(line, textWidth)} ${border}`)
  const label = ' prompt '
  const title = paint(theme, 'bold', paint(theme, 'accentSoft', label.trim()))
  const top = `${paint(theme, 'border', '╭─')} ${title} ${paint(theme, 'border', '─'.repeat(Math.max(0, total - displayWidth(label) - 3)))}${paint(theme, 'border', '╮')}`
  const bottom = hint === undefined || hint.trim().length === 0
    ? paint(theme, 'border', `╰${'─'.repeat(total - 2)}╯`)
    : (() => {
        const label = truncate(hint, Math.max(4, total - 7))
        const gap = Math.max(1, total - 5 - displayWidth(label))
        return `${paint(theme, 'border', '╰─')} ${label} ${paint(theme, 'border', `${'─'.repeat(gap)}╯`)}`
      })()
  const lines = [top, ...body, bottom]
  const cursorRow = 1 + Math.max(0, visualLine - offset)
  const cursorColumn = Math.min(total - 1, Math.max(5, 5 + visualColumn))
  return { lines, cursorRow, cursorColumn, height: lines.length }
}

/** Width-aware shortcut hint row. */
export function renderHintLine(theme: Theme, columns: number): string {
  const text = columns >= 112
    ? 'enter send · alt+enter newline · / commands · @ files · ctrl+r history · ctrl+b panel · ? help'
    : columns >= 84
      ? 'enter send · / commands · @ files · ctrl+r history · ? help'
      : 'enter send · / commands · ? help'
  return paint(theme, 'muted', truncate(text, columns))
}

/** Center a block horizontally inside `columns`. */
export function centerBlock(lines: readonly string[], columns: number): string[] {
  return lines.map((line) => {
    const left = Math.max(0, Math.floor((columns - displayWidth(line)) / 2))
    return `${' '.repeat(left)}${line}`
  })
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
