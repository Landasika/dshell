import type { ReadStream, WriteStream } from 'node:tty'

import { displayWidth, highlightColumns, normalizeSelection, pad, selectionText, truncate, type SelectionRange } from './width.js'

export interface ScreenSize {
  columns: number
  rows: number
}

/** Minimal alternate-screen renderer. One full repaint per frame, throttled by the caller. */
export class TerminalScreen {
  private started = false
  private mouseEnabled = false
  private lastLines: readonly string[] = []
  private lastFrame: string[] = []
  private lastSize = ''
  private selection: SelectionRange | null = null
  private readonly onResize = (): void => this.resizeHandler?.()
  private resizeHandler: (() => void) | undefined

  constructor(
    readonly input: ReadStream,
    readonly output: WriteStream,
  ) {}

  get size(): ScreenSize {
    return {
      columns: Math.max(20, this.output.columns ?? 80),
      rows: Math.max(6, this.output.rows ?? 24),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.lastFrame = []
    this.lastSize = ''
    this.input.setRawMode(true)
    this.input.resume()
    this.output.write('\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H')
    // Bracketed paste + SGR mouse reporting. Wheel ticks are routed to the
    // transcript; hold Shift for the terminal's native text selection.
    // DSHELL_NO_MOUSE=1 keeps the terminal's own scrollback and selection.
    this.output.write('\u001b[?2004h')
    // Focus reporting: the TUI refreshes the session list when the window
    // regains focus. It is also why a terminal that reports focus without being
    // asked no longer leaks "[I" into the composer (the parser maps it).
    // Ask for the kitty keyboard protocol (disambiguate): Shift/Ctrl+Enter and
    // Ctrl+letter arrive as CSI u instead of being flattened into Enter. The
    // matching pop is in stop(); terminals without support ignore the request.
    this.output.write('\u001b[>1u\u001b[?1004h')
    this.mouseEnabled = process.env.DSHELL_NO_MOUSE !== '1'
    if (this.mouseEnabled) {
      // 1007 off: the terminal must not turn wheel ticks into arrow keys.
      // 1002 adds drag motion so the app can implement text selection itself;
      // 1007l keeps the terminal from turning wheel ticks into arrow keys.
      this.output.write('\u001b[?1007l\u001b[?1000h\u001b[?1002h\u001b[?1006h')
    }
    this.output.on('resize', this.onResize)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.output.off('resize', this.onResize)
    // Restore alternate-scroll so the user's shell wheel keeps working.
    const mouseReset = this.mouseEnabled ? '\u001b[?1000l\u001b[?1002l\u001b[?1006l\u001b[?1007h' : ''
    this.mouseEnabled = false
    this.output.write(`${mouseReset}\u001b[<u\u001b[?1004l\u001b[?2004l\u001b[?25h\u001b[?1049l`)
    try {
      this.input.setRawMode(false)
    } catch {
      // The terminal may already be gone.
    }
    this.input.pause()
  }

  onResizeRequest(handler: () => void): void {
    this.resizeHandler = handler
  }

  setSelection(range: SelectionRange | null): void {
    this.selection = range === null ? null : normalizeSelection(range)
  }

  get hasSelection(): boolean {
    return this.selection !== null
  }

  /** Copy arbitrary text through the terminal's clipboard (OSC 52). */
  copyText(text: string): string {
    if (text.length === 0) return ''
    const payload = Buffer.from(text, 'utf8').toString('base64')
    try {
      this.output.write(`\u001b]52;c;${payload}\u0007`)
    } catch {
      // no clipboard support; the caller still gets the text back
    }
    return text
  }

  /** Copy the current selection through the terminal's clipboard (OSC 52). */
  copySelection(): string {
    if (this.selection === null) return ''
    return this.copyText(selectionText(this.lastLines, this.selection))
  }

  /**
   * Draw a complete frame. Only rows whose text changed are rewritten: a full
   * repaint on every tick reads as flicker (and tears over slow links), while
   * a diff keeps the header and transcript rock steady.
   */
  draw(lines: readonly string[], cursor?: { row: number; column: number }): void {
    if (!this.started) return
    const { columns, rows } = this.size
    this.lastLines = lines
    const body = lines.slice(0, rows)
    const size = `${String(rows)}x${String(columns)}`
    if (size !== this.lastSize) {
      this.lastSize = size
      this.lastFrame = []
    }
    let frame = ''
    for (let index = 0; index < rows; index += 1) {
      const raw = body[index] ?? ''
      const selection = this.selection
      let line = raw
      if (selection !== null) {
        const row = index + 1
        if (row >= selection.startRow && row <= selection.endRow) {
          const from = row === selection.startRow ? selection.startColumn : 1
          const to = row === selection.endRow ? Math.max(selection.endColumn, selection.startColumn) : displayWidth(raw)
          line = highlightColumns(raw, from, to)
        }
      }
      const painted = pad(line, columns)
      if (this.lastFrame[index] === painted) continue
      this.lastFrame[index] = painted
      frame += `\u001b[${String(index + 1)};1H\u001b[2K${painted}`
    }
    if (cursor !== undefined && cursor.row >= 1 && cursor.row <= rows) {
      const column = Math.max(1, Math.min(columns, cursor.column))
      frame += `\u001b[${String(cursor.row)};${String(column)}H\u001b[?25h`
    } else {
      frame += '\u001b[?25l'
    }
    try {
      this.output.write(frame)
    } catch {
      // A closed pty must not crash the process.
    }
  }

  /** Clear and leave the cursor at the bottom, used before a non-TUI error. */
  clear(): void {
    if (!this.started) return
    this.lastFrame = []
    this.output.write('\u001b[2J\u001b[H')
  }
}

/** Scroll window over rendered lines; keeps a tail view unless the user scrolled up. */
export class Viewport {
  private offset = 0

  get scrollOffset(): number {
    return this.offset
  }

  reset(): void {
    this.offset = 0
  }

  scroll(lines: number, total: number, height: number): void {
    const max = Math.max(0, total - height)
    this.offset = Math.max(0, Math.min(max, this.offset + lines))
  }

  page(delta: number, total: number, height: number): void {
    this.scroll(delta * Math.max(1, height - 2), total, height)
  }

  top(total: number, height: number): void {
    this.offset = Math.max(0, total - height)
  }

  /** Scroll the window just enough to show the absolute line `index`. */
  reveal(index: number, total: number, height: number): void {
    const max = Math.max(0, total - height)
    const offset = Math.min(this.offset, max)
    const start = Math.max(0, total - height - offset)
    if (index < start) this.offset = Math.max(0, Math.min(max, total - height - index))
    else if (index >= start + height) this.offset = Math.max(0, Math.min(max, total - index - 1))
  }

  visible(all: readonly string[], height: number): { lines: string[]; start: number } {
    const max = Math.max(0, all.length - height)
    this.offset = Math.min(this.offset, max)
    const start = Math.max(0, all.length - height - this.offset)
    return { lines: all.slice(start, start + height), start }
  }
}

export function safeWrite(stream: WriteStream, text: string): void {
  try {
    stream.write(text)
  } catch {
    // ignore a vanished tty
  }
}

export function clampLine(line: string, columns: number): string {
  return displayWidth(line) <= columns ? line : truncate(line, columns)
}
