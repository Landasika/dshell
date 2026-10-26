import { readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import type { ReadStream, WriteStream } from 'node:tty'

import type {
  DshellBackend,
  SessionHandle,
  SessionSummary,
  SessionView,
  WorkspaceSummary,
} from '../backend/index.js'
import { BackendError } from '../backend/index.js'
import { KeyParser, type Key } from './keys.js'
import { composerLines, createEditor, editKey, insertText, lineCol, type EditorState } from './editor.js'
import { buildBlocks, renderBlocks, type Block } from './events.js'
import { renderMarkdown } from './markdown.js'
import { TerminalScreen, Viewport } from './screen.js'
import { paint, type Theme } from './theme.js'
import { createTheme } from './theme.js'
import { displayWidth, pad, sanitizeText, truncate, wrapText } from './width.js'

export interface TuiOptions {
  cwd: string
  resume?: string
  verbose?: boolean
  color?: boolean
  /** Skip the startup picker and create a session immediately. */
  create?: boolean
  /** Workspace to use when `create` is set. */
  workspaceId?: string
  /** Injectable streams for a PTY test harness. */
  input?: ReadStream
  output?: WriteStream
}

interface StartupState {
  kind: 'sessions' | 'missing'
  cwd: string
  workspace?: WorkspaceSummary
  sessions: SessionSummary[]
  index: number
}

type Overlay =
  | { kind: 'sessions'; index: number; workspaceId?: string }
  | { kind: 'workspaces'; index: number }
  | { kind: 'help' }
  | { kind: 'approval'; details: boolean }

interface AppState {
  sessions: SessionSummary[]
  workspaces: WorkspaceSummary[]
  currentId?: string
  handle?: SessionHandle
  view?: SessionView
  editor: EditorState
  history: string[]
  historyIndex: number
  overlay: Overlay | null
  startup?: StartupState
  status: string
  error?: string
  toast?: { text: string; until: number }
  verbose: boolean
  clearedAtSeq: number
  approvalBusy: boolean
  pendingPrompt?: string
  quitting: boolean
}

const COMMANDS = [
  ['/help', 'show keys and commands'],
  ['/sessions', 'switch session'],
  ['/workspaces', 'switch workspace'],
  ['/new [cwd]', 'create a session'],
  ['/attach <id>', 'attach by id'],
  ['/cancel', 'cancel the running turn'],
  ['/clear', 'clear the local transcript view'],
  ['/reconnect', 'reattach the current session'],
  ['/verbose', 'toggle reasoning and lifecycle events'],
  ['/quit', 'leave the TUI (does not cancel the Host turn)'],
] as const

function shortId(id: string | undefined): string {
  if (id === undefined) return 'no session'
  return id.length > 22 ? `${id.slice(0, 19)}…` : id
}

export function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

export function findWorkspaceForCwd(
  workspaces: readonly WorkspaceSummary[],
  cwd: string,
): WorkspaceSummary | undefined {
  const wanted = canonicalPath(cwd)
  return workspaces.find((workspace) => canonicalPath(workspace.path) === wanted)
}

function statusLabel(state: AppState): string {
  if (state.error !== undefined) return 'error'
  if (state.startup !== undefined) {
    return state.startup.kind === 'missing' ? 'workspace' : 'choose session'
  }
  if (state.view?.pendingApproval !== undefined) return 'approval'
  if (state.view?.status === 'running') return 'running'
  if (state.view === undefined) return 'connecting'
  return 'idle'
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | 'gray' | 'cyan' | 'magenta' {
  switch (status) {
    case 'running':
      return 'yellow'
    case 'approval':
      return 'magenta'
    case 'error':
      return 'red'
    case 'connecting':
      return 'cyan'
    default:
      return 'gray'
  }
}

export function latestSessionTitle(events: readonly SessionView['events'][number][]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (typeof data.title === 'string' && data.title.trim().length > 0) return data.title.trim()
  }
  return undefined
}

function isCommand(text: string): boolean {
  return text.startsWith('/') && !text.includes('\n')
}

function timeAgo(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** Main interactive TUI. Returns the process exit code. */
export async function runTui(backend: DshellBackend, options: TuiOptions): Promise<number> {
  const input = options.input ?? (stdin as unknown as ReadStream)
  const output = options.output ?? (stdout as unknown as WriteStream)
  if (!input.isTTY || !output.isTTY) {
    throw new Error('dshell TUI needs a TTY; use `dshell --help` for non-interactive commands')
  }
  const theme = createTheme(options.color)
  const screen = new TerminalScreen(input, output)
  const viewport = new Viewport()
  const parser = new KeyParser()
  const state: AppState = {
    sessions: [],
    workspaces: [],
    editor: createEditor(),
    history: [],
    historyIndex: -1,
    overlay: null,
    status: 'starting',
    verbose: options.verbose === true,
    clearedAtSeq: 0,
    approvalBusy: false,
    quitting: false,
  }

  let renderTimer: NodeJS.Timeout | undefined
  let escapeTimer: NodeJS.Timeout | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let resolveDone: ((code: number) => void) | undefined
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve
  })

  const schedule = (): void => {
    if (renderTimer !== undefined) return
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      render()
    }, 33)
  }

  const toast = (text: string): void => {
    state.toast = { text, until: Date.now() + 4_000 }
    schedule()
  }

  const errorText = (error: unknown): string => {
    if (error instanceof BackendError) {
      return error.action === undefined ? error.message : `${error.message} (${error.action})`
    }
    return error instanceof Error ? error.message : String(error)
  }

  const quit = (code = 0): void => {
    if (state.quitting) return
    state.quitting = true
    if (renderTimer !== undefined) clearTimeout(renderTimer)
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    if (pollTimer !== undefined) clearInterval(pollTimer)
    input.off('data', onData)
    input.off('end', onEnd)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    state.handle?.dispose()
    state.handle = undefined
    screen.stop()
    resolveDone?.(code)
  }

  const onSignal = (): void => quit(0)
  const onEnd = (): void => quit(0)

  const applyView = (view: SessionView): void => {
    state.view = view
    state.currentId = view.sessionId
    if (view.pendingApproval !== undefined) {
      if (state.overlay?.kind !== 'approval') state.overlay = { kind: 'approval', details: false }
    } else if (state.overlay?.kind === 'approval') {
      state.overlay = null
    }
    schedule()
  }

  const openSession = async (sessionId: string): Promise<void> => {
    if (state.handle?.id === sessionId) {
      state.startup = undefined
      return
    }
    try {
      state.status = `attaching ${shortId(sessionId)}`
      schedule()
      const next = await backend.openSession(sessionId)
      state.handle?.dispose()
      state.handle = next
      state.currentId = sessionId
      state.approvalBusy = false
      applyView(next.snapshot())
      const off = next.subscribe((view) => applyView(view))
      // A disposed handle drops its listeners; keep the disposer out of the
      // state to avoid an extra public field on the app object.
      void off
      state.error = undefined
      state.status = 'idle'
      state.startup = undefined
      state.clearedAtSeq = 0
      viewport.reset()
      const pending = state.pendingPrompt
      state.pendingPrompt = undefined
      if (pending !== undefined) void send(pending)
    } catch (error) {
      state.error = errorText(error)
      state.status = 'error'
      schedule()
    }
  }

  const refreshSessions = async (): Promise<void> => {
    try {
      state.sessions = await backend.listSessions()
      state.workspaces = await backend.listWorkspaces()
      schedule()
    } catch (error) {
      state.error = errorText(error)
      schedule()
    }
  }

  const createSession = async (cwd?: string, workspaceId?: string): Promise<void> => {
    try {
      state.status = 'creating session'
      schedule()
      const handle = await backend.createSession({
        cwd: workspaceId === undefined ? cwd ?? options.cwd : undefined,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
      const view = handle.snapshot()
      state.handle?.dispose()
      state.handle = handle
      state.currentId = view.sessionId
      applyView(view)
      handle.subscribe((next) => applyView(next))
      state.overlay = null
      state.startup = undefined
      state.status = 'new session'
      state.clearedAtSeq = 0
      viewport.reset()
      const pending = state.pendingPrompt
      state.pendingPrompt = undefined
      if (pending !== undefined) void send(pending)
      await refreshSessions()
      toast(`created ${view.sessionId}`)
    } catch (error) {
      state.error = errorText(error)
      state.status = 'error'
      schedule()
    }
  }

  const prepareStartup = (): void => {
    const cwd = canonicalPath(options.cwd)
    const workspace = findWorkspaceForCwd(state.workspaces, cwd)
    if (workspace === undefined) {
      state.startup = { kind: 'missing', cwd, sessions: [], index: 0 }
      schedule()
      return
    }
    const sessions = state.sessions
      .filter((session) => {
        if (session.workspaceId === workspace.id) return true
        return session.cwd !== undefined && canonicalPath(session.cwd) === canonicalPath(workspace.path)
      })
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    state.startup = {
      kind: 'sessions',
      cwd,
      workspace,
      sessions,
      index: 0,
    }
    schedule()
  }

  const send = async (text: string): Promise<void> => {
    const trimmed = text.replace(/\s+$/, '')
    if (trimmed.length === 0) return
    if (state.handle === undefined) {
      state.pendingPrompt = trimmed
      state.editor = createEditor()
      state.historyIndex = -1
      toast('session is still connecting; your prompt is queued')
      schedule()
      return
    }
    state.history.push(trimmed)
    if (state.history.length > 100) state.history.shift()
    state.historyIndex = -1
    state.editor = createEditor()
    state.status = 'sending'
    state.error = undefined
    schedule()
    try {
      await state.handle.send(trimmed)
      state.status = 'waiting for turn'
    } catch (error) {
      state.error = errorText(error)
      state.status = 'error'
    }
    schedule()
  }

  const cancel = async (): Promise<void> => {
    if (state.handle === undefined) return
    try {
      await state.handle.cancel()
      state.status = 'cancelling'
      toast('cancel requested; the Host decides when the turn stops')
    } catch (error) {
      state.error = errorText(error)
    }
    schedule()
  }

  const answerApproval = async (outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    const pending = state.view?.pendingApproval
    if (pending === undefined || state.handle === undefined || state.approvalBusy) return
    state.approvalBusy = true
    state.status = outcome === 'allowed-once' ? 'approving' : 'rejecting'
    schedule()
    try {
      await state.handle.answerApproval(pending.requestId, outcome)
      toast(outcome === 'allowed-once' ? 'allowed once' : 'rejected')
    } catch (error) {
      state.error = errorText(error)
    } finally {
      state.approvalBusy = false
      schedule()
    }
  }

  const switchOverlaySession = (index: number): void => {
    const overlay = state.overlay
    if (overlay?.kind !== 'sessions') return
    const sessions = filteredSessions(overlay.workspaceId)
    const chosen = sessions[index]
    if (chosen === undefined) return
    state.overlay = null
    void openSession(chosen.sessionId)
  }

  const filteredSessions = (workspaceId?: string): SessionSummary[] => {
    if (workspaceId === undefined) return state.sessions
    return state.sessions.filter((session) => session.workspaceId === workspaceId)
  }

  const runCommand = async (text: string): Promise<void> => {
    const [command, ...rest] = text.trim().split(/\s+/)
    const argument = rest.join(' ')
    switch (command) {
      case '/quit':
      case '/exit':
        quit(0)
        return
      case '/help':
      case '/?':
        state.overlay = { kind: 'help' }
        schedule()
        return
      case '/sessions':
      case '/resume':
        await refreshSessions()
        state.overlay = { kind: 'sessions', index: 0 }
        schedule()
        return
      case '/workspaces':
        await refreshSessions()
        state.overlay = { kind: 'workspaces', index: 0 }
        schedule()
        return
      case '/new':
        await createSession(argument.length === 0 ? options.cwd : argument)
        return
      case '/attach':
        if (argument.length === 0) {
          toast('/attach needs a session id')
          return
        }
        await openSession(argument)
        return
      case '/cancel':
        await cancel()
        return
      case '/clear':
        state.clearedAtSeq = state.view?.cursor ?? 0
        viewport.reset()
        toast('local transcript cleared; durable history is unchanged')
        schedule()
        return
      case '/reconnect':
        if (state.currentId !== undefined) {
          const id = state.currentId
          state.handle?.dispose()
          state.handle = undefined
          await openSession(id)
        }
        return
      case '/verbose':
        state.verbose = !state.verbose
        toast(`verbose ${state.verbose ? 'on' : 'off'}`)
        schedule()
        return
      default:
        toast(`unknown command ${command}; try /help`)
    }
  }

  const complete = (): void => {
    const text = state.editor.text
    if (text.startsWith('/') && !text.includes(' ')) {
      const match = COMMANDS.map(([name]) => name).find((name) => name.startsWith(text))
      if (match !== undefined) {
        state.editor = createEditor(`${match} `)
        schedule()
      }
      return
    }
    const at = /(?:^|\s)@([^\s]*)$/.exec(text)
    if (at === null) return
    const prefix = at[1] ?? ''
    const candidates = fileCandidates(options.cwd, prefix)
    if (candidates.length === 0) {
      toast(`no files match @${prefix}`)
      return
    }
    const replacement = `@${candidates[0]}`
    const start = text.length - (prefix.length + 1)
    const next = `${text.slice(0, start)}${replacement}`
    state.editor = createEditor(next)
    if (candidates.length > 1) toast(`${candidates.length} matches; first: ${candidates[0]}`)
    schedule()
  }

  const handleOverlayKey = (key: Key): void => {
    const overlay = state.overlay
    if (overlay === null) return
    if (key.type === 'escape') {
      if (overlay.kind === 'approval') {
        toast('approval still pending; answer with a/r or wait for the timeout')
      } else {
        state.overlay = null
      }
      schedule()
      return
    }
    if (key.type === 'ctrl-c') {
      quit(0)
      return
    }
    if (overlay.kind === 'approval') {
      if (key.type === 'text' && key.text.toLowerCase() === 'a') void answerApproval('allowed-once')
      else if (key.type === 'text' && key.text.toLowerCase() === 'r') void answerApproval('rejected')
      else if (key.type === 'text' && key.text.toLowerCase() === 'd') {
        overlay.details = !overlay.details
        schedule()
      }
      return
    }
    if (overlay.kind === 'help') return
    if (overlay.kind === 'workspaces') {
      if (key.type === 'up') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.type === 'down') overlay.index = Math.min(state.workspaces.length - 1, overlay.index + 1)
      else if (key.type === 'enter') {
        const workspace = state.workspaces[overlay.index]
        if (workspace !== undefined) {
          state.overlay = { kind: 'sessions', index: 0, workspaceId: workspace.id }
        }
      } else if (key.type === 'text' && key.text.toLowerCase() === 'n') {
        const workspace = state.workspaces[overlay.index]
        if (workspace !== undefined) void createSession(undefined, workspace.id)
      }
      schedule()
      return
    }
    const overlaySessions = filteredSessions(overlay.workspaceId)
    if (key.type === 'up') overlay.index = Math.max(0, overlay.index - 1)
    else if (key.type === 'down') overlay.index = Math.min(overlaySessions.length - 1, overlay.index + 1)
    else if (key.type === 'enter') switchOverlaySession(overlay.index)
    else if (key.type === 'text' && key.text.toLowerCase() === 'n') void createSession(undefined, overlay.workspaceId)
    schedule()
  }

  const handleStartupKey = (key: Key): void => {
    const startup = state.startup
    if (startup === undefined) return
    if (key.type === 'ctrl-c' || key.type === 'ctrl-d' || key.type === 'escape') {
      quit(0)
      return
    }
    if (key.type === 'text' && key.text.toLowerCase() === 'q') {
      quit(0)
      return
    }
    if (startup.kind === 'missing') {
      if (key.type === 'enter' || key.type === 'newline' || (key.type === 'text' && key.text.toLowerCase() === 'c')) {
        void createSession(startup.cwd)
      }
      return
    }
    if (key.type === 'up' || (key.type === 'text' && key.text.toLowerCase() === 'k')) {
      startup.index = Math.max(0, startup.index - 1)
    } else if (key.type === 'down' || (key.type === 'text' && key.text.toLowerCase() === 'j')) {
      startup.index = Math.min(Math.max(0, startup.sessions.length - 1), startup.index + 1)
    } else if (key.type === 'enter' || key.type === 'newline') {
      const chosen = startup.sessions[startup.index]
      if (chosen !== undefined) void openSession(chosen.sessionId)
    } else if (key.type === 'text' && key.text.toLowerCase() === 'n') {
      void createSession(undefined, startup.workspace?.id)
    }
    schedule()
  }

  const handleKey = (key: Key): void => {
    if (state.quitting) return
    if (state.startup !== undefined) {
      handleStartupKey(key)
      return
    }
    if (state.overlay !== null) {
      handleOverlayKey(key)
      return
    }
    if (key.type === 'escape') {
      if (state.editor.text.length > 0) {
        state.editor = createEditor()
        state.historyIndex = -1
        schedule()
      }
      return
    }
    if (key.type === 'ctrl-c') {
      if (state.editor.text.length > 0) {
        state.editor = createEditor()
        state.historyIndex = -1
        schedule()
      } else if (state.view?.status === 'running') {
        void cancel()
      } else {
        quit(0)
      }
      return
    }
    if (key.type === 'ctrl-d') {
      if (state.editor.text.length === 0) quit(0)
      return
    }
    if (key.type === 'ctrl-l') {
      screen.clear()
      schedule()
      return
    }
    if (key.type === 'page-up') {
      viewport.page(-1, transcriptLineCount(), transcriptHeight())
      schedule()
      return
    }
    if (key.type === 'page-down') {
      viewport.page(1, transcriptLineCount(), transcriptHeight())
      schedule()
      return
    }
    if (key.type === 'newline') {
      state.editor = insertText(state.editor, '\n')
      state.historyIndex = -1
      schedule()
      return
    }
    if (key.type === 'enter') {
      const text = state.editor.text
      if (isCommand(text)) {
        state.editor = createEditor()
        void runCommand(text)
      } else {
        void send(text)
      }
      return
    }
    if (key.type === 'paste') {
      state.editor = insertText(state.editor, key.text)
      schedule()
      return
    }
    if (key.type === 'text') {
      state.editor = insertText(state.editor, key.text)
      state.historyIndex = -1
      schedule()
      return
    }
    if (key.type === 'tab') {
      complete()
      return
    }
    const mapped: Record<string, string> = {
      left: 'left',
      right: 'right',
      up: 'up',
      down: 'down',
      home: 'home',
      end: 'end',
      backspace: 'backspace',
      delete: 'delete',
      'ctrl-k': 'ctrl-k',
      'ctrl-u': 'ctrl-u',
      'ctrl-w': 'ctrl-w',
      'ctrl-a': 'ctrl-a',
      'ctrl-e': 'ctrl-e',
      newline: '',
    }
    const action = mapped[key.type]
    if (action === undefined || action === '') return
    const result = editKey(state.editor, action, state.history, state.historyIndex)
    state.editor = result.state
    state.historyIndex = result.historyIndex
    schedule()
  }

  const onData = (chunk: string): void => {
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    const keys = parser.feed(chunk)
    for (const key of keys) handleKey(key)
    if (keys.length === 0) {
      escapeTimer = setTimeout(() => {
        const escaped = parser.flushEscape()
        if (escaped !== null) handleKey(escaped)
      }, 25)
    }
  }

  const transcript = (): { lines: string[]; live: boolean } => {
    const view = state.view
    if (view === undefined) return { lines: [paint(theme, 'dim', 'connecting to the dsh Host…')], live: false }
    const events = view.events.filter((event) => event.seq > state.clearedAtSeq)
    const blocks = buildBlocks(events, state.verbose)
    const lines = renderBlocks(blocks, Math.max(20, screen.size.columns - 2), theme)
    if (view.streamText.length > 0 && view.status === 'running') {
      lines.push('')
      lines.push(paint(theme, 'green', 'dshell'))
      lines.push(...renderMarkdown(view.streamText, Math.max(20, screen.size.columns - 2), theme))
      lines.push(paint(theme, 'dim', '▌'))
    }
    return { lines, live: view.status === 'running' }
  }

  const transcriptHeight = (): number => {
    const { rows } = screen.size
    const composer = Math.min(7, Math.max(1, composerLines(state.editor.text, Math.max(1, screen.size.columns - 4)).length))
    return Math.max(3, rows - 2 - composer - 3)
  }

  const transcriptLineCount = (): number => transcript().lines.length

  const headerLines = (): string[] => {
    const view = state.view
    const status = statusLabel(state)
    const title = view?.header.title ?? (view === undefined ? undefined : latestSessionTitle(view.events))
    const session = title === undefined ? shortId(view?.sessionId) : truncate(title, 34)
    const cwd = view?.header.cwd ?? options.cwd
    const left = `${paint(theme, 'bold', paint(theme, 'cyan', 'dshell'))} ${paint(theme, 'dim', '·')} ${session}`
    const right = `${paint(theme, statusColor(status), status)} ${paint(theme, 'dim', `· ${truncate(cwd, Math.max(10, screen.size.columns - 36))}`)}`
    const gap = Math.max(1, screen.size.columns - displayWidth(left) - displayWidth(right))
    return [`${left}${' '.repeat(gap)}${right}`]
  }

  const footerLines: string[] = [
    paint(theme, 'dim', 'enter send  alt+enter newline  tab complete  / commands  @ files  pgup/pgdn scroll'),
    paint(theme, 'dim', 'ctrl-c cancel/quit  ctrl-d quit  esc clear/close  /help keys'),
  ]

  const overlayLines = (): string[] => {
    const overlay = state.overlay
    if (overlay === null) return []
    const width = Math.max(28, Math.min(screen.size.columns - 4, 78))
    const inner = width - 4
    const lines: string[] = []
    const box = (title: string, body: string[]): string[] => {
      const top = `┌─ ${truncate(title, Math.max(1, width - 6))} ${'─'.repeat(Math.max(0, width - displayWidth(title) - 5))}┐`
      const content = body.map((line) => `│ ${pad(line, inner)} │`)
      const bottom = `└${'─'.repeat(width - 2)}┘`
      return [paint(theme, 'cyan', top), ...content, paint(theme, 'cyan', bottom)]
    }
    if (overlay.kind === 'help') {
      const body: string[] = []
      for (const [name, description] of COMMANDS) body.push(`${paint(theme, 'bold', pad(name, 14))} ${description}`)
      body.push('')
      body.push(paint(theme, 'dim', 'The TUI never owns the Agent: quitting only closes this view.'))
      return box('help', body)
    }
    if (overlay.kind === 'workspaces') {
      const visibleCount = Math.max(1, Math.min(10, screen.size.rows - 10))
      const start = Math.max(0, Math.min(overlay.index - Math.floor(visibleCount / 2), state.workspaces.length - visibleCount))
      const body = state.workspaces.slice(start, start + visibleCount).map((workspace, offset) => {
        const index = start + offset
        const marker = index === overlay.index ? '▸' : ' '
        return `${marker} ${truncate(workspace.title, 18)}  ${truncate(workspace.path, Math.max(8, inner - 24))}`
      })
      if (body.length === 0) body.push(paint(theme, 'dim', 'no workspaces'))
      body.push('', paint(theme, 'dim', '↑/↓ select  enter sessions  n new session  esc close'))
      return box('workspaces', body)
    }
    if (overlay.kind === 'sessions') {
      const sessions = filteredSessions(overlay.workspaceId)
      const visibleCount = Math.max(1, Math.min(10, screen.size.rows - 10))
      const start = Math.max(0, Math.min(overlay.index - Math.floor(visibleCount / 2), sessions.length - visibleCount))
      const body = sessions.slice(start, start + visibleCount).map((session, offset) => {
        const index = start + offset
        const marker = index === overlay.index ? '▸' : ' '
        const live = session.live === true ? 'live' : 'cold'
        const age = timeAgo(session.createdAt)
        return `${marker} ${session.sessionId.slice(0, 20)} ${pad(live, 4)} ${truncate(session.cwd ?? '', Math.max(6, inner - 34))} ${age}`
      })
      if (body.length === 0) body.push(paint(theme, 'dim', 'no sessions; press n to create one'))
      body.push('', paint(theme, 'dim', '↑/↓ select  enter attach  n new  esc close'))
      return box('sessions', body)
    }
    const pending = state.view?.pendingApproval
    if (pending === undefined) return box('approval', [paint(theme, 'dim', 'no approval pending')])
    const body = [
      paint(theme, 'bold', `tool: ${pending.toolName}`),
      `reason: ${truncate(pending.reason ?? '(no reason)', inner - 8)}`,
      `request: ${pending.requestId}`,
    ]
    if (overlay.details) {
      body.push('', paint(theme, 'dim', 'The full tool arguments are in the transcript above.'))
    }
    body.push('', paint(theme, 'yellow', '[a] allow once   [r] reject   [d] details   [esc] later'))
    body.push(paint(theme, 'dim', 'A timeout, disconnect, or non-TTY frontend fails closed.'))
    return box('approval required', body)
  }

  const startupLines = (): string[] => {
    const startup = state.startup
    if (startup === undefined) return []
    const width = Math.max(34, Math.min(screen.size.columns - 4, 86))
    const inner = width - 4
    const title = startup.kind === 'missing' ? 'workspace not created' : 'choose session'
    const body: string[] = []
    body.push(`${paint(theme, 'bold', 'directory')}  ${truncate(startup.cwd, Math.max(8, inner - 12))}`)
    if (startup.kind === 'missing') {
      body.push('')
      body.push(paint(theme, 'yellow', 'No workspace exists for this directory yet.'))
      body.push(paint(theme, 'dim', 'Create one now, or quit and cd to an existing workspace.'))
      body.push('')
      body.push(`${paint(theme, 'bold', 'c')} / ${paint(theme, 'bold', 'enter')}  create workspace + new session`)
      body.push(`${paint(theme, 'bold', 'q')} / ${paint(theme, 'bold', 'esc')}    quit without creating anything`)
    } else {
      const workspace = startup.workspace
      body.push(`${paint(theme, 'bold', 'workspace')}  ${truncate(workspace?.title ?? '', 28)}`)
      body.push(`${paint(theme, 'bold', 'path')}       ${truncate(workspace?.path ?? '', Math.max(8, inner - 12))}`)
      body.push('')
      body.push(paint(theme, 'bold', 'sessions'))
      if (startup.sessions.length === 0) {
        body.push(paint(theme, 'dim', '  (no sessions yet; press n to create one)'))
      } else {
        const visibleCount = Math.max(1, Math.min(10, screen.size.rows - 13))
        const start = Math.max(
          0,
          Math.min(startup.index - Math.floor(visibleCount / 2), startup.sessions.length - visibleCount),
        )
        for (const [offset, session] of startup.sessions.slice(start, start + visibleCount).entries()) {
          const index = start + offset
          const marker = index === startup.index ? '▸' : ' '
          const live = session.live === true ? 'live' : 'cold'
          const age = timeAgo(session.createdAt)
          const title = session.title?.trim()
          const label = title === undefined || title.length === 0 ? session.sessionId : title
          body.push(
            `${marker} ${pad(truncate(label, 24), 24)} ${pad(live, 4)} ${truncate(session.cwd ?? '', Math.max(6, inner - 40))} ${age}`,
          )
        }
      }
      body.push('')
      body.push(`${paint(theme, 'bold', '↑/↓')} select   ${paint(theme, 'bold', 'enter')} attach   ${paint(theme, 'bold', 'n')} new session   ${paint(theme, 'bold', 'q')} quit`)
    }
    const top = `┌─ ${truncate(title, Math.max(1, width - 6))} ${'─'.repeat(Math.max(0, width - displayWidth(title) - 5))}┐`
    const bottom = `└${'─'.repeat(width - 2)}┘`
    return [
      paint(theme, 'cyan', top),
      ...body.map((line) => `│ ${pad(line, inner)} │`),
      paint(theme, 'cyan', bottom),
    ]
  }

  const render = (): void => {
    if (state.quitting) return
    const { rows, columns } = screen.size
    const transcriptData = transcript()
    const overlay = overlayLines()
    let lines: string[] = []
    let cursor: { row: number; column: number } | undefined
    lines.push(...headerLines())
    lines.push(paint(theme, 'gray', '─'.repeat(columns)))
    if (state.startup !== undefined) {
      const panel = startupLines()
      const available = Math.max(4, rows - 4)
      const top = Math.max(0, Math.floor((available - panel.length) / 2))
      lines.push(...Array.from({ length: top }, () => ''))
      lines.push(...panel.slice(0, available))
      if (state.error !== undefined) lines.push('', paint(theme, 'red', `! ${state.error}`))
    } else if (overlay.length > 0) {
      const available = Math.max(4, rows - 4)
      const visible = overlay.slice(0, available)
      const top = Math.max(0, Math.floor((available - visible.length) / 2))
      lines.push(...Array.from({ length: top }, () => ''))
      lines.push(...visible)
      if (state.toast !== undefined && state.toast.until > Date.now()) lines.push('', paint(theme, 'yellow', state.toast.text))
      if (state.error !== undefined) lines.push(paint(theme, 'red', `! ${state.error}`))
    } else {
      const height = transcriptHeight()
      const visible = viewport.visible(transcriptData.lines, height)
      lines.push(...visible.lines)
      for (let index = visible.lines.length; index < height; index += 1) lines.push('')
      if (state.toast !== undefined && state.toast.until > Date.now()) {
        lines.push(paint(theme, 'yellow', truncate(state.toast.text, columns)))
      } else if (state.error !== undefined) {
        lines.push(paint(theme, 'red', truncate(`! ${state.error}`, columns)))
      } else {
        lines.push('')
      }
      const composerWidth = Math.max(1, columns - 4)
      const composer = composerLines(state.editor.text, composerWidth)
      const maxComposer = Math.min(7, composer.length)
      for (let index = 0; index < maxComposer; index += 1) {
        const prefix = index === 0 ? paint(theme, 'cyan', '❯ ') : '  '
        lines.push(`${prefix}${composer[index] ?? ''}`)
      }
      const footer = footerLines.slice(0, Math.max(0, rows - lines.length - 1))
      lines.push(...footer)
      const position = lineCol(state.editor.text, state.editor.cursor)
      const wrappedBefore = composerLines(state.editor.text.slice(0, state.editor.cursor), composerWidth)
      const visualLine = Math.max(0, Math.min(maxComposer - 1, wrappedBefore.length - 1))
      const visualColumn = displayWidth(wrappedBefore.at(-1) ?? '')
      const composerStart = lines.length - footer.length - maxComposer
      cursor = {
        row: composerStart + visualLine + 1,
        column: 3 + visualColumn,
      }
    }
    if (state.status !== 'idle' && state.status !== 'sending' && overlay.length === 0) {
      // Keep status in the header; the transient toast is enough for one-liners.
    }
    screen.draw(lines, cursor)
    if (state.toast !== undefined && state.toast.until <= Date.now()) state.toast = undefined
  }

  screen.onResizeRequest(() => schedule())
  screen.start()

  // Accept input before the first Host round-trip. A slow or broken Host must
  // never leave the user staring at an unresponsive alternate screen.
  input.setEncoding('utf8')
  input.on('data', onData)
  input.on('end', onEnd)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  render()

  try {
    await refreshSessions()
    const resume = options.resume
    if (resume !== undefined) {
      await openSession(resume)
    } else if (options.create === true) {
      await createSession(options.cwd, options.workspaceId)
    } else {
      prepareStartup()
    }
    state.status = 'idle'
    schedule()
    pollTimer = setInterval(() => {
      void refreshSessions()
    }, 5_000)
    const code = await done
    return code
  } finally {
    if (!state.quitting) quit(0)
    screen.stop()
  }
}

/** File completion candidates for @mentions, bounded and privacy-conscious. */
export function fileCandidates(cwd: string, prefix: string): string[] {
  const results: string[] = []
  const walk = (directory: string, relative: string, depth: number): void => {
    if (results.length >= 100 || depth > 2) return
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const nextRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), nextRelative, depth + 1)
      else if (entry.isFile() && nextRelative.startsWith(prefix)) results.push(nextRelative)
      if (results.length >= 100) return
    }
  }
  walk(cwd, '', 0)
  return results.slice(0, 8)
}

export function renderHelp(theme: Theme, width: number): string[] {
  return COMMANDS.flatMap(([name, description]) => wrapText(`${name}  ${description}`, width)).map((line) => paint(theme, 'dim', line))
}

export function blocksFor(events: SessionView['events'], verbose = false): Block[] {
  return buildBlocks(events, verbose)
}

export function sanitizeComposer(text: string): string {
  return sanitizeText(text)
}
