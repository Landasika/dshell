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
  | { type: 'ctrl-z' }
  | { type: 'ctrl-d' }
  | { type: 'ctrl-k' }
  | { type: 'ctrl-u' }
  | { type: 'ctrl-w' }
  | { type: 'ctrl-l' }
  | { type: 'ctrl-a' }
  | { type: 'ctrl-e' }
  | { type: 'ctrl-p' }
  | { type: 'ctrl-n' }
  | { type: 'ctrl-r' }
  | { type: 'ctrl-b' }
  | { type: 'ctrl-t' }
  | { type: 'ctrl-o' }
  | { type: 'ctrl-g' }
  | { type: 'alt-enter' }
  | { type: 'alt-q' }
  | { type: 'alt-backspace' }
  | { type: 'alt-up' }
  | { type: 'alt-down' }
  | { type: 'focus'; focused: boolean }
  | { type: 'wheel'; delta: number }
  | { type: 'click'; row: number; column: number }
  | { type: 'drag'; row: number; column: number }
  | { type: 'release'; row: number; column: number }

const SEQUENCES: Record<string, Key> = {
  '\u001b[A': { type: 'up' },
  '\u001b[B': { type: 'down' },
  '\u001b[C': { type: 'right' },
  '\u001b[D': { type: 'left' },
  // Application-cursor mode (SS3), sent by some terminals for arrow keys.
  '\u001bOA': { type: 'up' },
  '\u001bOB': { type: 'down' },
  '\u001bOC': { type: 'right' },
  '\u001bOD': { type: 'left' },
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
  // Alt+arrows recall prompt history; plain arrows scroll the transcript.
  '\u001b[1;3A': { type: 'alt-up' },
  '\u001b[1;3B': { type: 'alt-down' },
  '\u001b[1;5A': { type: 'up' },
  '\u001b[1;5B': { type: 'down' },
  '\u001b\r': { type: 'alt-enter' },
  // Some terminals grab Alt+Enter for fullscreen, so queuing has a plain
  // Alt+letter binding of its own.
  '\u001bq': { type: 'alt-q' },
  '\u001bQ': { type: 'alt-q' },
  '\u001b\u007f': { type: 'alt-backspace' },
  // Focus reporting (xterm 1004). Terminals send these whenever the window
  // gains or loses focus; without a mapping they leaked into the composer as a
  // literal "[I".
  '\u001b[I': { type: 'focus', focused: true },
  '\u001b[O': { type: 'focus', focused: false },
}

const CONTROL: Record<string, Key> = {
  '\u001a': { type: 'ctrl-z' },
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
  '\u0010': { type: 'ctrl-p' },
  '\u000e': { type: 'ctrl-n' },
  '\u0012': { type: 'ctrl-r' },
  '\u0002': { type: 'ctrl-b' },
  '\u0014': { type: 'ctrl-t' },
  '\u000f': { type: 'ctrl-o' },
  '\u0007': { type: 'ctrl-g' },
}

/** Ctrl+letter as reported by the kitty keyboard protocol. */
const CTRL_LETTERS: Record<string, Key> = {
  a: { type: 'ctrl-a' },
  b: { type: 'ctrl-b' },
  c: { type: 'ctrl-c' },
  d: { type: 'ctrl-d' },
  e: { type: 'ctrl-e' },
  g: { type: 'ctrl-g' },
  k: { type: 'ctrl-k' },
  l: { type: 'ctrl-l' },
  n: { type: 'ctrl-n' },
  o: { type: 'ctrl-o' },
  p: { type: 'ctrl-p' },
  r: { type: 'ctrl-r' },
  t: { type: 'ctrl-t' },
  u: { type: 'ctrl-u' },
  w: { type: 'ctrl-w' },
}

/**
 * Decode a kitty-protocol `CSI code ; mods u` key. Only the codes dshell binds
 * appear here: Escape, Enter/Tab/Backspace with modifiers, Ctrl+letter and
 * plain text. Modifier bits are 1 = shift, 2 = alt, 4 = ctrl.
 */
function decodeCsiU(code: number, mods: number): Key {
  // kitty encodes mods as 1 + (shift 1 | alt 2 | ctrl 4 | …).
  const flags = Math.max(0, mods - 1)
  const shift = (flags & 1) !== 0
  const alt = (flags & 2) !== 0
  const ctrl = (flags & 4) !== 0
  if (code === 27) return { type: 'escape' }
  if (code === 13) {
    // Ctrl+Enter is the newline chord; Alt+Enter still queues where the
    // terminal forwards it at all.
    if (ctrl || shift) return { type: 'newline' }
    if (alt) return { type: 'alt-enter' }
    return { type: 'enter' }
  }
  if (code === 9) return shift ? { type: 'shift-tab' } : { type: 'tab' }
  if (code === 127 || code === 8) return ctrl ? { type: 'ctrl-w' } : { type: 'backspace' }
  const char = String.fromCodePoint(code)
  if (ctrl) {
    const mapped = CTRL_LETTERS[char.toLowerCase()]
    return mapped ?? { type: 'text', text: '' }
  }
  if (alt) {
    if (char.toLowerCase() === 'q') return { type: 'alt-q' }
    return { type: 'text', text: '' }
  }
  return { type: 'text', text: shift ? char.toUpperCase() : char }
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

    // SGR mouse reports: ESC [ < button ; column ; row M/m. The app enables
    // 1000+1006 in the alternate screen, so wheel ticks arrive here instead of
    // being turned into arrow keys by the terminal.
    if (this.buffer.startsWith('\u001b[<')) {
      const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer)
      if (match === null) {
        // A partial report: wait for the terminating M/m. Bound the wait so a
        // stray ESC [ < can never wedge the parser.
        if (this.buffer.length > 32) this.buffer = this.buffer.slice(3)
        return null
      }
      const code = Number(match[1] ?? 0)
      const column = Number(match[2] ?? 0)
      const row = Number(match[3] ?? 0)
      const release = match[4] === 'm'
      this.buffer = this.buffer.slice(match[0].length)
      const button = code & ~(4 | 8 | 16)
      if (button === 64) return { type: 'wheel', delta: -1 }
      if (button === 65) return { type: 'wheel', delta: 1 }
      if (button === 0) {
        if (release) return { type: 'release', row, column }
        return { type: 'click', row, column }
      }
      // 32 is the motion bit: a left-button drag (selection).
      if (button === 32 || button === 33) return { type: 'drag', row, column }
      return { type: 'text', text: '' }
    }

    if (this.buffer.startsWith('\u001b')) {
      // Kitty keyboard protocol: dshell requests the "disambiguate" level, so
      // Escape, Ctrl+letter and modified Enter/Tab/Backspace arrive here.
      const kitty = /^\u001b\[(\d+)(?:;(\d+))?u/.exec(this.buffer)
      if (kitty !== null) {
        this.buffer = this.buffer.slice(kitty[0].length)
        return decodeCsiU(Number(kitty[1] ?? 0), Number(kitty[2] ?? 1))
      }
      // xterm modifyOtherKeys level 2 reports Ctrl+Enter like this.
      if (this.buffer.startsWith('\u001b[27;5;13~')) {
        this.buffer = this.buffer.slice('\u001b[27;5;13~'.length)
        return { type: 'newline' }
      }
      for (const [sequence, key] of Object.entries(SEQUENCES)) {
        if (this.buffer.startsWith(sequence)) {
          this.buffer = this.buffer.slice(sequence.length)
          return key
        }
      }
      // A partial CSI/SS3 sequence: wait for the rest.
      if (/^\u001b(\[[0-9;?<>]*|[O])?$/.test(this.buffer)) return null
      // Any other complete CSI/SS3 report (focus, terminal queries, keys this
      // parser does not know) is swallowed whole; only ESC alone is the Escape
      // key, so the rest must never fall through as typed text.
      const csi = /^\u001b\[[0-9;?<>]*[\u0040-\u007e]/.exec(this.buffer)
      if (csi !== null) {
        this.buffer = this.buffer.slice(csi[0].length)
        return { type: 'text', text: '' }
      }
      const ss3 = /^\u001bO[\u0020-\u007e]/.exec(this.buffer)
      if (ss3 !== null) {
        this.buffer = this.buffer.slice(ss3[0].length)
        return { type: 'text', text: '' }
      }
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
