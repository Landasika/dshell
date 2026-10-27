import type { ReadStream, WriteStream } from 'node:tty'

import { displayWidth, pad, truncate } from './width.js'

export interface ScreenSize {
  columns: number
  rows: number
}

/** Minimal alternate-screen renderer. One full repaint per frame, throttled by the caller. */
export class TerminalScreen {
  private started = false
  private mouseEnabled = false
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
    this.input.setRawMode(true)
    this.input.resume()
    this.output.write('\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H')
    // Bracketed paste + SGR mouse reporting. Wheel ticks are routed to the
    // transcript; hold Shift for the terminal's native text selection.
    // DSHELL_NO_MOUSE=1 keeps the terminal's own scrollback and selection.
    this.output.write('\u001b[?2004h')
    this.mouseEnabled = process.env.DSHELL_NO_MOUSE !== '1'
    if (this.mouseEnabled) {
      // 1007 off: the terminal must not turn wheel ticks into arrow keys.
      this.output.write('\u001b[?1007l\u001b[?1000h\u001b[?1006h')
    }
    this.output.on('resize', this.onResize)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.output.off('resize', this.onResize)
    // Restore alternate-scroll so the user's shell wheel keeps working.
    const mouseReset = this.mouseEnabled ? '\u001b[?1000l\u001b[?1006l\u001b[?1007h' : ''
    this.mouseEnabled = false
    this.output.write(`${mouseReset}\u001b[?2004l\u001b[?25h\u001b[?1049l`)
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

  /** Draw a complete frame. Lines longer than the terminal are truncated. */
  draw(lines: readonly string[], cursor?: { row: number; column: number }): void {
    if (!this.started) return
    const { columns, rows } = this.size
    const body = lines.slice(0, rows)
    let frame = '\u001b[H'
    for (let index = 0; index < rows; index += 1) {
      const line = body[index] ?? ''
      frame += `\u001b[2K${pad(line, columns)}`
      if (index < rows - 1) frame += '\r\n'
    }
    if (cursor !== undefined && cursor.row >= 1 && cursor.row <= rows) {
      const column = Math.max(1, Math.min(columns, cursor.column))
      frame += `\u001b[${cursor.row};${column}H\u001b[?25h`
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
