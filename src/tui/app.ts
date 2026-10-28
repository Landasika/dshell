import { readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import type { ReadStream, WriteStream } from 'node:tty'

import type {
  DshellBackend,
  ProviderList,
  SessionHandle,
  SessionSummary,
  SessionView,
  WorkspaceSummary,
} from '../backend/index.js'
import { BackendError } from '../backend/index.js'
import type {
  ModelCatalog,
  ModelOption,
  ModelSelection,
  ProviderEntry,
  ProviderField,
} from '../protocol/index.js'
import { KeyParser, type Key } from './keys.js'
import { COMMAND_SPECS, completionContext, completionFor, type CompletionItem, type CompletionState } from './completion.js'
import { createEditor, editKey, insertText, type EditorState } from './editor.js'
import { normalizePaste, pastePlaceholder, shouldFoldPaste } from './paste.js'
import {
  buildBlocks,
  isInjectedContext,
  renderBlocks,
  renderBlocksWithRanges,
  turnFailureMessage,
  type Block,
  type BlockRange,
} from './events.js'
import { foldInbox, type InboxState } from './inbox.js'
import { renderMarkdown } from './markdown.js'
import { TerminalScreen, Viewport } from './screen.js'
import { paint, type Theme, type ThemeStyle } from './theme.js'
import { createTheme } from './theme.js'
import { displayWidth, pad, sanitizeText, truncate, wrapText } from './width.js'
import {
  averageTps,
  collectMetrics,
  currentTps,
  estimateTokens,
  formatDuration,
  formatPercent,
  formatTokens,
  nextSpeedSample,
  todoCounts,
  type AgentInfo,
  type SessionMetrics,
  type TpsSample,
} from './metrics.js'
import { renderContextBar, renderContextLegendCompact } from './contextbar.js'
import {
  renderActivityLine,
  renderTpsGauge,
  renderTpsSparkline,
  renderTodoList,
  renderStatusStrip,
  renderTodoStrip,
  renderUsageRail,
} from './activity.js'
import { readGitInfo, type GitInfo } from './git.js'
import { createHerdrReporter, resumeCommand, type HerdrReporter, type HerdrState } from './herdr.js'
import {
  centerBlock,
  centerVertically,
  panelBox,
  renderComposer,
  renderHeader,
  renderHintLine,
  renderJumpToBottom,
} from './chrome.js'
import { formatCostCny } from './cost.js'
import { renderSplash, type SplashSession } from './splash.js'

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
  /** True until the Host answers the first workspace/session query. */
  loading?: boolean
}

type Overlay =
  | { kind: 'sessions'; index: number; workspaceId?: string }
  | { kind: 'workspaces'; index: number }
  | { kind: 'help' }
  | { kind: 'approval'; details: boolean }
  | { kind: 'history'; query: string; index: number }
  | { kind: 'rewind'; index: number }
  | { kind: 'dashboard' }
  | { kind: 'agents'; index: number }
  | { kind: 'models'; index: number }
  | { kind: 'effort'; provider: string; model: string; index: number; back: number }
  | { kind: 'providers'; index: number }
  | {
      kind: 'providerEdit'
      providerId: string
      index: number
      draft: Record<ProviderField, string>
      dirty: Set<ProviderField>
      editing?: { field: ProviderField; value: string }
    }
  | {
      kind: 'providerCreate'
      index: number
      draft: Record<ProviderCreateField, string>
      editing?: { field: ProviderCreateField; value: string }
    }
  | { kind: 'confirm'; title: string; lines: string[]; index: number; onYes: () => void }
  | { kind: 'agentView'; childId: string; label: string; lines: string[]; scroll: number; loading: boolean; error?: string }
  | { kind: 'detail'; title: string; lines: string[]; scroll: number }

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
  completion?: CompletionState
  pendingPrompt?: string
  quitting: boolean
  todosFolded: boolean
  tpsSamples: TpsSample[]
  speedPrevious?: { at: number; tokens: number }
  escapeAt: number
  /** Provider/model catalog loaded by `/model`. */
  modelCatalog?: ModelCatalog
  /** Optimistic selection until the next durable request header arrives. */
  modelOverride?: ModelSelection
  /** Last reasoning level picked per `provider/model`. */
  modelEfforts: Record<string, string>
  /** Prompts handed to the running turn, shown until they reach the transcript. */
  queued: { requestId: string; text: string; at: number; mode: 'queue' | 'steer' }[]
  /** Pending inbox folded from `agent/inbox/spliced` — every client's queue. */
  inbox: InboxState
  /** Rows this client removed, hidden until the Host confirms (or 5s pass). */
  hiddenQueued: Map<string, number>
  /** Text this client edited, shown until the splice carries it back. */
  queueText: Map<string, string>
  /** Index into the navigable transcript items (blocks, then queued rows). */
  focus?: number
  /** A queued prompt pulled back into the composer for editing. */
  editingQueued?: { requestId: string; text: string; mode: 'queue' | 'steer'; local: boolean }
  /** Provider rows read from the Host's patch file. */
  providers?: ProviderList
  /** Full content behind each folded paste placeholder in the composer. */
  attachments: Map<string, string>
  /** Monotonic counter for `[Pasted text #N …]` placeholders. */
  pasteSeq: number
}

/** One row under the transcript: a prompt waiting in the Host's inbox. */
interface QueueEntry {
  requestId: string
  text: string
  at: number
  mode: 'queue' | 'steer'
  /** True when only this client knows it yet (its splice has not landed). */
  local: boolean
}

const PROVIDER_FIELD_ORDER: readonly ProviderField[] = ['baseURL', 'apiKeyEnv', 'displayName']

const PROVIDER_CREATE_FIELDS = ['id', 'displayName', 'baseURL', 'apiKeyEnv', 'models'] as const
type ProviderCreateField = (typeof PROVIDER_CREATE_FIELDS)[number]

const PROVIDER_CREATE_HINTS: Record<ProviderCreateField, string> = {
  id: 'provider id, e.g. my-relay',
  displayName: 'shown in the picker (optional)',
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'env var name (optional)',
  models: 'model ids, comma or space separated',
}

const PROVIDER_FIELD_LABEL: Record<ProviderField, string> = {
  baseURL: 'baseURL',
  apiKeyEnv: 'apiKeyEnv',
  displayName: 'displayName',
}

interface ModelRow {
  kind: 'group' | 'model' | 'failure'
  provider?: string
  providerName?: string
  model?: ModelOption
  message?: string
  count?: number
}


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
  if (seconds < 10) return 'just now'
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
  // 1-based terminal row of the "jump to bottom" pill, for click hit-testing.
  let pillRow: number | null = null
  let agentHandle: SessionHandle | null = null
  let selectAnchor: { row: number; column: number } | null = null
  let lastTranscriptTotal = 0
  let seenTranscriptTotal = 0
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
    todosFolded: false,
    tpsSamples: [],
    escapeAt: 0,
    modelEfforts: {},
    queued: [],
    inbox: { nextTurn: [], nextStep: [] },
    hiddenQueued: new Map(),
    queueText: new Map(),
    attachments: new Map(),
    pasteSeq: 0,
  }

  let renderTimer: NodeJS.Timeout | undefined
  let escapeTimer: NodeJS.Timeout | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let tickTimer: NodeJS.Timeout | undefined
  let gitTimer: NodeJS.Timeout | undefined
  let gitInfo: GitInfo | undefined
  let gitCwd: string | undefined
  let gitFetchedAt = 0
  const herdrReporter: HerdrReporter | undefined = createHerdrReporter()
  let herdrResume: { id: string; argv: string[] | undefined } | undefined
  let metricsCache: { key: string; value: SessionMetrics } | undefined
  let lastBodyHeight = 3
  let reattaching = false
  let lastFailureToast: { text: string; at: number } = { text: '', at: 0 }
  let resolveDone: ((code: number) => void) | undefined
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve
  })

  /** Paint a full-width band behind a line, keeping its own colours intact. */
  const selectionBand = (line: string): string => {
    if (!theme.enabled) return line
    const background = '\u001b[48;5;237m'
    return `${background}${line.split(theme.reset).join(`${theme.reset}${background}`)}${theme.reset}`
  }

  const focusLabel = (item: FocusItem): string => {
    if (item.kind === 'queue') return `queued · ${item.queue?.text.replace(/\s+/g, ' ').slice(0, 40) ?? ''}`
    const block = item.block
    if (block === undefined) return 'block'
    if (block.kind === 'tool') return `tool · ${block.toolName ?? 'call'}`
    if (block.kind === 'notice') return block.title ?? 'notice'
    if (block.kind === 'user') return `you · ${block.body.replace(/\s+/g, ' ').slice(0, 40)}`
    if (block.kind === 'assistant') return `dshell · ${block.body.replace(/\s+/g, ' ').slice(0, 40)}`
    return block.kind
  }

  const schedule = (): void => {
    if (renderTimer !== undefined) return
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      render()
    }, 33)
  }

  const needsTick = (): boolean => {
    if (state.quitting) return false
    if (state.view?.status === 'running') return true
    if (state.view?.pendingApproval !== undefined) return true
    if (state.toast !== undefined && state.toast.until > Date.now()) return true
    return false
  }
  const ensureTick = (): void => {
    if (tickTimer !== undefined || !needsTick()) return
    tickTimer = setInterval(() => {
      if (!needsTick()) {
        if (tickTimer !== undefined) clearInterval(tickTimer)
    if (gitTimer !== undefined) clearInterval(gitTimer)
        tickTimer = undefined
        return
      }
      schedule()
    }, 110)
  }

  const toast = (text: string): void => {
    state.toast = { text, until: Date.now() + 4_000 }
    ensureTick()
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
    herdrReporter?.release()
    if (renderTimer !== undefined) clearTimeout(renderTimer)
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    if (pollTimer !== undefined) clearInterval(pollTimer)
    if (tickTimer !== undefined) clearInterval(tickTimer)
    if (gitTimer !== undefined) clearInterval(gitTimer)
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

  const sampleSpeed = (view: SessionView): void => {
    if (view.status !== 'running') {
      state.speedPrevious = undefined
      return
    }
    const now = Date.now()
    const next = nextSpeedSample(
      state.tpsSamples,
      state.speedPrevious,
      now,
      estimateTokens(view.streamText),
    )
    state.tpsSamples = next.samples
    state.speedPrevious = next.previous
  }

  const currentMetrics = (): SessionMetrics => {
    const view = state.view
    if (view === undefined) return collectMetrics(undefined)
    const key = `${view.sessionId}:${view.cursor}:${view.streamText.length}:${view.status}:${view.pendingApproval?.requestId ?? ''}:${state.clearedAtSeq}`
    if (metricsCache?.key !== key) metricsCache = { key, value: collectMetrics(view) }
    return metricsCache.value
  }

  const refreshGit = (): void => {
    const cwd = state.view?.header.cwd ?? options.cwd
    if (cwd === gitCwd && Date.now() - gitFetchedAt < 3000) return
    gitCwd = cwd
    gitFetchedAt = Date.now()
    void readGitInfo(cwd).then((info) => {
      if (gitCwd !== cwd) return
      gitInfo = info
      schedule()
    })
  }

  const reportHerdr = (view: SessionView | undefined, override?: HerdrState): void => {
    if (herdrReporter === undefined) return
    let resume: string[] | undefined
    if (view !== undefined) {
      if (herdrResume?.id !== view.sessionId) {
        herdrResume = { id: view.sessionId, argv: resumeCommand(view.sessionId) }
      }
      resume = herdrResume.argv
    }
    const session = view === undefined
      ? {}
      : { sessionId: view.sessionId, ...(resume === undefined ? {} : { resumeArgv: resume }) }
    const approval = view?.pendingApproval
    if (override !== undefined) {
      herdrReporter.update({ state: override, ...session })
      return
    }
    if (approval !== undefined) {
      const tool = approval.toolName ?? 'tool'
      herdrReporter.update({ state: 'blocked', message: `${tool} needs a decision`, ...session })
      return
    }
    herdrReporter.update({ state: view?.status === 'running' ? 'working' : 'idle', ...session })
  }

  /** Drop queued prompts once the transcript shows them (or the Host dropped them). */
  const pruneQueued = (view: SessionView): void => {
    if (state.queued.length === 0) return
    const started = new Set<string>()
    for (const event of view.events) {
      if (event.type !== 'user/message') continue
      const data = (event.data ?? {}) as Record<string, unknown>
      const message = (data.message ?? data) as Record<string, unknown>
      const id = message.id
      if (typeof id === 'string' && id.length > 0) started.add(id)
    }
    const now = Date.now()
    state.queued = state.queued.filter((entry) => {
      if (started.has(entry.requestId)) return false
      // Idle for a few seconds without the prompt starting means the Host
      // discarded it (a cancel with the inbox dropped); stop showing it.
      return view.status === 'running' || now - entry.at < 5_000
    })
  }

  /**
   * Rows shown below the transcript: the durable inbox first (so prompts queued
   * by another terminal or the Web UI show up too), then any local prompt whose
   * splice has not arrived yet. Steering rows come before queued ones because
   * they land sooner.
   */
  const queuedEntries = (): QueueEntry[] => {
    const entries: QueueEntry[] = []
    const seen = new Set<string>()
    const editing = state.editingQueued?.requestId
    const push = (entry: QueueEntry): void => {
      if (entry.requestId === editing) return
      seen.add(entry.requestId)
      entries.push(entry)
    }
    const hidden = (id: string): boolean => {
      const at = state.hiddenQueued.get(id)
      return at !== undefined && Date.now() - at < 5_000
    }
    for (const item of state.inbox.nextStep) {
      if (hidden(item.id)) continue
      push({ requestId: item.id, text: state.queueText.get(item.id) ?? item.text, at: 0, mode: 'steer', local: false })
    }
    for (const item of state.inbox.nextTurn) {
      if (hidden(item.id)) continue
      push({ requestId: item.id, text: state.queueText.get(item.id) ?? item.text, at: 0, mode: 'queue', local: false })
    }
    for (const entry of state.queued) {
      if (seen.has(entry.requestId) || hidden(entry.requestId)) continue
      push({ ...entry, local: true })
    }
    return entries
  }

  const applyView = (view: SessionView): void => {
    state.view = view
    state.currentId = view.sessionId
    reportHerdr(view)
    refreshGit()
    // Surface a failed turn in the header and as a toast, not only inline.
    // A retrying provider can fail with the same message every few seconds;
    // toasting each one turns the header into a flicker, so throttle repeats.
    const failure = turnFailureMessage(view.events)
    if (failure !== undefined && failure !== state.error) {
      state.error = failure
      const now = Date.now()
      if (failure !== lastFailureToast.text || now - lastFailureToast.at > 30_000) {
        lastFailureToast = { text: failure, at: now }
        toast(`turn failed: ${failure.length > 80 ? `${failure.slice(0, 80)}…` : failure}`)
      }
    }
    state.inbox = foldInbox(view.events)
    const live = new Set([...state.inbox.nextTurn, ...state.inbox.nextStep].map((item) => item.id))
    for (const [id, at] of state.hiddenQueued) {
      if (!live.has(id) || Date.now() - at > 5_000) state.hiddenQueued.delete(id)
    }
    for (const [id, text] of state.queueText) {
      const item = [...state.inbox.nextTurn, ...state.inbox.nextStep].find((entry) => entry.id === id)
      if (item === undefined || item.text === text) state.queueText.delete(id)
    }
    pruneQueued(view)
    sampleSpeed(view)
    if (view.pendingApproval !== undefined) {
      if (state.overlay?.kind !== 'approval') state.overlay = { kind: 'approval', details: false }
    } else if (state.overlay?.kind === 'approval') {
      state.overlay = null
    }
    ensureTick()
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
      state.error = undefined
      state.modelOverride = undefined
      applyView(next.snapshot())
      // Seed arrow history from the durable transcript so prompts sent before
      // this TUI attached can be recalled, not just the ones typed here.
      state.history = userPrompts().reverse().slice(-100)
      state.historyIndex = -1
      const off = next.subscribe((view) => applyView(view))
      // A disposed handle drops its listeners; keep the disposer out of the
      // state to avoid an extra public field on the app object.
      void off
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

  const refreshWorkspaces = async (): Promise<void> => {
    try {
      state.workspaces = await backend.listWorkspaces()
      schedule()
    } catch (error) {
      state.error = errorText(error)
      schedule()
    }
  }

  // Scope enumeration to one workspace when possible: a shared DSH home can
  // hold hundreds of sessions, and titles only need resolving for the rows the
  // picker will actually show.
  const refreshSessions = async (workspaceId?: string): Promise<void> => {
    try {
      const sessions = await backend.listSessions(workspaceId)
      // Most recently edited first, whichever time the backend could provide.
      state.sessions = [...sessions].sort(
        (left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
      )
      schedule()
    } catch (error) {
      // A dropped socket is handled by the reconnect loop; do not paint a
      // permanent "connection is closed" error over the transcript.
      if (!backend.connected) return
      state.error = errorText(error)
      schedule()
    }
  }

  const workspaceIdForCwd = (cwd: string): string | undefined => {
    const workspace = findWorkspaceForCwd(state.workspaces, cwd)
    if (workspace !== undefined) return workspace.id
    const view = state.view
    if (view === undefined) return undefined
    return findWorkspaceForCwd(state.workspaces, canonicalPath(view.header.cwd ?? options.cwd))?.id
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
      void refreshSessions(workspaceIdForCwd(canonicalPath(view.header.cwd ?? options.cwd)))
      toast(`created ${view.sessionId}`)
    } catch (error) {
      state.error = errorText(error)
      state.status = 'error'
      schedule()
    }
  }

  const prepareStartup = async (): Promise<void> => {
    const cwd = canonicalPath(options.cwd)
    if (state.workspaces.length === 0) await refreshWorkspaces()
    const workspace = findWorkspaceForCwd(state.workspaces, cwd)
    if (workspace === undefined) {
      state.startup = { kind: 'missing', cwd, sessions: [], index: 0 }
      schedule()
      return
    }
    await refreshSessions(workspace.id)
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

  /** Substitute folded paste placeholders with their stored full content. */
  const expandAttachments = (text: string): string => {
    let out = text
    for (const [placeholder, content] of state.attachments) {
      if (out.includes(placeholder)) out = out.split(placeholder).join(content)
    }
    return out
  }

  const send = async (text: string, requested?: 'queue' | 'steer'): Promise<void> => {
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
    const wasRunning = state.view?.status === 'running'
    // Enter steers by default (the Host folds the text into the running turn,
    // like Claude Code); Alt+Q asks for the inbox instead.
    const mode = requested ?? (wasRunning ? 'steer' : 'queue')
    reportHerdr(state.view, 'working')
    schedule()
    try {
      const receipt = await state.handle.send(expandAttachments(trimmed), { mode })
      if (wasRunning) {
        // The transcript only shows the message once the Host delivers it, so
        // keep it visible until its user/message arrives.
        state.queued.push({ requestId: receipt.requestId, text: trimmed, at: Date.now(), mode: receipt.mode ?? mode })
      }
      state.status = 'waiting for turn'
    } catch (error) {
      state.error = errorText(error)
      state.status = 'error'
    }
    schedule()
  }

  const cancel = async (): Promise<void> => {
    if (state.handle === undefined) return
    // The Host drops its inbox together with the aborted turn, so keep our own
    // copy and hand it back right away: the queued prompts then start as soon
    // as the abort settles, which is what Ctrl-C should mean.
    const pendingById = new Map<string, string>()
    for (const entry of state.queued) pendingById.set(entry.requestId, entry.text)
    for (const item of [...state.inbox.nextStep, ...state.inbox.nextTurn]) {
      if (!pendingById.has(item.id)) pendingById.set(item.id, item.text)
    }
    const pending = [...pendingById.values()]
    state.queued = []
    state.inbox = { nextTurn: [], nextStep: [] }
    try {
      await state.handle.cancel()
      state.status = 'cancelling'
      toast(
        pending.length === 0
          ? 'cancel requested; the Host decides when the turn stops'
          : `cancelled this turn; ${String(pending.length)} queued prompt${pending.length === 1 ? ' continues' : 's continue'}`,
      )
    } catch (error) {
      state.error = errorText(error)
    }
    for (const text of pending) {
      try {
        const receipt = await state.handle.send(expandAttachments(text), { mode: 'queue' })
        state.queued.push({ requestId: receipt.requestId, text, at: Date.now(), mode: 'queue' })
      } catch (error) {
        state.error = errorText(error)
      }
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

  const modelRows = (): ModelRow[] => {
    const catalog = state.modelCatalog
    if (catalog === undefined) return []
    const rows: ModelRow[] = []
    for (const group of catalog.groups) {
      rows.push({ kind: 'group', provider: group.id, providerName: group.name, count: group.models.length })
      for (const model of group.models) {
        rows.push({ kind: 'model', provider: group.id, providerName: group.name, model })
      }
    }
    for (const failure of catalog.failures) {
      rows.push({ kind: 'failure', provider: failure.id, providerName: failure.name, message: failure.message })
    }
    return rows
  }

  const currentModel = (): ModelSelection | undefined => {
    if (state.modelOverride !== undefined) return state.modelOverride
    const metrics = currentMetrics()
    if (metrics.provider !== undefined && metrics.model !== undefined) {
      return { provider: metrics.provider, model: metrics.model }
    }
    return state.modelCatalog?.default
  }

  const modelRowFor = (selection: ModelSelection | undefined): number => {
    if (selection === undefined) return -1
    return modelRows().findIndex((row) => row.kind === 'model'
      && row.provider === selection.provider
      && row.model?.id === selection.model)
  }

  const nearestModelRow = (from: number, delta: number): number => {
    const rows = modelRows()
    let index = from
    for (let step = 0; step < rows.length; step += 1) {
      index += delta
      if (index < 0) index = rows.length - 1
      if (index >= rows.length) index = 0
      if (rows[index]?.kind === 'model') return index
    }
    return from
  }

  const openModelPicker = async (): Promise<void> => {
    if (!backend.capabilities().models) {
      toast('this Host cannot list models (update dshell-host)')
      return
    }
    state.status = 'loading models'
    schedule()
    try {
      state.modelCatalog = await backend.modelCatalog()
    } catch (error) {
      state.status = 'idle'
      toast(`model catalog failed: ${errorText(error)}`)
      schedule()
      return
    }
    state.status = 'idle'
    const found = modelRowFor(currentModel())
    const firstModel = modelRows().findIndex((row) => row.kind === 'model')
    state.overlay = { kind: 'models', index: found >= 0 ? found : Math.max(0, firstModel) }
    schedule()
  }

  const effortKey = (provider: string, model: string): string => `${provider}/${model}`

  /** The level a switch would send: last explicit pick, else the catalog default. */
  const effortFor = (row: ModelRow): string | undefined => {
    const reasoning = row.model?.reasoning
    if (reasoning === undefined || row.provider === undefined || row.model === undefined) return undefined
    const candidates = reasoning.efforts
    if (candidates.length === 0) return undefined
    const remembered = state.modelEfforts[effortKey(row.provider, row.model.id)]
    const fallback = reasoning.defaultEffort ?? candidates[0]?.id
    if (remembered !== undefined && candidates.some((effort) => effort.id === remembered)) return remembered
    return fallback
  }

  const hasEfforts = (row: ModelRow): boolean => (row.model?.reasoning?.efforts.length ?? 0) > 0

  const modelRowById = (provider: string, modelId: string): ModelRow | undefined =>
    modelRows().find((row) => row.kind === 'model' && row.provider === provider && row.model?.id === modelId)

  const applyModel = async (row: ModelRow, effort?: string): Promise<void> => {
    const view = state.view
    const model = row.model
    if (view === undefined || row.provider === undefined || model === undefined) {
      toast('attach a session before switching models')
      return
    }
    const reasoningEffort = hasEfforts(row) ? effort ?? effortFor(row) : undefined
    state.status = 'switching model'
    schedule()
    try {
      const selected = await backend.selectModel(view.sessionId, {
        provider: row.provider,
        model: model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      state.modelOverride = selected
      if (selected.reasoningEffort !== undefined) {
        state.modelEfforts[effortKey(selected.provider, selected.model)] = selected.reasoningEffort
      }
      if (state.modelCatalog !== undefined) state.modelCatalog.default = selected
      state.overlay = null
      const level = selected.reasoningEffort === undefined ? '' : ` · ${selected.reasoningEffort}`
      const note = hasEfforts(row) || selected.reasoningEffort !== undefined ? '' : ' (no reasoning levels)'
      toast(`model → ${selected.provider}/${selected.model}${level}${note}`)
    } catch (error) {
      toast(`model switch failed: ${errorText(error)}`)
    } finally {
      state.status = 'idle'
      schedule()
    }
  }

  const saveModelDefault = async (row: ModelRow, effort?: string): Promise<void> => {
    const model = row.model
    if (row.provider === undefined || model === undefined) return
    const reasoningEffort = hasEfforts(row) ? effort ?? effortFor(row) : undefined
    try {
      const selected = await backend.saveDefaultModel({
        provider: row.provider,
        model: model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      if (selected.reasoningEffort !== undefined) {
        state.modelEfforts[effortKey(selected.provider, selected.model)] = selected.reasoningEffort
      }
      if (state.modelCatalog !== undefined) state.modelCatalog.default = selected
      const level = selected.reasoningEffort === undefined ? '' : ` · ${selected.reasoningEffort}`
      toast(`default model → ${selected.provider}/${selected.model}${level}`)
    } catch (error) {
      toast(`default model failed: ${errorText(error)}`)
    }
    schedule()
  }

  /**
   * Codex-style two-step pick: a model that declares reasoning levels opens a
   * level list instead of switching immediately. Enter on a level commits both
   * the model and the level in one `model/select`.
   */
  const openEffortPicker = (row: ModelRow): void => {
    const provider = row.provider
    const model = row.model
    if (provider === undefined || model === undefined) return
    if (!hasEfforts(row)) {
      void applyModel(row)
      return
    }
    const efforts = model.reasoning?.efforts ?? []
    const current = effortFor(row)
    const index = Math.max(0, efforts.findIndex((effort) => effort.id === current))
    const back = state.overlay?.kind === 'models' ? state.overlay.index : 0
    state.overlay = { kind: 'effort', provider, model: model.id, index, back }
    schedule()
  }

  const reopenModelPicker = (index: number): void => {
    if (state.modelCatalog === undefined) {
      state.overlay = null
      schedule()
      return
    }
    const rows = modelRows()
    const bounded = Math.max(0, Math.min(rows.length - 1, index))
    state.overlay = { kind: 'models', index: bounded }
    schedule()
  }

  const restartHost = async (): Promise<void> => {
    if (reattaching) return
    reattaching = true
    state.status = 'restarting host'
    schedule()
    try {
      await backend.restartHost()
      state.overlay = null
      toast('host restarting… reattaching')
      schedule()
      await reattachAfterRestart()
    } catch (error) {
      state.status = 'idle'
      toast(`host restart failed: ${errorText(error)}`)
      schedule()
    } finally {
      reattaching = false
    }
  }

  /**
   * A Host that reloads its plugin (config edit) or exits drops the socket
   * under us. Reattach instead of making every later command fail with
   * "connection is closed".
   */
  const beginReconnect = (): void => {
    if (reattaching || state.quitting) return
    reattaching = true
    toast('host connection lost · reconnecting')
    schedule()
    void reattachAfterRestart().finally(() => {
      reattaching = false
    })
  }

  /** Poll the socket until the re-exec'd Host answers, then reopen the session. */
  const reattachAfterRestart = async (): Promise<void> => {
    const sessionId = state.currentId
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        await backend.disconnect().catch(() => {})
        await backend.connect()
      } catch {
        continue
      }
      if (sessionId === undefined) {
        toast('host back')
        state.status = 'idle'
        schedule()
        return
      }
      try {
        state.handle?.dispose()
      } catch {
        // Already disposed by the backend when the socket went away.
      }
      state.handle = undefined
      state.view = undefined
      await openSession(sessionId)
      if (state.view !== undefined) {
        state.status = 'idle'
        state.error = undefined
        toast('host back · reattached')
        schedule()
        return
      }
    }
    state.status = 'idle'
    toast('host did not come back; start it again and use /reconnect')
    schedule()
  }

  const openProviderList = async (): Promise<void> => {
    if (!backend.capabilities().providers) {
      toast('this Host cannot read providers (restart a fresh dshell-host)')
      schedule()
      return
    }
    state.status = 'loading providers'
    schedule()
    try {
      state.providers = await backend.providerList()
    } catch (error) {
      state.status = 'idle'
      toast(`provider list failed: ${errorText(error)}`)
      schedule()
      return
    }
    state.status = 'idle'
    state.overlay = { kind: 'providers', index: 0 }
    schedule()
  }

  const openProviderEditor = (entry: ProviderEntry): void => {
    state.overlay = {
      kind: 'providerEdit',
      providerId: entry.id,
      index: 0,
      draft: {
        baseURL: entry.baseURL ?? '',
        apiKeyEnv: entry.apiKeyEnv ?? '',
        displayName: entry.displayName ?? '',
      },
      dirty: new Set<ProviderField>(),
    }
    schedule()
  }

  const saveProvider = async (overlay: Extract<Overlay, { kind: 'providerEdit' }>): Promise<void> => {
    const fields = PROVIDER_FIELD_ORDER.filter((field) => overlay.dirty.has(field))
    if (fields.length === 0) {
      state.overlay = { kind: 'providers', index: providerIndex(overlay.providerId) }
      toast('no provider changes')
      schedule()
      return
    }
    state.status = 'saving provider'
    schedule()
    try {
      for (const field of fields) {
        state.providers = await backend.updateProvider(overlay.providerId, field, overlay.draft[field])
      }
      const file = state.providers?.file ?? 'cordis.patch.yml'
      state.overlay = {
        kind: 'confirm',
        title: `provider · ${overlay.providerId}`,
        lines: [
          `saved ${fields.join(', ')} to`,
          file,
          '',
          'A running Host keeps the providers it booted with.',
          'Restart it now to load this change?',
        ],
        index: 0,
        onYes: () => {
          void restartHost()
        },
      }
    } catch (error) {
      toast(`provider save failed: ${errorText(error)}`)
      state.overlay = { kind: 'providers', index: providerIndex(overlay.providerId) }
    } finally {
      state.status = 'idle'
      schedule()
    }
  }

  const submitNewProvider = async (overlay: Extract<Overlay, { kind: 'providerCreate' }>): Promise<void> => {
    const id = overlay.draft.id.trim()
    const baseURL = overlay.draft.baseURL.trim()
    const displayName = overlay.draft.displayName.trim()
    const apiKeyEnv = overlay.draft.apiKeyEnv.trim()
    const models = overlay.draft.models.split(/[\s,]+/).map((model) => model.trim()).filter((model) => model.length > 0)
    if (id.length === 0) {
      toast('provider id is required')
      return
    }
    if (!/^https?:\/\/[^\s]+$/.test(baseURL)) {
      toast('baseURL must be an absolute http(s) URL')
      return
    }
    if (models.length === 0) {
      toast('add at least one model id')
      return
    }
    state.status = 'adding provider'
    schedule()
    try {
      state.providers = await backend.createProvider({
        id,
        baseURL,
        models,
        ...(displayName.length === 0 ? {} : { displayName }),
        ...(apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
      })
    } catch (error) {
      state.status = 'idle'
      toast(`provider add failed: ${errorText(error)}`)
      schedule()
      return
    }
    state.status = 'idle'
    const file = state.providers?.file ?? 'cordis.patch.yml'
    state.overlay = {
      kind: 'confirm',
      title: `add provider · ${id}`,
      lines: [
        `added ${id} with ${String(models.length)} model(s) to`,
        file,
        '',
        'A running Host keeps the providers it booted with.',
        'Restart it now to load this provider?',
      ],
      index: 0,
      onYes: () => {
        void restartHost()
      },
    }
    schedule()
  }

  const deleteProviderRow = async (providerId: string): Promise<void> => {
    state.status = 'removing provider'
    schedule()
    try {
      state.providers = await backend.deleteProvider(providerId)
    } catch (error) {
      state.status = 'idle'
      toast(`provider remove failed: ${errorText(error)}`)
      schedule()
      return
    }
    state.status = 'idle'
    const file = state.providers?.file ?? 'cordis.patch.yml'
    state.overlay = {
      kind: 'confirm',
      title: `remove provider · ${providerId}`,
      lines: [
        `removed ${providerId} from`,
        file,
        '',
        'A running Host keeps the providers it booted with.',
        'Restart it now to drop it?',
      ],
      index: 0,
      onYes: () => {
        void restartHost()
      },
    }
    schedule()
  }

  const providerIndex = (providerId: string): number => {
    const rows = state.providers?.providers ?? []
    const index = rows.findIndex((row) => row.id === providerId)
    return index < 0 ? 0 : index
  }

  const switchModel = async (argument: string): Promise<void> => {
    const trimmed = argument.trim()
    if (trimmed.length === 0) {
      await openModelPicker()
      return
    }
    const wantsDefault = /^default\s+/i.test(trimmed)
    const spec = wantsDefault ? trimmed.replace(/^default\s+/i, '') : trimmed
    const slash = spec.indexOf('/')
    if (slash <= 0 || slash === spec.length - 1) {
      toast('use /model provider/model, or /model default provider/model')
      return
    }
    const provider = spec.slice(0, slash)
    const modelId = spec.slice(slash + 1)
    // Prefer the catalog row so a direct `/model p/m` keeps the model's
    // reasoning levels and its remembered default.
    const row: ModelRow = modelRowById(provider, modelId) ?? {
      kind: 'model',
      provider,
      model: { id: modelId, name: modelId },
    }
    if (wantsDefault) await saveModelDefault(row)
    else await applyModel(row)
  }

  const userPrompts = (): string[] => {
    const view = state.view
    if (view === undefined) return [...state.history].reverse()
    const out: string[] = []
    for (let index = view.events.length - 1; index >= 0; index -= 1) {
      const event = view.events[index]
      if (event?.type !== 'user/message') continue
      const data = (event.data ?? {}) as Record<string, unknown>
      const message = (data.message ?? data) as Record<string, unknown>
      const source = (message.source ?? {}) as Record<string, unknown>
      if (source.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      let text = ''
      for (const part of content) {
        const item = (part ?? {}) as Record<string, unknown>
        if (item.type === 'text' && typeof item.text === 'string') text += item.text
      }
      text = text.trim()
      if (text.length > 0 && !isInjectedContext(text) && out.at(-1) !== text) out.push(text)
    }
    return out
  }

  const historyItems = (query: string): string[] => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: string[] = []
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      const item = state.history[index]
      if (item === undefined || seen.has(item)) continue
      if (needle.length > 0 && !item.toLowerCase().includes(needle)) continue
      seen.add(item)
      out.push(item)
    }
    return out
  }

  const openHistory = (): void => {
    state.overlay = { kind: 'history', query: '', index: 0 }
    schedule()
  }

  const openRewind = (): void => {
    if (userPrompts().length === 0) {
      toast('no previous prompt to restore')
      return
    }
    state.overlay = { kind: 'rewind', index: 0 }
    schedule()
  }

  const closeAgentView = (): void => {
    agentHandle?.dispose()
    agentHandle = null
  }

  const openAgents = (): void => {
    if (state.view === undefined) {
      toast('attach a session first')
      return
    }
    const agents = currentMetrics().agents
    if (agents.length === 0) {
      toast('no subagents in this session yet')
      return
    }
    state.overlay = { kind: 'agents', index: 0 }
    schedule()
  }

  const openAgentView = async (agent: AgentInfo): Promise<void> => {
    closeAgentView()
    state.overlay = { kind: 'agentView', childId: agent.agentId, label: agent.label, lines: [], scroll: 0, loading: true }
    schedule()
    try {
      const handle = await backend.openSession(agent.agentId)
      agentHandle = handle
      const view = handle.snapshot()
      const width = Math.max(24, screen.size.columns - 6)
      const blocks = buildBlocks(view.events, false).filter((block) => block.kind !== 'todo')
      const lines = renderBlocks(blocks, width, theme)
      const current = state.overlay
      if (current !== null && current.kind === 'agentView' && current.childId === agent.agentId) {
        state.overlay = { ...current, lines, loading: false }
      }
    } catch (error) {
      const current = state.overlay
      if (current !== null && current.kind === 'agentView' && current.childId === agent.agentId) {
        state.overlay = { ...current, loading: false, error: errorText(error) }
      }
    }
    schedule()
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
      case '/session':
      case '/resume':
        state.status = 'listing sessions'
        schedule()
        await refreshSessions()
        state.status = 'idle'
        state.overlay = { kind: 'sessions', index: 0 }
        schedule()
        return
      case '/workspaces':
        state.status = 'listing sessions'
        schedule()
        await refreshSessions()
        state.status = 'idle'
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
      case '/rewind':
        openRewind()
        return
      case '/history':
        openHistory()
        return
      case '/panel':
      case '/status':
        state.overlay = { kind: 'dashboard' }
        schedule()
        return
      case '/agents':
        openAgents()
        return
      case '/model':
        await switchModel(argument)
        return
      case '/provider':
      case '/providers':
        await openProviderList()
        return
      default:
        toast(`unknown command ${command}; try /help`)
    }
  }

  const refreshCompletion = (): void => {
    const text = state.editor.text
    const context = completionContext(text)
    const files = context?.kind === 'file' ? fileCandidates(options.cwd, context.query) : []
    state.completion = completionFor(text, files) ?? undefined
  }

  const acceptCompletion = (execute: boolean): void => {
    const completion = state.completion
    if (completion === undefined) return
    const item: CompletionItem | undefined = completion.items[completion.index]
    if (item === undefined) return
    const text = state.editor.text
    const inserted = `${text.slice(0, completion.context.start)}${item.insert}${text.slice(completion.context.end)}`
    state.editor = createEditor(inserted)
    state.historyIndex = -1
    state.completion = undefined
    if (execute && item.kind === 'command' && item.execute !== undefined) {
      state.editor = createEditor()
      void runCommand(item.execute)
      return
    }
    refreshCompletion()
    schedule()
  }


  const acceptEditorText = (text: string): void => {
    state.editor = createEditor(text)
    state.historyIndex = -1
    state.completion = undefined
    state.overlay = null
    refreshCompletion()
    schedule()
  }

  const handleOverlayKey = (rawKey: Key): void => {
    // Some terminals (and Shift+Enter) send LF where the rest of the app means
    // "confirm". Inside a picker both should commit, so alias them here.
    const key: Key = rawKey.type === 'newline' || rawKey.type === 'alt-enter' ? { type: 'enter' } : rawKey
    const overlay = state.overlay
    if (overlay === null) return
    if (key.type === 'escape') {
      if (overlay.kind === 'approval') {
        toast('approval still pending; answer with a/r or wait for the timeout')
      } else if (overlay.kind === 'effort') {
        reopenModelPicker(overlay.back)
      } else if (overlay.kind === 'providerEdit' && overlay.editing !== undefined) {
        overlay.editing = undefined
      } else if (overlay.kind === 'providerEdit') {
        state.overlay = { kind: 'providers', index: providerIndex(overlay.providerId) }
      } else if (overlay.kind === 'providerCreate') {
        state.overlay = { kind: 'providers', index: Math.max(0, (state.providers?.providers.length ?? 1) - 1) }
      } else {
        if (overlay.kind === 'agentView') closeAgentView()
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
    if (overlay.kind === 'agents') {
      const agents = currentMetrics().agents
      const delta = key.type === 'up' || key.type === 'ctrl-p' ? -1 : key.type === 'down' || key.type === 'ctrl-n' ? 1 : key.type === 'wheel' ? key.delta : 0
      if (delta !== 0) {
        overlay.index = Math.max(0, Math.min(Math.max(0, agents.length - 1), overlay.index + delta))
      } else if (key.type === 'enter' || key.type === 'tab') {
        const chosen = agents[overlay.index]
        if (chosen !== undefined) void openAgentView(chosen)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'agentView') {
      const lines = overlay.lines.length
      const height = Math.max(4, lastBodyHeight)
      const step = key.type === 'wheel' ? key.delta * 3 : 0
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.scroll = Math.max(0, overlay.scroll - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') overlay.scroll = Math.min(Math.max(0, lines - 1), overlay.scroll + 1)
      else if (key.type === 'page-up') overlay.scroll = Math.max(0, overlay.scroll - height)
      else if (key.type === 'page-down') overlay.scroll = Math.min(Math.max(0, lines - 1), overlay.scroll + height)
      else if (key.type === 'wheel') overlay.scroll = Math.max(0, Math.min(Math.max(0, lines - 1), overlay.scroll - step))
      else if (key.type === 'backspace') {
        closeAgentView()
        state.overlay = { kind: 'agents', index: 0 }
      }
      schedule()
      return
    }
    if (overlay.kind === 'detail') {
      const total = overlay.lines.length
      const height = Math.max(4, lastBodyHeight)
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.scroll = Math.max(0, overlay.scroll - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') overlay.scroll = Math.min(Math.max(0, total - 1), overlay.scroll + 1)
      else if (key.type === 'page-up') overlay.scroll = Math.max(0, overlay.scroll - height)
      else if (key.type === 'page-down') overlay.scroll = Math.min(Math.max(0, total - 1), overlay.scroll + height)
      schedule()
      return
    }
    if (overlay.kind === 'dashboard') {
      if (key.type === 'ctrl-b') state.overlay = null
      schedule()
      return
    }
    if (overlay.kind === 'rewind') {
      const prompts = userPrompts()
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = Math.min(Math.max(0, prompts.length - 1), overlay.index + 1)
      } else if (key.type === 'enter' || key.type === 'tab') {
        const chosen = prompts[overlay.index]
        if (chosen !== undefined) acceptEditorText(chosen)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'history') {
      if (key.type === 'text') {
        overlay.query += key.text
        overlay.index = 0
      } else if (key.type === 'paste') {
        overlay.query += key.text.replace(/\s+/g, ' ')
        overlay.index = 0
      } else if (key.type === 'backspace') {
        const characters = Array.from(overlay.query)
        characters.pop()
        overlay.query = characters.join('')
        overlay.index = 0
      } else if (key.type === 'up' || key.type === 'ctrl-p') {
        overlay.index = Math.max(0, overlay.index - 1)
      } else if (key.type === 'down' || key.type === 'ctrl-n') {
        const items = historyItems(overlay.query)
        overlay.index = Math.min(Math.max(0, items.length - 1), overlay.index + 1)
      } else if (key.type === 'enter' || key.type === 'tab') {
        const items = historyItems(overlay.query)
        const chosen = items[overlay.index]
        if (chosen !== undefined) acceptEditorText(chosen)
        return
      } else if (key.type === 'ctrl-r') {
        state.overlay = null
      }
      schedule()
      return
    }
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
    if (overlay.kind === 'models') {
      const row = modelRows()[overlay.index]
      if (key.type === 'up' || key.type === 'ctrl-p' || key.type === 'wheel') {
        const delta = key.type === 'wheel' ? key.delta : -1
        overlay.index = nearestModelRow(overlay.index, delta)
      } else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = nearestModelRow(overlay.index, 1)
      } else if (key.type === 'enter' || key.type === 'tab' || key.type === 'right') {
        if (row?.kind === 'model') {
          if (hasEfforts(row)) openEffortPicker(row)
          else void applyModel(row)
        } else if (row?.kind === 'group') {
          // A provider header is not selectable; Enter jumps to its first model
          // so the key is never a silent no-op.
          const next = modelRows().findIndex(
            (candidate) => candidate.kind === 'model' && candidate.provider === row.provider,
          )
          if (next >= 0) overlay.index = next
        } else if (row?.kind === 'failure') {
          toast(`provider ${row.providerName ?? row.provider ?? ''} unavailable: ${row.message ?? 'no route'}`)
        }
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'e') {
        if (row?.kind === 'model') openEffortPicker(row)
        else if (row?.kind === 'group') {
          const next = modelRows().findIndex(
            (candidate) => candidate.kind === 'model' && candidate.provider === row.provider,
          )
          if (next >= 0) overlay.index = next
          schedule()
        } else if (row?.kind === 'failure') {
          toast(`provider ${row.providerName ?? row.provider ?? ''} unavailable: ${row.message ?? 'no route'}`)
        }
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'd') {
        if (row?.kind === 'model') void saveModelDefault(row)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'effort') {
      const row = modelRowById(overlay.provider, overlay.model)
      const efforts = row?.model?.reasoning?.efforts ?? []
      const count = Math.max(1, efforts.length)
      if (key.type === 'up' || key.type === 'ctrl-p' || key.type === 'wheel') {
        const delta = key.type === 'wheel' ? key.delta : -1
        overlay.index = (overlay.index + delta + count) % count
      } else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = (overlay.index + 1) % count
      } else if (key.type === 'enter' || key.type === 'tab') {
        const effort = efforts[overlay.index]
        if (row !== undefined && effort !== undefined) void applyModel(row, effort.id)
        return
      } else if (key.type === 'left' || key.type === 'backspace') {
        reopenModelPicker(overlay.back)
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'd') {
        const effort = efforts[overlay.index]
        if (row !== undefined && effort !== undefined) void saveModelDefault(row, effort.id)
        return
      } else if (key.type === 'text' && /^[1-9]$/.test(key.text)) {
        // Positional shortcut: 1 = first level, 2 = second, … commits directly.
        const effort = efforts[Number(key.text) - 1]
        if (row !== undefined && effort !== undefined) void applyModel(row, effort.id)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'providers') {
      const rows = state.providers?.providers ?? []
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = Math.min(Math.max(0, rows.length - 1), overlay.index + 1)
      } else if (key.type === 'enter') {
        const entry = rows[overlay.index]
        if (entry !== undefined) openProviderEditor(entry)
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'r') {
        state.overlay = {
          kind: 'confirm',
          title: 'restart host',
          lines: ['Re-exec the Host process and reattach this session?'],
          index: 0,
          onYes: () => {
            void restartHost()
          },
        }
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'a') {
        state.overlay = {
          kind: 'providerCreate',
          index: 0,
          draft: { id: '', displayName: '', baseURL: '', apiKeyEnv: '', models: '' },
        }
        schedule()
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'x') {
        const entry = rows[overlay.index]
        if (entry !== undefined) {
          state.overlay = {
            kind: 'confirm',
            title: `remove provider · ${entry.id}`,
            lines: [
              `Delete the ${entry.id} block from`,
              state.providers?.file ?? 'cordis.patch.yml',
              '',
              'Its API key, if any, stays in the environment.',
              'Remove it?',
            ],
            index: 1,
            onYes: () => {
              void deleteProviderRow(entry.id)
            },
          }
          schedule()
        }
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'providerCreate') {
      if (overlay.editing !== undefined) {
        const editing = overlay.editing
        if (key.type === 'enter' || key.type === 'tab') {
          overlay.draft[editing.field] = editing.value
          overlay.editing = undefined
        } else if (key.type === 'backspace') {
          editing.value = Array.from(editing.value).slice(0, -1).join('')
        } else if (key.type === 'ctrl-u') {
          editing.value = ''
        } else if (key.type === 'text') {
          editing.value += key.text
        }
        schedule()
        return
      }
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = Math.min(PROVIDER_CREATE_FIELDS.length - 1, overlay.index + 1)
      } else if (key.type === 'enter') {
        const field = PROVIDER_CREATE_FIELDS[overlay.index]
        if (field !== undefined) overlay.editing = { field, value: overlay.draft[field] }
      } else if (key.type === 'text' && key.text.toLowerCase() === 's') {
        void submitNewProvider(overlay)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'providerEdit') {
      if (overlay.editing !== undefined) {
        const editing = overlay.editing
        if (key.type === 'enter' || key.type === 'tab') {
          overlay.draft[editing.field] = editing.value
          overlay.dirty.add(editing.field)
          overlay.editing = undefined
        } else if (key.type === 'backspace') {
          editing.value = Array.from(editing.value).slice(0, -1).join('')
        } else if (key.type === 'ctrl-u') {
          editing.value = ''
        } else if (key.type === 'text') {
          editing.value += key.text
        }
        schedule()
        return
      }
      if (key.type === 'up' || key.type === 'ctrl-p') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.type === 'down' || key.type === 'ctrl-n') {
        overlay.index = Math.min(PROVIDER_FIELD_ORDER.length - 1, overlay.index + 1)
      } else if (key.type === 'enter') {
        const field = PROVIDER_FIELD_ORDER[overlay.index]
        if (field !== undefined) overlay.editing = { field, value: overlay.draft[field] }
      } else if (key.type === 'text' && key.text.toLowerCase() === 's') {
        void saveProvider(overlay)
        return
      }
      schedule()
      return
    }
    if (overlay.kind === 'confirm') {
      if (key.type === 'up' || key.type === 'down' || key.type === 'tab' || key.type === 'left' || key.type === 'right') {
        overlay.index = overlay.index === 0 ? 1 : 0
      } else if (key.type === 'enter') {
        const yes = overlay.index === 0
        const action = overlay.onYes
        state.overlay = null
        if (yes) action()
        else schedule()
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'y') {
        const action = overlay.onYes
        state.overlay = null
        action()
        return
      } else if (key.type === 'text' && key.text.toLowerCase() === 'n') {
        state.overlay = null
      }
      schedule()
      return
    }
    if (overlay.kind !== 'sessions') return
    const overlaySessions = filteredSessions(overlay.workspaceId)
    if (key.type === 'up') overlay.index = Math.max(0, overlay.index - 1)
    else if (key.type === 'down') overlay.index = Math.min(overlaySessions.length - 1, overlay.index + 1)
    else if (key.type === 'enter') switchOverlaySession(overlay.index)
    else if (key.type === 'text' && key.text.toLowerCase() === 'n') void createSession(undefined, overlay.workspaceId)
    schedule()
  }

  const handleStartupKey = (key: Key): void => {
    if (key.type === 'wheel') {
      const startup = state.startup
      if (startup === undefined) return
      const count = startup.kind === 'sessions' ? startup.sessions.length : 0
      const next = Math.max(0, Math.min(Math.max(0, count - 1), startup.index + key.delta))
      if (next !== startup.index) {
        startup.index = next
        schedule()
      }
      return
    }
    const startup = state.startup
    if (startup === undefined) return
    if (startup.loading === true) {
      // Ignore enter/n until the list is real: creating a session by accident
      // while the Host is still answering would be surprising.
      if (key.type === 'ctrl-c' || key.type === 'ctrl-d' || key.type === 'escape') quit(0)
      else if (key.type === 'text' && key.text.toLowerCase() === 'q') quit(0)
      return
    }
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
    if (key.type === 'focus') {
      // Coming back to the terminal: catch up on sessions and git state.
      if (key.focused) {
        void refreshSessions()
        refreshGit()
      }
      return
    }
    if (state.startup !== undefined) {
      handleStartupKey(key)
      return
    }
    if (state.overlay !== null) {
      handleOverlayKey(key)
      return
    }
    // Any non-mouse key ends a text selection.
    if (key.type !== 'click' && key.type !== 'drag' && key.type !== 'release' && key.type !== 'wheel') {
      selectAnchor = null
      screen.setSelection(null)
    }
    if (key.type === 'wheel') {
      selectAnchor = null
      screen.setSelection(null)
      viewport.scroll(-key.delta * 3, transcriptLineCount(), transcriptHeight())
      schedule()
      return
    }
    if (key.type === 'click') {
      if (pillRow !== null && key.row === pillRow) {
        viewport.reset()
        schedule()
        return
      }
      // Start a selection anchor; a plain click (no drag) copies nothing.
      selectAnchor = { row: key.row, column: key.column }
      screen.setSelection(null)
      schedule()
      return
    }
    if (key.type === 'drag') {
      if (selectAnchor !== null) {
        screen.setSelection({
          startRow: selectAnchor.row,
          startColumn: selectAnchor.column,
          endRow: key.row,
          endColumn: key.column,
        })
        schedule()
      }
      return
    }
    if (key.type === 'release') {
      if (selectAnchor === null) return
      const moved = key.row !== selectAnchor.row || key.column !== selectAnchor.column
      selectAnchor = null
      if (moved) {
        const text = screen.copySelection()
        if (text.length > 0) {
          const lines = text.split('\n').length
          toast(`copied ${lines > 1 ? `${lines} lines` : `${text.length} chars`}`)
        }
      } else {
        screen.setSelection(null)
      }
      schedule()
      return
    }
    if ((key.type === 'end' || key.type === 'enter') && viewport.scrollOffset > 0) {
      // less/vim semantics: End (or Enter) returns to the live tail instead of
      // moving the caret or sending a prompt that the user cannot see.
      viewport.reset()
      schedule()
      return
    }
    if (key.type === 'ctrl-g') {
      openAgents()
      return
    }
    if (key.type === 'escape' && state.editingQueued !== undefined) {
      cancelQueuedEdit()
      return
    }
    if (key.type === 'escape' && state.focus !== undefined) {
      state.focus = undefined
      schedule()
      return
    }
    if (key.type === 'escape' && viewport.scrollOffset > 0) {
      // Codex semantics: Esc returns to the live tail before it clears input.
      viewport.reset()
      schedule()
      return
    }
    if (key.type === 'escape') {
      if (state.completion !== undefined) {
        state.completion = undefined
        schedule()
      } else if (state.editor.text.length > 0) {
        state.editor = createEditor()
        state.historyIndex = -1
        refreshCompletion()
        schedule()
      } else if (state.view?.status === 'running') {
        toast('ctrl-c cancels the running turn')
      } else {
        // Double-Esc on an empty, idle composer opens the rewind list. The
        // first Esc is held for a short window so single-Esc stays harmless.
        const now = Date.now()
        if (now - state.escapeAt < 650) {
          state.escapeAt = 0
          openRewind()
        } else {
          state.escapeAt = now
        }
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
    if (key.type === 'ctrl-r') {
      openHistory()
      return
    }
    if (key.type === 'ctrl-b') {
      state.overlay = { kind: 'dashboard' }
      schedule()
      return
    }
    if (key.type === 'ctrl-t') {
      state.todosFolded = !state.todosFolded
      toast(`todos ${state.todosFolded ? 'hidden' : 'shown'}`)
      return
    }
    if (key.type === 'ctrl-o') {
      state.verbose = !state.verbose
      toast(state.verbose ? 'tool output expanded · ctrl+o folds it' : 'tool calls folded · ctrl+o expands output')
      return
    }
    if (
      state.completion !== undefined
      && (key.type === 'up' || key.type === 'down' || key.type === 'ctrl-p' || key.type === 'ctrl-n')
    ) {
      const count = state.completion.items.length
      if (count > 0) {
        const delta = key.type === 'up' || key.type === 'ctrl-p' ? -1 : 1
        state.completion.index = Math.max(0, Math.min(count - 1, state.completion.index + delta))
      }
      schedule()
      return
    }
    if (key.type === 'alt-up' || key.type === 'alt-down') {
      // Walk a selection from block to block (messages, tools, subagents, then
      // the queued prompts); plain arrows stay on prompt history.
      moveFocus(key.type === 'alt-up' ? -1 : 1)
      return
    }
    if (key.type === 'alt-backspace') {
      const items = focusItems()
      const item = state.focus === undefined ? undefined : items[state.focus]
      if (item !== undefined && item.kind === 'queue' && item.queue !== undefined) void dropQueuedPrompt(item.queue)
      return
    }
    if (key.type === 'page-up') {
      viewport.page(1, transcriptLineCount(), transcriptHeight())
      schedule()
      return
    }
    if (key.type === 'page-down') {
      viewport.page(-1, transcriptLineCount(), transcriptHeight())
      schedule()
      return
    }
    if (key.type === 'newline') {
      state.editor = insertText(state.editor, '\n')
      state.historyIndex = -1
      refreshCompletion()
      schedule()
      return
    }
    if (key.type === 'alt-enter' || key.type === 'alt-q') {
      if (state.completion !== undefined) {
        const item = state.completion.items[state.completion.index]
        acceptCompletion(item?.kind === 'command' && item.execute !== undefined)
        return
      }
      const text = state.editor.text
      if (isCommand(text)) {
        state.editor = createEditor()
        state.completion = undefined
        void runCommand(text)
      } else {
        void send(text, 'queue')
      }
      return
    }
    if (key.type === 'enter') {
      if (state.completion !== undefined) {
        const item = state.completion.items[state.completion.index]
        acceptCompletion(item?.kind === 'command' && item.execute !== undefined)
        return
      }
      const text = state.editor.text
      if (state.editingQueued !== undefined) {
        void commitQueuedEdit(text)
        return
      }
      if (text.length === 0 && state.focus !== undefined) {
        activateFocus()
        return
      }
      if (isCommand(text)) {
        state.editor = createEditor()
        state.completion = undefined
        void runCommand(text)
      } else {
        void send(text)
      }
      return
    }
    if (key.type === 'text' && key.text === '?' && state.editor.text.length === 0) {
      state.overlay = { kind: 'help' }
      schedule()
      return
    }
    if (key.type === 'paste') {
      const pasted = normalizePaste(key.text)
      if (shouldFoldPaste(pasted)) {
        state.pasteSeq += 1
        const placeholder = pastePlaceholder(pasted, state.pasteSeq)
        state.attachments.set(placeholder, pasted)
        state.editor = insertText(state.editor, placeholder)
      } else {
        state.editor = insertText(state.editor, pasted)
      }
      refreshCompletion()
      schedule()
      return
    }
    if (key.type === 'text') {
      state.editor = insertText(state.editor, key.text)
      state.historyIndex = -1
      refreshCompletion()
      schedule()
      return
    }
    if (key.type === 'tab') {
      if (state.completion === undefined) refreshCompletion()
      if (state.completion !== undefined) acceptCompletion(false)
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
      'ctrl-p': 'up',
      'ctrl-n': 'down',
      newline: '',
    }
    const action = mapped[key.type]
    if (action === undefined || action === '') return
    const result = editKey(state.editor, action, state.history, state.historyIndex)
    state.editor = result.state
    state.historyIndex = result.historyIndex
    refreshCompletion()
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

  const transcript = (): { lines: string[]; live: boolean; ranges: BlockRange[] } => {
    const view = state.view
    const width = Math.max(20, screen.size.columns - 2)
    if (view === undefined) {
      return { lines: [paint(theme, 'muted', 'connecting to the dsh Host…')], live: false, ranges: [] }
    }
    const events = view.events.filter((event) => event.seq > state.clearedAtSeq)
    // Todos live in the footer strip and the session panel; keeping their
    // historical snapshots inline would repeat the same list after every
    // update.
    const blocks = buildBlocks(events, state.verbose).filter((block) => block.kind !== 'todo')
    const rendered = renderBlocksWithRanges(blocks, width, theme, {
      expandTools: state.verbose,
      surfaceWidth: screen.size.columns,
    })
    const lines = rendered.lines
    const ranges = rendered.ranges
    if (view.streamReasoning.length > 0 && view.status === 'running') {
      const recent = view.streamReasoning
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(-3)
      lines.push('')
      lines.push(`${paint(theme, 'info', '✻')} ${paint(theme, 'muted', 'thinking · live')}`)
      for (const line of recent) {
        for (const wrapped of wrapText(line, Math.max(1, width - 2))) {
          lines.push(paint(theme, 'muted', `│ ${wrapped}`))
        }
      }
    }
    if (view.streamText.length > 0 && view.status === 'running') {
      lines.push('')
      lines.push(`${paint(theme, 'accent', 'dshell')} ${paint(theme, 'muted', '· live')}`)
      lines.push(...renderMarkdown(view.streamText, width, theme))
      lines.push(paint(theme, 'accent', '▌'))
    }
    return { lines, live: view.status === 'running', ranges }
  }

  interface FocusItem {
    start: number
    end: number
    kind: 'block' | 'queue'
    block?: Block
    queue?: QueueEntry
  }

  /** Blocks in transcript order, then the queued prompt rows below them. */
  const buildFocusItems = (ranges: readonly BlockRange[], lineCount: number): FocusItem[] => {
    const items: FocusItem[] = []
    for (const range of ranges) {
      if (range.block.kind === 'turn') continue
      items.push({ start: range.start, end: range.end, kind: 'block', block: range.block })
    }
    for (const entry of queuedEntries()) {
      items.push({ start: lineCount, end: lineCount, kind: 'queue', queue: entry })
    }
    return items
  }

  const focusItems = (): FocusItem[] => {
    const data = transcript()
    return buildFocusItems(data.ranges, data.lines.length)
  }

  const moveFocus = (delta: number): void => {
    const data = transcript()
    const items = buildFocusItems(data.ranges, data.lines.length)
    if (items.length === 0) return
    const current = state.focus
    const next = current === undefined
      ? delta < 0 ? items.length - 1 : 0
      : Math.max(0, Math.min(items.length - 1, current + delta))
    state.focus = next
    const item = items[next]
    if (item !== undefined) {
      if (item.kind === 'queue') viewport.reset()
      else viewport.reveal(item.start, data.lines.length, transcriptHeight())
    }
    schedule()
  }

  /** Pull one queued prompt back into the composer so it can be rewritten. */
  const beginQueuedEdit = (entry: QueueEntry): void => {
    state.queued = state.queued.filter((item) => item.requestId !== entry.requestId)
    state.editingQueued = { requestId: entry.requestId, text: entry.text, mode: entry.mode, local: entry.local }
    state.editor = createEditor(entry.text)
    state.focus = undefined
    toast('editing a queued prompt · enter saves · esc keeps it queued')
    schedule()
  }

  const cancelQueuedEdit = (): void => {
    const editing = state.editingQueued
    if (editing === undefined) return
    state.editingQueued = undefined
    if (editing.local) {
      state.queued.push({ requestId: editing.requestId, text: editing.text, at: Date.now(), mode: editing.mode })
    }
    state.editor = createEditor()
    toast('queued prompt kept as it was')
    schedule()
  }

  const commitQueuedEdit = async (text: string): Promise<void> => {
    const editing = state.editingQueued
    if (editing === undefined) return
    const trimmed = text.replace(/\s+$/, '')
    if (trimmed.length === 0) {
      toast('a queued prompt cannot be empty')
      return
    }
    state.editingQueued = undefined
    state.editor = createEditor()
    state.historyIndex = -1
    schedule()
    if (trimmed !== editing.text && state.handle !== undefined) {
      try {
        await state.handle.editQueued(editing.requestId, trimmed)
      } catch (error) {
        state.error = errorText(error)
        schedule()
        return
      }
    }
    if (editing.local) {
      state.queued.push({ requestId: editing.requestId, text: trimmed, at: Date.now(), mode: editing.mode })
    } else {
      state.queueText.set(editing.requestId, trimmed)
    }
    toast('queued prompt updated')
    schedule()
  }

  const activateFocus = (): void => {
    const items = focusItems()
    const item = state.focus === undefined ? undefined : items[state.focus]
    if (item === undefined) return
    if (item.kind === 'queue' && item.queue !== undefined) {
      beginQueuedEdit(item.queue)
      return
    }
    const block = item.block
    if (block === undefined) return
    if (block.kind === 'tool') {
      const width = Math.max(20, screen.size.columns - 10)
      const body: string[] = [
        `${paint(theme, 'bold', paint(theme, 'accentSoft', block.toolName ?? 'tool'))}${block.failed === true ? ` ${paint(theme, 'error', '· failed')}` : ''}`,
      ]
      if (block.title !== undefined && block.title !== block.toolName) body.push(paint(theme, 'muted', block.title))
      if (block.body.length > 0) body.push('', ...wrapText(block.body, width).map((line) => paint(theme, 'text', line)))
      if (block.detail !== undefined && block.detail.length > 0) {
        body.push('', paint(theme, 'bold', paint(theme, 'accentSoft', 'result')), ...wrapText(block.detail, width).map((line) => paint(theme, 'muted', line)))
      }
      state.overlay = { kind: 'detail', title: `tool · ${block.toolName ?? 'call'}`, lines: body, scroll: 0 }
      schedule()
      return
    }
    if (block.kind === 'notice' && /agent (started|running|finished|failed)|^subagent /.test(block.title ?? '')) {
      state.overlay = { kind: 'agents', index: 0 }
      schedule()
      return
    }
    toast('enter opens tool details, subagents (≈ /agents) and queued prompts')
  }

  /** Delete one queued prompt both locally and in the Host inbox. */
  const dropQueuedPrompt = async (entry: QueueEntry): Promise<void> => {
    state.queued = state.queued.filter((item) => item.requestId !== entry.requestId)
    if (!entry.local) state.hiddenQueued.set(entry.requestId, Date.now())
    state.focus = undefined
    schedule()
    if (state.handle === undefined) return
    try {
      await state.handle.removeQueued(entry.requestId)
      toast('queued prompt deleted')
    } catch (error) {
      state.error = errorText(error)
    }
    schedule()
  }

  // The renderer measures the footer, menu and composer each frame; PgUp/PgDn
  // reuse that exact body height so a page never overshoots the viewport.
  const transcriptHeight = (): number => Math.max(3, lastBodyHeight)
  const transcriptLineCount = (): number => transcript().lines.length

  const sessionTitle = (): string => {
    const view = state.view
    const title = view?.header.title ?? (view === undefined ? undefined : latestSessionTitle(view.events))
    return title === undefined ? shortId(view?.sessionId) : truncate(title, 42)
  }

  const headerLines = (): string[] => {
    const view = state.view
    const status = statusLabel(state)
    const cwd = view?.header.cwd ?? options.cwd
    return [
      renderHeader(theme, {
        columns: screen.size.columns,
        title: sessionTitle(),
        cwd,
        status,
        statusStyle: statusColor(status),
      }),
      paint(theme, 'border', '─'.repeat(screen.size.columns)),
    ]
  }

  const speedFor = (metrics: SessionMetrics, now: number): number => {
    const elapsed = metrics.turnStartedAt === undefined ? metrics.lastTurnMs ?? 0 : now - metrics.turnStartedAt
    return metrics.turnStartedAt !== undefined
      ? currentTps(state.tpsSamples, metrics.liveTokens, elapsed)
      : averageTps(state.tpsSamples)
  }

  const usageRailLine = (metrics: SessionMetrics, now: number): string => {
    const running = metrics.agents.filter((agent) => agent.status === 'running').length
    const model = state.modelOverride?.model ?? metrics.model
    const provider = state.modelOverride?.provider ?? metrics.provider
    const effort = state.modelOverride?.reasoningEffort
      ?? (model === undefined || provider === undefined ? undefined : state.modelEfforts[`${provider}/${model}`])
    return renderUsageRail(theme, {
      tokens: metrics.cost.tokens,
      ...(metrics.cost.cost === undefined ? {} : { cost: metrics.cost.cost }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(effort === undefined ? {} : { effort }),
      cwd: state.view?.header.cwd ?? options.cwd,
      ...(gitInfo === undefined ? {} : { git: gitInfo }),
      ...(metrics.agents.length === 0
        ? {}
        : {
            agents: {
              done: metrics.agents.length - running,
              total: metrics.agents.length,
              running,
              failed: metrics.agents.filter((agent) => agent.status === 'failed').length,
            },
          }),
      width: screen.size.columns,
    })
  }

  const footerLines = (metrics: SessionMetrics, now: number): string[] => {
    const columns = screen.size.columns
    const lines: string[] = []
    const phase = metrics.activity.phase
    if (phase === 'thinking' || phase === 'streaming' || phase === 'tool' || phase === 'approval') {
      const elapsed = metrics.turnStartedAt === undefined ? undefined : now - metrics.turnStartedAt
      lines.push(renderActivityLine(theme, metrics.activity, {
        now,
        ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
        ...(metrics.contextPct === undefined ? {} : { contextPct: metrics.contextPct }),
        width: columns,
      }))
    }
    if (!state.todosFolded && metrics.todos.length > 0) {
      lines.push(renderTodoStrip(theme, metrics.todos, { width: columns, now, folded: false }))
    }
    const counts = todoCounts(metrics.todos)
    const statusStrip = renderStatusStrip(theme, {
      agentsDone: 0,
      agentsTotal: 0,
      agentsRunning: 0,
      jobsRunning: metrics.jobs.running,
      jobsFailed: metrics.jobs.failed,
      jobsTotal: metrics.jobs.total,
      todosDone: counts.completed,
      todosTotal: counts.total,
      width: columns,
    })
    if (statusStrip.length > 0) lines.push(statusStrip)
    return lines
  }

  const overlayLines = (): string[] => {
    const overlay = state.overlay
    if (overlay === null) return []
    const columns = screen.size.columns
    const rows = screen.size.rows
    const width = Math.max(30, Math.min(columns - 4, 88))
    const inner = width - 4
    if (overlay.kind === 'help') {
      const body: string[] = [paint(theme, 'bold', paint(theme, 'accentSoft', 'commands')), '']
      for (const { name, description } of COMMAND_SPECS) {
        body.push(`${paint(theme, 'accent', pad(name, 15))} ${paint(theme, 'text', description)}`)
      }
      body.push('', paint(theme, 'bold', paint(theme, 'accentSoft', 'keys')), '')
      body.push(`${paint(theme, 'text', pad('enter', 15))} send/steer · ${paint(theme, 'text', 'alt+q')} queue · ${paint(theme, 'text', 'ctrl+enter')} newline`)
      body.push(`${paint(theme, 'text', pad('tab', 15))} complete · ${paint(theme, 'text', 'shift+enter')} newline (kitty-style terminals)`)
      body.push(`${paint(theme, 'text', pad('up / down', 15))} prompt history · ${paint(theme, 'text', 'pgup/pgdn')} scroll`)
      body.push(`${paint(theme, 'text', pad('alt+up/down', 15))} select blocks · ${paint(theme, 'text', 'enter')} open · ${paint(theme, 'text', 'esc')} clear`)
      body.push(`${paint(theme, 'text', pad('alt+backspace', 15))} delete the selected queued prompt`)
      body.push(`${paint(theme, 'text', pad('pgup / pgdn', 15))} page scroll · ${paint(theme, 'text', 'wheel')} 3 lines`)
      body.push(`${paint(theme, 'text', pad('drag', 15))} select & copy text (shift+drag: terminal)`)
      body.push(`${paint(theme, 'text', pad('ctrl+r', 15))} history search · ${paint(theme, 'text', 'ctrl+b')} session panel`)
      body.push(`${paint(theme, 'text', pad('ctrl+t', 15))} fold todos · ${paint(theme, 'text', 'ctrl+o')} tools/thinking`)
      body.push(`${paint(theme, 'text', pad('ctrl+g', 15))} subagents · ${paint(theme, 'text', 'double esc')} rewind prompt`)
      body.push(`${paint(theme, 'text', pad('end / esc', 15))} jump to bottom while scrolled up`)
      body.push(`${paint(theme, 'text', pad('ctrl-c', 15))} cancel/quit · ${paint(theme, 'text', 'ctrl-d')} quit`)
      body.push('', paint(theme, 'muted', 'The TUI never owns the Agent: quitting only closes this view.'))
      return panelBox(theme, 'help & shortcuts', body, width)
    }
    if (overlay.kind === 'models') {
      const entries = modelRows()
      const visibleCount = Math.max(1, Math.min(14, rows - 9))
      const start = Math.max(0, Math.min(overlay.index - Math.floor(visibleCount / 2), entries.length - visibleCount))
      const selectedModel = currentModel()
      const defaultModel = state.modelCatalog?.default
      const body: string[] = []
      if (entries.length === 0) body.push(paint(theme, 'muted', 'no routable models'))
      for (const [offset, row] of entries.slice(start, start + visibleCount).entries()) {
        const index = start + offset
        if (row.kind === 'group') {
          if (body.length > 0) body.push('')
          body.push(`${paint(theme, 'bold', paint(theme, 'accentSoft', row.providerName ?? row.provider ?? ''))} ${paint(theme, 'muted', `· ${String(row.count ?? 0)}`)}`)
          continue
        }
        if (row.kind === 'failure') {
          body.push(`${paint(theme, 'error', '!')} ${paint(theme, 'text', row.providerName ?? row.provider ?? '')} ${paint(theme, 'muted', truncate(row.message ?? '', Math.max(10, inner - 8)))}`)
          continue
        }
        const selected = index === overlay.index
        const isCurrent = selectedModel?.provider === row.provider && selectedModel?.model === row.model?.id
        const isDefault = defaultModel?.provider === row.provider && defaultModel?.model === row.model?.id
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        const badge = isCurrent ? paint(theme, 'success', '●') : isDefault ? paint(theme, 'accent', '◆') : ' '
        const label = row.model?.name ?? row.model?.id ?? ''
        const idPart = paint(theme, 'muted', `${row.provider ?? ''}/${row.model?.id ?? ''}`)
        const level = hasEfforts(row)
          ? paint(theme, 'muted', ` · ${effortFor(row) ?? '—'}`)
          : ''
        body.push(`${marker}${badge} ${paint(theme, selected ? 'text' : 'muted', truncate(label, 30))}  ${idPart}${level}`)
      }
      body.push('')
      body.push(
        `${paint(theme, 'success', '●')} ${paint(theme, 'muted', 'in use')}   ${paint(theme, 'accent', '◆')} ${paint(theme, 'muted', 'default for new sessions')}   ${paint(theme, 'accent', '▸')} ${paint(theme, 'muted', 'cursor')}`,
      )
      return panelBox(theme, 'model', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ select · enter model/level · e levels · d default · esc close')],
      })
    }
    if (overlay.kind === 'effort') {
      const row = modelRowById(overlay.provider, overlay.model)
      const efforts = row?.model?.reasoning?.efforts ?? []
      const current = row === undefined ? undefined : effortFor(row)
      const body: string[] = [
        `${paint(theme, 'muted', `${overlay.provider}/`)}${paint(theme, 'bold', overlay.model)}`,
        '',
      ]
      for (const [index, effort] of efforts.entries()) {
        const selected = index === overlay.index
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        const badge = effort.id === current ? paint(theme, 'success', '●') : ' '
        const name = paint(theme, selected ? 'text' : 'muted', pad(effort.name, 8))
        const detail = paint(theme, 'muted', truncate(effort.description ?? effort.id, Math.max(12, inner - 14)))
        body.push(`${marker}${badge} ${name} ${detail}`)
      }
      if (efforts.length === 0) body.push(paint(theme, 'muted', 'this model declares no reasoning levels'))
      body.push('')
      body.push(
        `${paint(theme, 'success', '●')} ${paint(theme, 'muted', 'in use')}   ${paint(theme, 'accent', '▸')} ${paint(theme, 'muted', 'cursor · enter applies')}`,
      )
      return panelBox(theme, 'reasoning level', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ or 1-9 pick · enter switch · d default · ← back · esc close')],
      })
    }
    if (overlay.kind === 'providers') {
      const list = state.providers
      const rowsList = list?.providers ?? []
      const body: string[] = []
      for (const [index, entry] of rowsList.entries()) {
        const selected = index === overlay.index
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        const title = entry.displayName ?? entry.id
        const address = entry.baseURL ?? paint(theme, 'muted', 'no baseURL')
        const key = entry.apiKeyEnv === undefined ? paint(theme, 'muted', 'no key env') : paint(theme, 'text', entry.apiKeyEnv)
        body.push(`${marker} ${paint(theme, selected ? 'text' : 'muted', pad(truncate(entry.id, 18), 18))} ${paint(theme, 'text', truncate(title, 16))}`)
        body.push(`  ${address}  ${key}  ${paint(theme, 'muted', `${String(entry.models)} models`)}`)
      }
      if (rowsList.length === 0) body.push(paint(theme, 'muted', 'no providers declared'))
      body.push('')
      body.push(paint(theme, 'muted', list?.file ?? 'no patch file found'))
      if (list?.writable === false) body.push(paint(theme, 'error', 'read-only: fix the file permissions to edit'))
      return panelBox(theme, 'providers', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ select · enter edit · a add · x remove · r restart · esc close')],
      })
    }
    if (overlay.kind === 'providerEdit') {
      const body: string[] = []
      for (const [index, field] of PROVIDER_FIELD_ORDER.entries()) {
        const selected = index === overlay.index
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        const dirty = overlay.dirty.has(field) ? paint(theme, 'accent', ' •') : ''
        const editing = overlay.editing?.field === field
        const raw = editing ? overlay.editing?.value ?? '' : overlay.draft[field]
        const shown = raw.length === 0 ? paint(theme, 'muted', '(unset)') : paint(theme, selected ? 'text' : 'muted', raw)
        body.push(`${marker} ${paint(theme, 'muted', pad(PROVIDER_FIELD_LABEL[field], 12))} ${editing ? `${shown}${paint(theme, 'accent', '▏')}` : shown}${dirty}`)
      }
      body.push('')
      body.push(paint(theme, 'muted', 'secrets live in the environment, never in the patch file'))
      body.push(paint(theme, 'muted', overlay.editing === undefined
        ? 'enter edit · s save & reload · esc back'
        : 'enter commit field · esc cancel field'))
      return panelBox(theme, `provider · ${overlay.providerId}`, body, width, {
        footer: [paint(theme, 'muted', overlay.editing === undefined
          ? 'enter edit · s save · esc back'
          : 'type to edit · enter commit · esc cancel')],
      })
    }
    if (overlay.kind === 'providerCreate') {
      const body: string[] = []
      for (const [index, field] of PROVIDER_CREATE_FIELDS.entries()) {
        const selected = index === overlay.index
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        const editing = overlay.editing?.field === field
        const raw = editing ? overlay.editing?.value ?? '' : overlay.draft[field]
        const shown = raw.length === 0
          ? paint(theme, 'muted', PROVIDER_CREATE_HINTS[field])
          : paint(theme, selected ? 'text' : 'muted', raw)
        body.push(`${marker} ${paint(theme, 'muted', pad(field, 12))} ${editing ? `${shown}${paint(theme, 'accent', '▏')}` : shown}`)
      }
      body.push('')
      body.push(paint(theme, 'muted', 'the new block is appended to the providers map'))
      body.push(paint(theme, 'muted', 'the API key itself stays in the environment'))
      return panelBox(theme, 'add provider', body, width, {
        footer: [paint(theme, 'muted', overlay.editing === undefined
          ? 'enter edit · s add · esc back'
          : 'type to edit · enter commit · esc cancel')],
      })
    }
    if (overlay.kind === 'confirm') {
      const body: string[] = [...overlay.lines, '']
      const options = ['restart now', 'later']
      for (const [index, option] of options.entries()) {
        const selected = index === overlay.index
        const marker = selected ? paint(theme, 'accent', '▸') : ' '
        body.push(`${marker} ${paint(theme, selected ? 'text' : 'muted', option)}`)
      }
      return panelBox(theme, overlay.title, body, width, {
        footer: [paint(theme, 'muted', '↑/↓ choose · enter confirm · y restart · n later')],
      })
    }
    if (overlay.kind === 'workspaces') {
      const visibleCount = Math.max(1, Math.min(12, rows - 10))
      const start = Math.max(0, Math.min(overlay.index - Math.floor(visibleCount / 2), state.workspaces.length - visibleCount))
      const body = state.workspaces.slice(start, start + visibleCount).map((workspace, offset) => {
        const index = start + offset
        const marker = index === overlay.index ? paint(theme, 'accent', '▸') : ' '
        return `${marker} ${paint(theme, index === overlay.index ? 'text' : 'muted', truncate(workspace.title, 20))}  ${paint(theme, 'muted', truncate(workspace.path, Math.max(8, inner - 28)))}`
      })
      if (body.length === 0) body.push(paint(theme, 'muted', 'no workspaces'))
      return panelBox(theme, 'workspaces', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ select · enter sessions · n new session · esc close')],
      })
    }
    if (overlay.kind === 'sessions') {
      const sessions = filteredSessions(overlay.workspaceId)
      const visibleCount = Math.max(1, Math.min(12, rows - 10))
      const start = Math.max(0, Math.min(overlay.index - Math.floor(visibleCount / 2), sessions.length - visibleCount))
      const body = sessions.slice(start, start + visibleCount).map((session, offset) => {
        const index = start + offset
        const marker = index === overlay.index ? paint(theme, 'accent', '▸') : ' '
        const live = session.live === true ? paint(theme, 'success', 'live') : paint(theme, 'muted', 'cold')
        const age = timeAgo(session.updatedAt ?? session.createdAt)
        const label = session.title?.trim() || 'untitled session'
        const row = `${marker} ${paint(theme, index === overlay.index ? 'text' : 'muted', truncate(label, 26))}`
        const right = `${live} ${paint(theme, 'muted', age)}`
        return `${row}${' '.repeat(Math.max(1, inner - displayWidth(row) - displayWidth(right)))}${right}`
      })
      if (body.length === 0) body.push(paint(theme, 'muted', 'no sessions; press n to create one'))
      return panelBox(theme, 'sessions', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ select · enter attach · n new · esc close')],
      })
    }
    if (overlay.kind === 'history') {
      const items = historyItems(overlay.query)
      const index = Math.min(overlay.index, Math.max(0, items.length - 1))
      const visible = items.slice(0, Math.max(1, Math.min(9, rows - 12)))
      const body = [
        `${paint(theme, 'muted', 'search')} ${paint(theme, 'text', overlay.query)}${paint(theme, 'accent', '▌')}`,
        '',
      ]
      if (visible.length === 0) body.push(paint(theme, 'muted', 'no matching prompt in this session'))
      for (const [offset, item] of visible.entries()) {
        const marker = offset === index ? paint(theme, 'accent', '▸') : ' '
        body.push(`${marker} ${paint(theme, offset === index ? 'text' : 'muted', truncate(item.replace(/\s+/g, ' '), inner - 2))}`)
      }
      return panelBox(theme, 'history search', body, width, {
        footer: [paint(theme, 'muted', 'type to filter · ↑/↓ select · enter insert · esc cancel')],
      })
    }
    if (overlay.kind === 'rewind') {
      const prompts = userPrompts()
      const index = Math.min(overlay.index, Math.max(0, prompts.length - 1))
      const visible = prompts.slice(0, Math.max(1, Math.min(10, rows - 12)))
      const body = [paint(theme, 'muted', 'Restore a previous prompt into the composer.'), paint(theme, 'muted', 'The session itself is not truncated.'), '']
      if (visible.length === 0) body.push(paint(theme, 'muted', 'no previous prompt'))
      for (const [offset, item] of visible.entries()) {
        const marker = offset === index ? paint(theme, 'accent', '▸') : ' '
        body.push(`${marker} ${paint(theme, offset === index ? 'text' : 'muted', truncate(item.replace(/\s+/g, ' '), inner - 2))}`)
      }
      return panelBox(theme, 'rewind', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ select · enter restore · esc cancel')],
      })
    }
    if (overlay.kind === 'agents') {
      const agents = currentMetrics().agents
      const body: string[] = [paint(theme, 'muted', `${agents.length} subagent${agents.length === 1 ? '' : 's'} in this session`), '']
      for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index]!
        const glyph = agent.status === 'running'
          ? paint(theme, 'info', '●')
          : agent.status === 'failed' ? paint(theme, 'error', '✗') : paint(theme, 'success', '✓')
        const marker = index === overlay.index ? paint(theme, 'accent', '▸') : ' '
        const age = agent.startedAt === undefined ? '' : ` · ${timeAgo(agent.startedAt)}`
        const id = agent.agentId.length > 8 ? agent.agentId.slice(0, 8) : agent.agentId
        body.push(`${marker} ${glyph} ${paint(theme, 'text', truncate(agent.label, Math.max(10, inner - 34)))} ${paint(theme, 'muted', `${id} · ${agent.status}${age}`)}`)
      }
      return panelBox(theme, 'agents', body, width, {
        footer: [paint(theme, 'muted', '↑/↓ move · enter open transcript · esc close')],
      })
    }
    if (overlay.kind === 'agentView') {
      const height = Math.max(4, rows - 8)
      const body = overlay.loading
        ? ['', paint(theme, 'muted', 'attaching to the subagent session…')]
        : overlay.error !== undefined
          ? [paint(theme, 'error', overlay.error)]
          : overlay.lines.slice(overlay.scroll, overlay.scroll + height)
      return panelBox(theme, `agent · ${truncate(overlay.label, 40)}`, body, width, {
        footer: [paint(theme, 'muted', '↑/↓ scroll · pgup/pgdn · backspace back · esc close')],
      })
    }
    if (overlay.kind === 'detail') {
      const height = Math.max(4, rows - 12)
      const body = overlay.lines.slice(overlay.scroll, overlay.scroll + height)
      return panelBox(theme, overlay.title, body, width, {
        footer: [paint(theme, 'muted', '↑/↓ scroll · pgup/pgdn · esc close')],
      })
    }
    if (overlay.kind === 'dashboard') {
      const metrics = currentMetrics()
      const view = state.view
      if (view === undefined) {
        return panelBox(theme, 'session panel', [paint(theme, 'muted', 'no session attached')], width)
      }
      const core: string[] = []
      core.push(`${paint(theme, 'muted', 'session')}  ${paint(theme, 'bold', sessionTitle())}`)
      core.push(`${paint(theme, 'muted', 'id')}       ${paint(theme, 'text', view.sessionId)}`)
      core.push(`${paint(theme, 'muted', 'model')}    ${paint(theme, 'text', metrics.model ?? 'unknown')}${metrics.provider === undefined ? '' : paint(theme, 'muted', ` · ${metrics.provider}`)}`)
      core.push('')
      const occupancy = metrics.contextWindow === undefined
        ? formatTokens(metrics.usedTokens)
        : `${formatTokens(metrics.usedTokens)} / ${formatTokens(metrics.contextWindow)} ${formatPercent(metrics.contextPct ?? 0)}`
      core.push(`${paint(theme, 'muted', 'context')}  ${paint(theme, 'text', occupancy)}`)
      if (metrics.contextWindow !== undefined) {
        core.push(renderContextBar(theme, metrics.segments, metrics.usedTokens, metrics.contextWindow, inner))
      }
      core.push(...renderContextLegendCompact(theme, metrics.segments, metrics.usedTokens, inner))
      const sessionTokens = metrics.cost.tokens
      core.push('')
      core.push(paint(theme, 'bold', paint(theme, 'accentSoft', 'session usage')))
      core.push(`${paint(theme, 'muted', 'in')}       ${formatTokens(sessionTokens.input)}${sessionTokens.cacheRead > 0 ? `${paint(theme, 'muted', ' · cache read ')}${formatTokens(sessionTokens.cacheRead)}` : ''}${sessionTokens.cacheWrite > 0 ? `${paint(theme, 'muted', ' · cache write ')}${formatTokens(sessionTokens.cacheWrite)}` : ''}${paint(theme, 'muted', ' · out ')}${formatTokens(sessionTokens.output)}`)
      const spend = metrics.cost.cost
      const spendText = spend === undefined
        ? paint(theme, 'muted', 'unpriced')
        : `${paint(theme, 'warning', `~${formatCostCny(spend)}`)} ${paint(theme, 'muted', 'est. CNY')}`
      core.push(`${paint(theme, 'muted', 'total')}    ${formatTokens(sessionTokens.total)} tokens · ${spendText}`)
      if (metrics.cost.pricedTokens > 0) {
        core.push(`${paint(theme, 'muted', '         ')}peak ${formatCostCny(metrics.cost.peak)} · idle ${formatCostCny(metrics.cost.idle)}`)
      }
      if (metrics.cost.unpricedTokens > 0) {
        core.push(`${paint(theme, 'muted', '         ')}${formatTokens(metrics.cost.unpricedTokens)} unpriced`)
      }
      if (metrics.cost.models.length > 1) {
        for (const model of metrics.cost.models) {
          core.push(`${paint(theme, 'muted', '         ')}${paint(theme, 'text', model.model)}${model.cost === undefined ? paint(theme, 'muted', ' · unpriced') : paint(theme, 'muted', ` · ~${formatCostCny(model.cost)}`)}`)
        }
      }
      const elapsed = metrics.turnStartedAt === undefined ? metrics.lastTurnMs : Date.now() - metrics.turnStartedAt
      const tps = metrics.turnStartedAt !== undefined
        ? currentTps(state.tpsSamples, metrics.liveTokens, elapsed ?? 0)
        : averageTps(state.tpsSamples)
      const peak = Math.max(1, tps, ...state.tpsSamples.map((sample) => sample.tps))
      core.push(`${paint(theme, 'muted', 'speed')}    ${paint(theme, 'text', tps.toFixed(1))} tps ${renderTpsGauge(theme, tps, peak)}${elapsed === undefined ? '' : paint(theme, 'muted', ` · turn ${formatDuration(elapsed)}`)}`)
      if (state.tpsSamples.length > 1) core.push(`${paint(theme, 'muted', '         ')}${renderTpsSparkline(theme, state.tpsSamples)}`)

      const agentsSection: string[] = []
      if (metrics.agents.length > 0) {
        agentsSection.push('', paint(theme, 'bold', paint(theme, 'accentSoft', 'agents')))
        for (const agent of metrics.agents) {
          const glyph = agent.status === 'running' ? paint(theme, 'info', '●') : agent.status === 'failed' ? paint(theme, 'error', '✗') : paint(theme, 'success', '✓')
          agentsSection.push(`${glyph} ${paint(theme, 'text', truncate(agent.label, Math.max(10, inner - 18)))} ${paint(theme, 'muted', `${shortId(agent.agentId)} · ${agent.status}`)}`)
        }
      }

      const todosSection: string[] = ['']
      todosSection.push(paint(theme, 'bold', paint(theme, 'accentSoft', 'todos')))
      todosSection.push(...renderTodoList(theme, metrics.todos, inner))

      // Keep the panel inside the viewport: borders (2) + footer (2) + the
      // header row and one slack row belong to the overlay frame, not the
      // body. Todos are the first section to go, then the tail is clipped.
      const maxBody = Math.max(6, rows - 7)
      let body = [...core]
      const append = (section: string[]): boolean => {
        if (section.length === 0 || body.length + section.length > maxBody) return false
        body.push(...section)
        return true
      }
      const agentsShown = append(agentsSection)
      const todosShown = append(todosSection)
      if (body.length > maxBody) body = [...core.slice(0, maxBody - 1), paint(theme, 'muted', '…')]
      const hidden = [!agentsShown && agentsSection.length > 0 ? 'agents' : '', !todosShown && metrics.todos.length > 0 ? 'todos' : ''].filter(Boolean)
      if (hidden.length > 0 && body.length < maxBody) {
        body.push(paint(theme, 'muted', `${hidden.join(' + ')} hidden (terminal too short)`))
      }
      return panelBox(theme, 'session panel', body, width, {
        footer: [paint(theme, 'muted', 'ctrl+b / esc close · ctrl+r history · double esc rewind')],
      })
    }
    if (overlay.kind !== 'approval') return []
    const pending = state.view?.pendingApproval
    if (pending === undefined) return panelBox(theme, 'approval', [paint(theme, 'muted', 'no approval pending')], width)
    const body = [
      `${paint(theme, 'muted', 'tool')}     ${paint(theme, 'bold', pending.toolName)}`,
      `${paint(theme, 'muted', 'reason')}   ${truncate(pending.reason ?? '(no reason)', inner - 10)}`,
      `${paint(theme, 'muted', 'request')}  ${truncate(pending.requestId, inner - 10)}`,
    ]
    if (overlay.details) {
      body.push('', paint(theme, 'muted', 'The full tool arguments are in the transcript above.'))
    }
    body.push('', paint(theme, 'warning', '[a] allow once   [r] reject   [d] details   [esc] later'))
    body.push(paint(theme, 'muted', 'A timeout, disconnect, or non-TTY frontend fails closed.'))
    return panelBox(theme, 'approval required', body, width, { tone: 'warning' })
  }

  const startupLines = (): string[] => {
    const startup = state.startup
    if (startup === undefined) return []
    const sessions: SplashSession[] = startup.sessions.map((session) => {
      const title = session.title?.trim()
      return {
        label: title === undefined || title.length === 0 ? 'untitled session' : title,
        live: session.live === true,
        cwd: session.cwd ?? '',
        age: timeAgo(session.updatedAt ?? session.createdAt),
      }
    })
    return renderSplash(theme, {
      columns: screen.size.columns,
      rows: screen.size.rows,
      now: Date.now(),
      cwd: startup.kind === 'missing' ? startup.cwd : startup.workspace?.path ?? startup.cwd,
      kind: startup.kind,
      ...(startup.workspace === undefined ? {} : { workspaceTitle: startup.workspace.title, workspacePath: startup.workspace.path }),
      sessions,
      index: startup.index,
      ...(startup.loading === true ? { loading: true } : {}),
      ...(state.error === undefined ? {} : { error: state.error }),
    })
  }

  const completionMenuLines = (): string[] => {
    const completion = state.completion
    if (completion === undefined) return []
    const columns = screen.size.columns
    const width = Math.max(30, Math.min(columns - 4, 80))
    const inner = width - 4
    const title = completion.context.kind === 'command' ? 'commands' : 'files'
    const body: string[] = []
    const visibleCount = Math.max(1, Math.min(8, screen.size.rows - 14))
    const start = Math.max(
      0,
      Math.min(completion.index - Math.floor(visibleCount / 2), completion.items.length - visibleCount),
    )
    const visible = completion.items.slice(start, start + visibleCount)
    for (const [offset, item] of visible.entries()) {
      const index = start + offset
      const marker = index === completion.index ? paint(theme, 'accent', '▸') : ' '
      body.push(
        `${marker} ${paint(theme, 'bold', pad(item.label, 16))} ${paint(theme, 'muted', truncate(item.description, Math.max(6, inner - 20)))}`,
      )
    }
    if (completion.items.length === 0) {
      body.push(paint(theme, 'muted', completion.context.kind === 'command' ? 'no matching command' : 'no matching file'))
    }
    return panelBox(theme, title, body, width, {
      footer: [paint(theme, 'muted', '↑/↓ select · tab insert · enter run/select · esc close')],
    })
  }

  const render = (): void => {
    if (state.quitting) return
    const { rows, columns } = screen.size

    if (state.startup !== undefined) {
      pillRow = null
      screen.draw(startupLines().slice(0, rows), undefined)
      ensureTick()
      return
    }

    const now = Date.now()
    const metrics = currentMetrics()
    const header = headerLines()
    const overlay = overlayLines()
    const toastActive = state.toast !== undefined && state.toast.until > now
    let focusHint: string | undefined
    if (state.focus !== undefined) {
      const data = transcript()
      const items = buildFocusItems(data.ranges, data.lines.length)
      const index = Math.min(state.focus, Math.max(0, items.length - 1))
      const item = items[index]
      if (item !== undefined) {
        focusHint = `▸ ${String(index + 1)}/${String(items.length)} · ${focusLabel(item)} · enter open · esc clear`
      }
    }
    const notice = toastActive
      ? state.toast?.text
      : state.error === undefined
        ? focusHint
        : `! ${state.error}`
    const lines: string[] = []
    let cursor: { row: number; column: number } | undefined

    if (overlay.length > 0) {
      const available = Math.max(4, rows - header.length - (notice === undefined ? 0 : 1) - 1)
      lines.push(...header)
      lines.push(...centerVertically(centerBlock(overlay, columns), available))
      if (notice !== undefined) {
        const tone: ThemeStyle = !toastActive && state.error !== undefined ? 'error' : 'warning'
        lines.push(paint(theme, tone, truncate(notice, columns)))
      }
      pillRow = null
      screen.draw(lines.slice(0, rows), undefined)
      if (state.toast !== undefined && state.toast.until <= now) state.toast = undefined
      ensureTick()
      return
    }

    const transcriptData = transcript()
    const menu = completionMenuLines()
    const footer = footerLines(metrics, now)
    const usage = usageRailLine(metrics, now)
    const speed = speedFor(metrics, now)
    const showSpeed = metrics.turnStartedAt !== undefined || state.tpsSamples.length > 0
    const composer = renderComposer(theme, state.editor, columns, 7, renderHintLine(theme, columns), {
      ...(metrics.contextPct === undefined ? {} : { contextPct: metrics.contextPct }),
      ...(showSpeed ? { tps: speed } : {}),
    })
    const noticeRows = notice === undefined ? 0 : 1
    const total = transcriptData.lines.length
    lastTranscriptTotal = total
    if (viewport.scrollOffset === 0) seenTranscriptTotal = total
    const unseen = Math.max(0, total - seenTranscriptTotal)
    const pill = viewport.scrollOffset === 0 ? undefined : renderJumpToBottom(theme, unseen, columns)
    const focusOrder = buildFocusItems(transcriptData.ranges, transcriptData.lines.length)
    const focused = state.focus === undefined ? undefined : focusOrder[state.focus]
    const queuedRows = queuedEntries().slice(-2).map((entry) => {
      const oneLine = entry.text.replace(/\s+/g, ' ').trim()
      const label = entry.mode === 'steer' ? 'steering' : 'queued'
      const row = paint(theme, 'dim', truncate(`  ◷ ${label} · ${oneLine}`, columns))
      const selected = focused?.kind === 'queue' && focused.queue?.requestId === entry.requestId
      return selected ? selectionBand(row) : row
    })
    const bodyHeight = Math.max(
      3,
      rows -
        header.length -
        footer.length -
        menu.length -
        composer.height -
        noticeRows -
        queuedRows.length -
        (pill === undefined ? 0 : 1) -
        1,
    )
    lastBodyHeight = bodyHeight
    const visible = viewport.visible(transcriptData.lines, bodyHeight)
    lines.push(...header)
    for (let index = 0; index < visible.lines.length; index += 1) {
      const line = visible.lines[index] ?? ''
      const absolute = visible.start + index
      const selected =
        focused !== undefined && focused.kind === 'block' && absolute >= focused.start && absolute < focused.end
      lines.push(selected ? selectionBand(line) : line)
    }
    for (let index = visible.lines.length; index < bodyHeight; index += 1) lines.push('')
    if (queuedRows.length > 0) lines.push(...queuedRows)
    if (notice !== undefined) {
      const tone: ThemeStyle = !toastActive && state.error !== undefined ? 'error' : 'warning'
      lines.push(paint(theme, tone, truncate(notice, columns)))
    }
    pillRow = null
    if (pill !== undefined) {
      lines.push(pill)
      pillRow = lines.length
    }
    lines.push(...footer)
    lines.push(...menu)
    const composerStart = lines.length
    lines.push(...composer.lines)
    cursor = { row: composerStart + composer.cursorRow + 1, column: composer.cursorColumn }
    lines.push(usage)
    screen.draw(lines.slice(0, rows), cursor)
    if (state.toast !== undefined && state.toast.until <= now) state.toast = undefined
    ensureTick()
  }

  // Show the picker immediately instead of flashing the chat shell while the
  // first Host round-trip runs.
  const pickerMode = options.resume === undefined && options.create !== true
  if (pickerMode) {
    state.startup = { kind: 'sessions', cwd: canonicalPath(options.cwd), sessions: [], index: 0, loading: true }
  }

  backend.onDisconnect?.(() => {
    beginReconnect()
  })

  screen.onResizeRequest(() => schedule())
  screen.start()
  refreshGit()
  gitTimer = setInterval(refreshGit, 4000)
  reportHerdr(state.view)

  // Accept input before the first Host round-trip. A slow or broken Host must
  // never leave the user staring at an unresponsive alternate screen.
  input.setEncoding('utf8')
  input.on('data', onData)
  input.on('end', onEnd)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  render()

  try {
    await refreshWorkspaces()
    const resume = options.resume
    if (resume !== undefined) {
      await openSession(resume)
    } else if (options.create === true) {
      await createSession(options.cwd, options.workspaceId)
    } else {
      await prepareStartup()
    }
    state.status = 'idle'
    schedule()
    pollTimer = setInterval(() => {
      if (state.startup !== undefined) {
        void refreshSessions(state.startup.workspace?.id)
      } else {
        void refreshSessions(workspaceIdForCwd(canonicalPath(state.view?.header.cwd ?? options.cwd)))
      }
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
  return COMMAND_SPECS.flatMap(({ name, description }) => wrapText(`${name}  ${description}`, width)).map((line) => paint(theme, 'dim', line))
}

export function blocksFor(events: SessionView['events'], verbose = false): Block[] {
  return buildBlocks(events, verbose)
}

export function sanitizeComposer(text: string): string {
  return sanitizeText(text)
}
