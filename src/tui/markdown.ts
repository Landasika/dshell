import { paint, type Theme } from './theme.js'
import { displayWidth, pad, sanitizeText, truncate, wrapText } from './width.js'

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Remove the inline markers that would otherwise show up inside a cell. */
function cleanCell(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![\w])__([^_]+)__(?![\w./])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .trim()
}

/** Split one markdown table row into trimmed cells, honouring `\\|`. */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|'
      index += 1
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function alignCell(text: string, size: number, align: 'left' | 'center' | 'right'): string {
  if (align !== 'center') return pad(text, size, align)
  const room = Math.max(0, size - displayWidth(text))
  const left = Math.floor(room / 2)
  return `${' '.repeat(left)}${text}${' '.repeat(room - left)}`
}

function tableAlignments(separator: string, count: number): ('left' | 'center' | 'right')[] {
  const cells = tableCells(separator)
  return Array.from({ length: count }, (_, index) => {
    const cell = cells[index] ?? ''
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * Try to render a markdown table that starts at `start`. The caller has
 * already skipped code fences, so pipes there stay literal. Returns the rows
 * and the index of the last consumed line, or null when this is not a table.
 */
function tryTable(
  raw: readonly string[],
  start: number,
  width: number,
  theme: Theme,
): { lines: string[]; end: number } | null {
  const header = raw[start] ?? ''
  const separator = raw[start + 1] ?? ''
  if (!header.includes('|') || !TABLE_SEPARATOR.test(separator) || !separator.includes('-')) return null
  if (width < 12) return null

  const head = tableCells(header)
  if (head.length < 2) return null
  const rows: string[][] = []
  let end = start + 1
  for (let index = start + 2; index < raw.length; index += 1) {
    const line = raw[index] ?? ''
    if (!line.includes('|') || line.trim().length === 0) break
    if (TABLE_SEPARATOR.test(line)) break
    rows.push(tableCells(line))
    end = index
  }

  const columnCount = head.length
  const aligns = tableAlignments(separator, columnCount)
  const cellsOf = (row: readonly string[]): string[] =>
    Array.from({ length: columnCount }, (_, index) => cleanCell(row[index] ?? ''))
  const body = rows.map(cellsOf)

  // Natural width per column, then shrink the widest ones until the table fits.
  const widths = head.map((cell, index) => {
    const values = [cleanCell(cell), ...body.map((row) => row[index] ?? '')]
    return Math.max(3, ...values.map((value) => displayWidth(value)))
  })
  // Each column contributes two padding cells and the table has one border
  // per column plus the outer pair.
  const chrome = 3 * columnCount + 1
  const available = Math.max(columnCount * 3, width - chrome)
  let excess = widths.reduce((sum, value) => sum + value, 0) - available
  while (excess > 0) {
    let widest = 0
    for (let index = 1; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > (widths[widest] ?? 0)) widest = index
    }
    if ((widths[widest] ?? 0) <= 3) break
    widths[widest] = (widths[widest] ?? 0) - 1
    excess -= 1
  }

  const border = (left: string, middle: string, right: string): string =>
    paint(theme, 'gray', `${left}${widths.map((size) => '─'.repeat(size + 2)).join(middle)}${right}`)
  const renderRow = (row: readonly string[], bold: boolean): string[] => {
    const wrapped = row.map((value, index) =>
      wrapText(value, Math.max(1, widths[index] ?? 3)),
    )
    const height = Math.max(1, ...wrapped.map((parts) => parts.length))
    const rendered: string[] = []
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map((parts, index) => {
        const cell = alignCell(parts[line] ?? '', widths[index] ?? 3, aligns[index] ?? 'left')
        return bold ? paint(theme, 'bold', cell) : cell
      })
      rendered.push(`${paint(theme, 'gray', '│')} ${parts.join(` ${paint(theme, 'gray', '│')} `)} ${paint(theme, 'gray', '│')}`)
    }
    return rendered
  }

  const lines: string[] = [border('┌', '┬', '┐')]
  lines.push(...renderRow(head.map(cleanCell), true))
  lines.push(border('├', '┼', '┤'))
  for (const [index, row] of body.entries()) {
    // A rule between body rows too: a wrapped cell spans several lines, and
    // without it two records run together.
    if (index > 0) lines.push(border('├', '┼', '┤'))
    lines.push(...renderRow(row, false))
  }
  lines.push(border('└', '┴', '┘'))
  return { lines, end }
}

function isDiff(text: string): boolean {
  return /^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m.test(text)
}

/** Render a markdown-ish assistant/user message into terminal lines. */
export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  const safe = sanitizeText(text)
  if (safe.trim().length === 0) return []
  if (isDiff(safe)) return renderDiff(safe, width, theme)

  const lines: string[] = []
  let inFence = false
  let fenceLanguage = ''
  const source = safe.split('\n')

  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index] ?? ''
    const line = raw.replace(/\s+$/, '')
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence !== null) {
      inFence = !inFence
      fenceLanguage = fence[1]?.trim() ?? ''
      if (inFence && fenceLanguage.length > 0) {
        lines.push(paint(theme, 'gray', `  ${truncate(fenceLanguage, Math.max(1, width - 2))}`))
      }
      continue
    }

    if (inFence) {
      if (line.length === 0) {
        lines.push(paint(theme, 'gray', `  │`))
      } else {
        lines.push(paint(theme, 'gray', `  │ ${truncate(line, Math.max(1, width - 4))}`))
      }
      continue
    }

    if (line.trim().length === 0) {
      lines.push('')
      continue
    }

    const table = tryTable(source, index, width, theme)
    if (table !== null) {
      lines.push(...table.lines)
      index = table.end
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const title = heading[2] ?? ''
      const style = heading[1]?.length === 1 ? 'bold' : 'cyan'
      lines.push(paint(theme, style, truncate(title, width)))
      continue
    }

    const rule = /^\s*([-*_])\1{2,}\s*$/.test(line)
    if (rule) {
      lines.push(paint(theme, 'gray', '─'.repeat(Math.max(1, width))))
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const indent = Math.min(6, bullet[1]?.length ?? 0)
      const prefix = `${' '.repeat(indent)}• `
      const body = wrapText(bullet[2] ?? '', Math.max(1, width - indent - 2))
      lines.push(`${prefix}${body[0] ?? ''}`)
      for (const continuation of body.slice(1)) {
        lines.push(`${' '.repeat(indent + 2)}${continuation}`)
      }
      continue
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (numbered !== null) {
      const indent = Math.min(6, numbered[1]?.length ?? 0)
      const marker = `${numbered[2]}. `
      const body = wrapText(numbered[3] ?? '', Math.max(1, width - indent - marker.length))
      lines.push(`${' '.repeat(indent)}${paint(theme, 'bold', marker)}${body[0] ?? ''}`)
      for (const continuation of body.slice(1)) {
        lines.push(`${' '.repeat(indent + marker.length)}${continuation}`)
      }
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      for (const part of wrapText(quote[1] ?? '', Math.max(1, width - 2))) {
        lines.push(paint(theme, 'gray', `│ ${part}`))
      }
      continue
    }

    // Keep inline markup simple and predictable: remove the markers that
    // would otherwise look like noise, style the whole line where useful.
    const cleaned = line
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      // Intraword dunders are identifiers (`__init__.py`), not emphasis.
      .replace(/(?<![\w])__([^_]+)__(?![\w./])/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    for (const part of wrapText(cleaned, width)) lines.push(part)
  }

  return lines
}

/** Render a unified diff with line-level colors. */
export function renderDiff(text: string, width: number, theme: Theme): string[] {
  const lines: string[] = []
  for (const raw of sanitizeText(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('@@')) {
      lines.push(paint(theme, 'cyan', truncate(line, width)))
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      lines.push(paint(theme, 'bold', truncate(line, width)))
    } else if (line.startsWith('+')) {
      lines.push(paint(theme, 'green', truncate(line, width)))
    } else if (line.startsWith('-')) {
      lines.push(paint(theme, 'red', truncate(line, width)))
    } else if (line.startsWith('diff --git')) {
      lines.push(paint(theme, 'bold', truncate(line, width)))
    } else {
      lines.push(truncate(line, width))
    }
  }
  return lines
}
