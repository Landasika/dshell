/** Terminal text helpers: strip control sequences, measure display width, wrap. */

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI, '')
}

/**
 * Remove control characters that a tool or model could put into the
 * transcript. Newlines and tabs are handled by the renderer separately.
 */
export function sanitizeText(input: string): string {
  return stripAnsi(input)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[\u2028\u2029]/g, '\n')
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d
  )
}

/** Display cells used by a string (wide CJK/emoji count as 2). ANSI is ignored. */
export function displayWidth(input: string): number {
  let width = 0
  for (const char of stripAnsi(input)) {
    const codePoint = char.codePointAt(0) ?? 0
    if (char === '\n') continue
    if (char === '\t') {
      width += 4
      continue
    }
    if (isZeroWidth(codePoint)) continue
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

/** Truncate to a display width without cutting ANSI escape sequences. */
export function truncate(input: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(input) <= width) return input
  let result = ''
  let used = 0
  const target = Math.max(0, width - 1)
  for (let index = 0; index < input.length;) {
    if (input.codePointAt(index) === 0x1b) {
      ANSI.lastIndex = index
      const match = ANSI.exec(input)
      if (match !== null && match.index === index) {
        result += match[0]
        index += match[0].length
        continue
      }
    }
    const codePoint = input.codePointAt(index) ?? 0
    const char = String.fromCodePoint(codePoint)
    const charWidth = displayWidth(char)
    if (used + charWidth > target) break
    result += char
    used += charWidth
    index += char.length
  }
  if (result.includes('\u001b')) result += '\u001b[0m'
  return `${result}…`
}

/** Pad with spaces to a display width, truncating when necessary. */
export function pad(input: string, width: number, alignment: 'left' | 'right' = 'left'): string {
  const clipped = truncate(input, width)
  const padding = ' '.repeat(Math.max(0, width - displayWidth(clipped)))
  return alignment === 'left' ? `${clipped}${padding}` : `${padding}${clipped}`
}

/**
 * Wrap a single paragraph to `width` display cells. Words longer than the
 * width are hard-broken so a pasted token cannot push the layout off-screen.
 */
export function wrapText(input: string, width: number): string[] {
  if (width <= 1) return [truncate(input, Math.max(1, width))]
  const lines: string[] = []
  const push = (value: string): void => {
    lines.push(value.replace(/\s+$/, ''))
  }
  for (const paragraph of sanitizeText(input).split('\n')) {
    if (paragraph.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const word of paragraph.split(/(\s+)/)) {
      if (word.length === 0) continue
      if (/^\s+$/.test(word)) {
        if (current.length > 0 && currentWidth < width) {
          current += ' '
          currentWidth += 1
        }
        continue
      }
      const wordWidth = displayWidth(word)
      if (currentWidth > 0 && currentWidth + wordWidth > width) {
        push(current)
        current = ''
        currentWidth = 0
      }
      if (wordWidth <= width) {
        current += word
        currentWidth += wordWidth
        continue
      }
      for (const char of word) {
        const charWidth = displayWidth(char)
        if (currentWidth + charWidth > width && current.length > 0) {
          push(current)
          current = ''
          currentWidth = 0
        }
        current += char
        currentWidth += charWidth
      }
    }
    if (current.length > 0 || paragraph.length === 0) push(current)
  }
  return lines.length === 0 ? [''] : lines
}

/** Normalize CRLF and expand tabs for terminal display. */
export function expandTabs(input: string): string {
  return input.replace(/\t/g, '    ')
}

export interface SelectionRange {
  /** 1-based screen row of the anchor and focus. */
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export function normalizeSelection(range: SelectionRange): SelectionRange {
  const forward = range.endRow > range.startRow
    || (range.endRow === range.startRow && range.endColumn >= range.startColumn)
  return forward
    ? range
    : {
        startRow: range.endRow,
        startColumn: range.endColumn,
        endRow: range.startRow,
        endColumn: range.startColumn,
      }
}

/** How many plain characters fit before `column` (1-based). */
function charsBeforeColumn(plain: string, column: number): number {
  let width = 0
  let count = 0
  for (const char of plain) {
    const cells = char === '\t' ? 4 : Math.max(1, displayWidth(char))
    if (width + cells >= column) break
    width += cells
    count += 1
  }
  return count
}

/** How many plain characters are covered up to and including `column`. */
function charsThroughColumn(plain: string, column: number): number {
  let width = 0
  let count = 0
  for (const char of plain) {
    const cells = char === '\t' ? 4 : Math.max(1, displayWidth(char))
    width += cells
    count += 1
    if (width >= column) break
  }
  return count
}

/** Raw-string index just after `plainChars` visible characters. */
function rawIndexAfter(line: string, plainChars: number): number {
  let index = 0
  let seen = 0
  while (index < line.length && seen < plainChars) {
    if (line[index] === '\u001b') {
      const rest = line.slice(index)
      const match = /^[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/.exec(rest)
      index += match?.[0].length ?? 1
      continue
    }
    const char = String.fromCodePoint(line.codePointAt(index) ?? 0)
    index += char.length
    seen += 1
  }
  return index
}

/** Plain text inside a display-column span (1-based, inclusive end). */
export function columnSlice(text: string, from: number, to: number): string {
  const plain = stripAnsi(text)
  return plain.slice(charsBeforeColumn(plain, from), charsThroughColumn(plain, to))
}

/** Wrap the display-column span of one ANSI row in reverse video. */
export function highlightColumns(line: string, from: number, to: number): string {
  const plain = stripAnsi(line)
  const startChars = charsBeforeColumn(plain, from)
  const endChars = charsThroughColumn(plain, to)
  if (endChars <= startChars) return line
  const start = rawIndexAfter(line, startChars)
  const end = rawIndexAfter(line, endChars)
  return `${line.slice(0, start)}\u001b[7m${plain.slice(startChars, endChars)}\u001b[27m${line.slice(end)}`
}

/** Extract the selected rows as plain text, trimming trailing padding. */
export function selectionText(lines: readonly string[], range: SelectionRange): string {
  const normalized = normalizeSelection(range)
  const rows = lines.slice(normalized.startRow - 1, normalized.endRow)
  const out: string[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = normalized.startRow + index
    const plain = stripAnsi(rows[index] ?? '')
    const from = rowNumber === normalized.startRow ? normalized.startColumn : 1
    const to = rowNumber === normalized.endRow ? normalized.endColumn : displayWidth(plain)
    out.push(columnSlice(plain, from, to))
  }
  return out.join('\n').replace(/\s+$/u, '')
}
