/** Key parser for raw-mode terminal input (Linux xterm-compatible sequences). */

export type Key =
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'enter' }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'page-up' }
  | { type: 'page-down' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'escape' }
  | { type: 'ctrl-c' }
  | { type: 'ctrl-d' }
  | { type: 'ctrl-k' }
  | { type: 'ctrl-u' }
  | { type: 'ctrl-w' }
  | { type: 'ctrl-l' }
  | { type: 'ctrl-a' }
  | { type: 'ctrl-e' }

const SEQUENCES: Record<string, Key> = {
  '\u001b[A': { type: 'up' },
  '\u001b[B': { type: 'down' },
  '\u001b[C': { type: 'right' },
  '\u001b[D': { type: 'left' },
  '\u001b[H': { type: 'home' },
  '\u001b[F': { type: 'end' },
  '\u001bOH': { type: 'home' },
  '\u001bOF': { type: 'end' },
  '\u001b[1~': { type: 'home' },
  '\u001b[4~': { type: 'end' },
  '\u001b[3~': { type: 'delete' },
  '\u001b[5~': { type: 'page-up' },
  '\u001b[6~': { type: 'page-down' },
  '\u001b[Z': { type: 'shift-tab' },
  '\u001b[1;2A': { type: 'up' },
  '\u001b[1;2B': { type: 'down' },
  '\u001b\r': { type: 'newline' },
}

const CONTROL: Record<string, Key> = {
  '\r': { type: 'enter' },
  '\n': { type: 'newline' },
  '\u007f': { type: 'backspace' },
  '\b': { type: 'backspace' },
  '\t': { type: 'tab' },
  '\u0003': { type: 'ctrl-c' },
  '\u0004': { type: 'ctrl-d' },
  '\u000b': { type: 'ctrl-k' },
  '\u0015': { type: 'ctrl-u' },
  '\u0017': { type: 'ctrl-w' },
  '\u000c': { type: 'ctrl-l' },
  '\u0001': { type: 'ctrl-a' },
  '\u0005': { type: 'ctrl-e' },
}

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * Buffers incomplete escape sequences across `data` events. Raw mode can split
 * an arrow key or a bracketed paste across several chunks.
 */
export class KeyParser {
  private buffer = ''

  feed(chunk: string): Key[] {
    this.buffer += chunk
    const keys: Key[] = []
    for (;;) {
      const key = this.next()
      if (key === null) break
      keys.push(key)
    }
    return keys
  }

  /** Emit a lone Escape after the terminal's short ambiguity window. */
  flushEscape(): Key | null {
    if (this.buffer === '\u001b') {
      this.buffer = ''
      return { type: 'escape' }
    }
    return null
  }

  private next(): Key | null {
    if (this.buffer.length === 0) return null

    if (this.buffer.startsWith(PASTE_START)) {
      const end = this.buffer.indexOf(PASTE_END, PASTE_START.length)
      if (end === -1) return null
      const text = this.buffer.slice(PASTE_START.length, end)
      this.buffer = this.buffer.slice(end + PASTE_END.length)
      return { type: 'paste', text }
    }

    if (this.buffer.startsWith('\u001b')) {
      for (const [sequence, key] of Object.entries(SEQUENCES)) {
        if (this.buffer.startsWith(sequence)) {
          this.buffer = this.buffer.slice(sequence.length)
          return key
        }
      }
      // A partial CSI/SS3 sequence: wait for the rest.
      if (/^\u001b(\[[0-9;?]*|[O])?$/.test(this.buffer)) return null
      // Unknown escape: consume ESC and let the next char be text.
      this.buffer = this.buffer.slice(1)
      return { type: 'escape' }
    }

    const first = this.buffer[0] ?? ''
    const control = CONTROL[first]
    if (control !== undefined) {
      this.buffer = this.buffer.slice(1)
      return control
    }
    if (first < ' ') {
      this.buffer = this.buffer.slice(1)
      return { type: 'text', text: '' }
    }

    const codePoint = this.buffer.codePointAt(0)
    if (codePoint === undefined) return null
    const char = String.fromCodePoint(codePoint)
    this.buffer = this.buffer.slice(char.length)
    return { type: 'text', text: char }
  }
}
