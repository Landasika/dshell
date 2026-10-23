import { sanitizeText, wrapText } from './width.js'

/** Editable composer state. `cursor` is a UTF-16 offset, always on a boundary. */
export interface EditorState {
  text: string
  cursor: number
}

export interface EditResult {
  state: EditorState
  /** True when Up/Down changed history rather than moving the cursor. */
  handled: boolean
}

export function createEditor(text = ''): EditorState {
  return { text, cursor: text.length }
}

function previousBoundary(text: string, index: number): number {
  if (index <= 0) return 0
  const code = text.charCodeAt(index - 1)
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) return index - 2
  return index - 1
}

function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) return index + 2
  return index + 1
}

export function insertText(state: EditorState, raw: string): EditorState {
  const text = sanitizeText(raw).replace(/\r/g, '')
  if (text.length === 0) return state
  return {
    text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    cursor: state.cursor + text.length,
  }
}

export function lineCol(text: string, cursor: number): { line: number; column: number } {
  const before = text.slice(0, cursor)
  const lines = before.split('\n')
  return { line: Math.max(0, lines.length - 1), column: lines.at(-1)?.length ?? 0 }
}

function moveVertical(state: EditorState, direction: -1 | 1): EditorState {
  const position = lineCol(state.text, state.cursor)
  const lines = state.text.split('\n')
  const target = Math.max(0, Math.min(lines.length - 1, position.line + direction))
  if (target === position.line) return state
  let offset = 0
  for (let index = 0; index < target; index += 1) offset += (lines[index]?.length ?? 0) + 1
  return { ...state, cursor: offset + Math.min(position.column, lines[target]?.length ?? 0) }
}

/** Apply one editing key. Enter/Tab/Escape and app actions are handled elsewhere. */
export function editKey(
  state: EditorState,
  key: string,
  history: readonly string[] = [],
  historyIndex = -1,
): EditResult & { historyIndex: number } {
  switch (key) {
    case 'text':
      return { state, handled: true, historyIndex }
    case 'left':
      return { state: { ...state, cursor: previousBoundary(state.text, state.cursor) }, handled: true, historyIndex }
    case 'right':
      return { state: { ...state, cursor: nextBoundary(state.text, state.cursor) }, handled: true, historyIndex }
    case 'up': {
      if (history.length === 0) return { state: moveVertical(state, -1), handled: true, historyIndex }
      const nextIndex = Math.min(history.length - 1, historyIndex + 1)
      const value = history[history.length - 1 - nextIndex] ?? ''
      return { state: { text: value, cursor: value.length }, handled: true, historyIndex: nextIndex }
    }
    case 'down': {
      if (historyIndex >= 0) {
        const nextIndex = historyIndex - 1
        const value = nextIndex < 0 ? '' : history[history.length - 1 - nextIndex] ?? ''
        return { state: { text: value, cursor: value.length }, handled: true, historyIndex: nextIndex }
      }
      return { state: moveVertical(state, 1), handled: true, historyIndex }
    }
    case 'home': {
      const lineStart = state.text.lastIndexOf('\n', Math.max(0, state.cursor - 1)) + 1
      return { state: { ...state, cursor: lineStart }, handled: true, historyIndex }
    }
    case 'end': {
      const lineEnd = state.text.indexOf('\n', state.cursor)
      return { state: { ...state, cursor: lineEnd === -1 ? state.text.length : lineEnd }, handled: true, historyIndex }
    }
    case 'backspace': {
      if (state.cursor === 0) return { state, handled: true, historyIndex }
      const start = previousBoundary(state.text, state.cursor)
      return {
        state: { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start },
        handled: true,
        historyIndex,
      }
    }
    case 'delete': {
      if (state.cursor >= state.text.length) return { state, handled: true, historyIndex }
      const end = nextBoundary(state.text, state.cursor)
      return {
        state: { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor },
        handled: true,
        historyIndex,
      }
    }
    case 'ctrl-k': {
      const lineEnd = state.text.indexOf('\n', state.cursor)
      const end = lineEnd === -1 ? state.text.length : lineEnd
      return {
        state: { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor },
        handled: true,
        historyIndex,
      }
    }
    case 'ctrl-u': {
      const lineStart = state.text.lastIndexOf('\n', Math.max(0, state.cursor - 1)) + 1
      return {
        state: { text: state.text.slice(0, lineStart) + state.text.slice(state.cursor), cursor: lineStart },
        handled: true,
        historyIndex,
      }
    }
    case 'ctrl-w': {
      const before = state.text.slice(0, state.cursor)
      const match = /(\s*\S+)\s*$/.exec(before)
      if (match === null) return { state, handled: true, historyIndex }
      const start = before.length - (match[1]?.length ?? 0)
      return {
        state: { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start },
        handled: true,
        historyIndex,
      }
    }
    case 'ctrl-a': {
      const lineStart = state.text.lastIndexOf('\n', Math.max(0, state.cursor - 1)) + 1
      return { state: { ...state, cursor: lineStart }, handled: true, historyIndex }
    }
    case 'ctrl-e': {
      const lineEnd = state.text.indexOf('\n', state.cursor)
      return { state: { ...state, cursor: lineEnd === -1 ? state.text.length : lineEnd }, handled: true, historyIndex }
    }
    default:
      return { state, handled: false, historyIndex }
  }
}

/** Split composer text into visual lines, honoring explicit newlines and display width. */
export function composerLines(text: string, width: number): string[] {
  const lines: string[] = []
  for (const line of sanitizeText(text).split('\n')) {
    if (line.length === 0) {
      lines.push('')
      continue
    }
    lines.push(...wrapText(line, Math.max(1, width)))
  }
  return lines.length === 0 ? [''] : lines
}
