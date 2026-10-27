/**
 * Launch screen: a quiet, keyboard-first session picker. No splash art: the
 * TUI is a daily tool, so the first screen is the list you actually need.
 */
import { paint, type Theme } from './theme.js'
import { displayWidth, pad, truncate } from './width.js'

export interface SplashSession {
  label: string
  live: boolean
  cwd: string
  age: string
}

export interface SplashInput {
  columns: number
  rows: number
  now: number
  cwd: string
  kind: 'sessions' | 'missing'
  workspaceTitle?: string
  workspacePath?: string
  sessions: readonly SplashSession[]
  index: number
  /** The Host has not answered the first session query yet. */
  loading?: boolean
  error?: string
}

function sessionWindow(count: number, index: number, visible: number): { start: number; end: number } {
  const limit = Math.max(1, visible)
  const start = count <= limit ? 0 : Math.max(0, Math.min(index - Math.floor(limit / 2), count - limit))
  return { start, end: Math.min(count, start + limit) }
}

function sessionRow(theme: Theme, session: SplashSession, selected: boolean, width: number): string {
  const marker = selected ? paint(theme, 'accent', '▸') : ' '
  const live = session.live ? paint(theme, 'success', 'live') : paint(theme, 'muted', 'cold')
  const right = `${live} ${paint(theme, 'muted', session.age)}`
  const leftWidth = Math.max(10, width - displayWidth(right) - 3)
  const label = truncate(session.label, Math.max(8, leftWidth - 2))
  const name = selected ? paint(theme, 'text', label) : paint(theme, 'muted', label)
  const row = `${marker} ${name}`
  const gap = Math.max(1, width - displayWidth(row) - displayWidth(right))
  return `${row}${' '.repeat(gap)}${right}`
}

function content(theme: Theme, input: SplashInput, width: number): string[] {
  const lines: string[] = []
  const title = input.kind === 'missing' ? 'workspace not created' : 'choose session'
  const brand = `${paint(theme, 'accent', '◆')} ${paint(theme, 'bold', paint(theme, 'accentSoft', 'dshell'))} ${paint(theme, 'muted', '· DeepSeek Harness')}`
  lines.push(brand)
  lines.push(paint(theme, 'border', '─'.repeat(width)))
  lines.push('')
  lines.push(paint(theme, 'bold', title))
  lines.push(paint(theme, 'muted', truncate(input.kind === 'missing' ? input.cwd : input.workspacePath ?? input.cwd, width)))
  lines.push('')

  if (input.kind === 'missing') {
    lines.push(paint(theme, 'warning', 'No workspace exists for this directory yet.'))
    lines.push(paint(theme, 'muted', 'Create one now, or quit and cd to an existing workspace.'))
    lines.push('')
    lines.push(`${paint(theme, 'text', 'enter')} create workspace + new session`)
    lines.push(`${paint(theme, 'text', 'q')} quit without creating anything`)
  } else {
    lines.push(paint(theme, 'muted', input.loading === true ? 'q quit · waiting for the Host' : '↑/↓ move · enter attach · n new session · q quit'))
    lines.push('')
    if (input.loading === true) {
      lines.push(paint(theme, 'muted', 'reading sessions from the dsh Host…'))
    } else if (input.sessions.length === 0) {
      lines.push(paint(theme, 'muted', 'No sessions in this workspace yet. Press n to create one.'))
    } else {
      const visible = Math.max(1, Math.min(12, input.rows - lines.length - 4))
      const { start, end } = sessionWindow(input.sessions.length, input.index, visible)
      for (let index = start; index < end; index += 1) {
        const session = input.sessions[index]
        if (session === undefined) continue
        lines.push(sessionRow(theme, session, index === input.index, width))
      }
    }
  }

  if (input.error !== undefined) {
    lines.push('')
    lines.push(paint(theme, 'error', truncate(`! ${input.error}`, width)))
  }
  return lines
}

/** Render the full launch screen. The result is already sized to the terminal. */
export function renderSplash(theme: Theme, input: SplashInput): string[] {
  const columns = Math.max(20, input.columns)
  const rows = Math.max(6, input.rows)
  const width = Math.max(18, Math.min(columns - 4, 92))
  const left = Math.max(0, Math.floor((columns - width) / 2))
  const body = content(theme, input, width)
  const lines: string[] = ['']
  for (const line of body) {
    lines.push(`${' '.repeat(left)}${pad(line, width)}`)
  }
  while (lines.length < rows) lines.push('')
  return lines.slice(0, rows)
}
