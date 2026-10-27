import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  type ApprovalRequestMessage,
  type ApprovalResolvedMessage,
  type Capability,
  type ErrorMessage,
  type HistoryMessage,
  type SessionCreatedMessage,
  type SessionEvent,
  type SessionHeader,
  type SessionSummary,
  type WorkspaceSummary,
} from '../protocol/index.js'
import { resolveSocketPath } from '../shared/paths.js'

export const name = 'dshell-host'
export const inject = [
  'agents',
  'sessions',
  'sessionQuery',
  'workspaceRegistry',
  'agentPresets',
  'agentDefaultModel',
]

export interface Config {
  socketPath?: string
  /** Hard fail-closed deadline for an unanswered CLI approval. */
  approvalTimeoutMs?: number
}

interface UserMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
}

interface AgentLike {
  id: string
  session: { id: string }
  followup(message: UserMessageLike): void
  steer(message: UserMessageLike): void
  cancel(cause: { kind: 'user' }): void
}

interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

interface SessionRecordLike {
  header: {
    id: string
    cwd?: string
    createdAt?: number
    title?: string
  }
  live: boolean
  persisted: boolean
  formatStatus?: string
}

interface SessionSnapshotLike {
  session: SessionHeader
  events: SessionEvent[]
}

interface SessionObservationLike {
  header: SessionHeader
  events: SessionEvent[]
  projections?: {
    values: {
      agentPreset?: string
      modelSelection?: {
        lastUsed?: Record<string, unknown>
      }
    }
  }
  [Symbol.dispose](): void
}

interface SessionTitleResultLike {
  sessionId: string
  status: 'fulfilled' | 'rejected'
  value?: {
    title?: {
      title?: string
    }
  }
}

interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<SessionTitleResultLike[]>
  readSession(sessionId: string): Promise<SessionSnapshotLike>
  observeSession(sessionId: string, options?: { projectionMode?: 'all' | 'none' }): Promise<SessionObservationLike>
}

interface WorkspaceLike {
  id: string
  path: string
  title: string
  sessionIds?: readonly string[]
  attachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
  create(path: string, title?: string): Promise<WorkspaceLike>
}

interface ApprovalRequestLike {
  agent: AgentLike
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

interface AgentPresetLike {
  id: string
}

interface AgentPresetRegistryLike {
  resolve(id?: string): Promise<AgentPresetLike>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

interface AgentDefaultModelLike {
  currentSelection(): Record<string, unknown>
}

interface PluginContext {
  agents: {
    get(sessionId: string): AgentLike | undefined
    list(): AgentLike[]
    resume(options: {
      resumeSessionId: string
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandleLike>
    create(options: {
      sessionId: string
      meta?: {
        cwd?: string
        agentPreset?: string
      }
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandleLike>
  }
  sessions: unknown
  sessionQuery: SessionQueryLike
  workspaceRegistry?: WorkspaceRegistryLike
  agentPresets?: AgentPresetRegistryLike
  agentDefaultModel?: AgentDefaultModelLike
  on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean; prepend?: boolean }): () => void
  effect(setup: () => void | (() => void | Promise<void>)): void
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function inferDshVersion(): string {
  const configured = process.env.DSH_VERSION
  if (configured !== undefined && configured.length > 0) return configured
  try {
    const bin = process.argv[1]
    if (bin !== undefined) {
      const parsed = JSON.parse(readFileSync(join(dirname(bin), '..', 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (typeof parsed.version === 'string') return parsed.version
    }
  } catch {
    // The plugin also runs in tests and in non-standard launchers.
  }
  return 'unknown'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mappedError(error: unknown): ErrorMessage {
  const code = (error as { code?: unknown }).code
  const message = errorText(error)
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || /session .*not found|not found/i.test(message)) {
    return {
      type: 'error',
      code: 'SESSION_NOT_FOUND',
      message,
      action: 'Run `dshell list` and attach an existing session.',
    }
  }
  if (/already registered|already live/i.test(message)) {
    return {
      type: 'error',
      code: 'SESSION_ALREADY_LIVE',
      message,
      action: 'Attach the session instead of resuming it twice.',
    }
  }
  return { type: 'error', code: 'INTERNAL', message }
}

function jsonLine(socket: Socket, message: unknown): void {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The peer may reset between the writable check and the write.
  }
}

/**
 * Bound a host-side query that may contend with another Host over the same
 * DSH home. Resolves to `undefined` on timeout so callers can degrade to an
 * empty/summary view instead of blocking every connected client.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[dshell-host] ${label} timed out after ${timeoutMs}ms`)
      resolve(undefined)
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        console.error(`[dshell-host] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
        resolve(undefined)
      },
    )
  })
}

function canConnect(socketPath: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      settle(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      settle(false)
    })
    socket.connect(socketPath)
  })
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const directory = dirname(socketPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // The directory may be owned by a manager with a different policy.
  }

  try {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket()) {
      throw new Error(`refusing to replace non-socket path: ${socketPath}`)
    }
    if (await canConnect(socketPath)) {
      throw new Error(`another dshell host is already listening on ${socketPath}`)
    }
    unlinkSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

export async function apply(ctx: PluginContext, config: Config = {}): Promise<void> {
  const socketPath = resolveSocketPath(config.socketPath)
  await prepareSocketPath(socketPath)

  const clients = new Set<Socket>()
  const watched = new Map<Socket, Set<string>>()
  const handles = new Map<string, AgentHandleLike>()
  const resuming = new Map<string, Promise<AgentHandleLike>>()
  const queues = new WeakMap<Socket, Promise<void>>()
  const pendingApprovals = new Map<string, {
    sessionId: string
    resolve: (outcome: string) => void
    timer: NodeJS.Timeout
  }>()
  const approvalTimeoutMs = config.approvalTimeoutMs ?? 120_000
  let closing = false

  const workspaceList = (): WorkspaceSummary[] => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) return []
    return registry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...(workspace.sessionIds ?? [])],
    }))
  }

  const listSessions = async (workspaceId?: string): Promise<SessionSummary[]> => {
    const records = await withTimeout(ctx.sessionQuery.listSessions(), 4_000, 'session list')
    if (records === undefined) return []
    const workspaces = workspaceList()
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
    const titles = new Map<string, string>()
    if (ctx.sessionQuery.readTitleSnapshots !== undefined && records.length > 0) {
      try {
        const observations = await withTimeout(
          ctx.sessionQuery.readTitleSnapshots(records.map((record) => record.header.id)),
          1_500,
          'session titles',
        )
        for (const observation of observations ?? []) {
          const title = observation.value?.title?.title
          if (observation.status === 'fulfilled' && typeof title === 'string' && title.length > 0) {
            titles.set(observation.sessionId, title)
          }
        }
      } catch {
        // A title is presentation metadata. A title-fold failure must not make
        // the whole session list unusable.
      }
    }
    return records
      .map((record) => {
        const workspace = record.header.cwd === undefined
          ? undefined
          : workspaceByPath.get(record.header.cwd)
        const title = titles.get(record.header.id) ?? record.header.title
        return {
          sessionId: record.header.id,
          ...(title === undefined || title.length === 0 ? {} : { title }),
          cwd: record.header.cwd,
          createdAt: record.header.createdAt,
          live: record.live,
          persisted: record.persisted,
          formatStatus: record.formatStatus,
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
          status: record.live ? 'running' : 'idle',
        }
      })
      .filter((session) => workspaceId === undefined || session.workspaceId === workspaceId)
  }

  const composeAgent = async (presetId: string | undefined): Promise<{
    agentPreset?: string
    setup?: (agentCtx: unknown) => Promise<void>
  }> => {
    const presets = ctx.agentPresets
    if (presets === undefined) return {}
    const resolved = await presets.resolve(presetId)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx: unknown) => {
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  const liveAgent = async (sessionId: string): Promise<AgentLike> => {
    const existing = ctx.agents.get(sessionId)
    if (existing !== undefined) return existing

    const pending = resuming.get(sessionId)
    if (pending !== undefined) return (await pending).agent

    const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
    let presetId: string | undefined
    let sessionModel: Record<string, unknown> | undefined
    try {
      presetId = observation.projections?.values.agentPreset
      sessionModel = observation.projections?.values.modelSelection?.lastUsed
    } finally {
      observation[Symbol.dispose]()
    }
    const composition = await composeAgent(presetId)
    const agentOptions = sessionModel ?? ctx.agentDefaultModel?.currentSelection()

    const resume = ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    })
      .then((handle) => {
        handles.set(sessionId, handle)
        return handle
      })
      .finally(() => {
        resuming.delete(sessionId)
      })
    resuming.set(sessionId, resume)
    return (await resume).agent
  }

  const sendError = (socket: Socket, error: ErrorMessage): void => {
    jsonLine(socket, error)
  }

  const watch = (socket: Socket, sessionId: string): Set<string> => {
    let sessions = watched.get(socket)
    if (sessions === undefined) {
      sessions = new Set()
      watched.set(socket, sessions)
    }
    sessions.add(sessionId)
    return sessions
  }

  const unwatch = (socket: Socket, sessionId?: string): void => {
    if (sessionId === undefined) {
      watched.delete(socket)
      return
    }
    const sessions = watched.get(socket)
    if (sessions === undefined) return
    sessions.delete(sessionId)
    if (sessions.size === 0) watched.delete(socket)
  }

  const watchersFor = (sessionId: string): Socket[] => {
    const result: Socket[] = []
    for (const [socket, sessions] of watched) {
      if (!socket.destroyed && sessions.has(sessionId)) result.push(socket)
    }
    return result
  }

  const broadcast = (sessionId: string, message: unknown): void => {
    for (const socket of watchersFor(sessionId)) jsonLine(socket, message)
  }

  const attach = async (socket: Socket, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'attach requires a sessionId',
      })
      return
    }

    if (socket.destroyed) return
    // Subscribe before reading: an event emitted between the read and the
    // subscription would otherwise be lost. The client buffers messages
    // until `attached`, then dedupes them by seq.
    watch(socket, sessionId)
    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(sessionId)
    } catch (error) {
      unwatch(socket, sessionId)
      throw error
    }
    jsonLine(socket, {
      type: 'attached',
      sessionId,
      header: snapshot.session,
      cursor: snapshot.events.at(-1)?.seq ?? -1,
      events: snapshot.events,
    })
  }

  const history = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'session/history requires a sessionId' })
      return
    }
    const snapshot = await ctx.sessionQuery.readSession(message.sessionId)
    const limit = typeof message.limit === 'number' && Number.isFinite(message.limit)
      ? Math.min(200, Math.max(1, Math.floor(message.limit)))
      : 50
    const before = typeof message.before === 'number' && Number.isFinite(message.before)
      ? message.before
      : undefined
    const end = before === undefined
      ? snapshot.events.length
      : snapshot.events.findIndex((event) => event.seq >= before)
    const safeEnd = end === -1 ? snapshot.events.length : end
    const start = Math.max(0, safeEnd - limit)
    const events = snapshot.events.slice(start, safeEnd)
    const reply: HistoryMessage = {
      type: 'history',
      sessionId: message.sessionId,
      events,
      cursor: events[0]?.seq ?? -1,
      hasMore: start > 0,
    }
    jsonLine(socket, reply)
  }

  const createWorkspace = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry',
      })
      return
    }
    if (typeof message.path !== 'string' || message.path.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'workspace/create requires a path' })
      return
    }
    await registry.create(message.path, typeof message.title === 'string' ? message.title : undefined)
    jsonLine(socket, { type: 'workspaces', workspaces: workspaceList() })
  }

  const createSession = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry, so dshell cannot create a session',
        action: 'Create the session in the Web UI, then run dshell list.',
      })
      return
    }

    let workspace: WorkspaceLike | undefined
    if (typeof message.workspaceId === 'string' && message.workspaceId.length > 0) {
      workspace = registry.get(message.workspaceId)
      if (workspace === undefined) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: `unknown workspace: ${message.workspaceId}` })
        return
      }
    } else {
      const cwd = typeof message.cwd === 'string' && message.cwd.length > 0
        ? message.cwd
        : process.cwd()
      workspace = await registry.create(cwd, typeof message.title === 'string' ? message.title : undefined)
    }

    const composition = await composeAgent(undefined)
    const agentOptions = ctx.agentDefaultModel?.currentSelection()
    const sessionId = `session-${randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: workspace.path,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    })
    handles.set(sessionId, handle)
    await workspace.attachSession?.(sessionId).catch(() => undefined)
    watch(socket, sessionId)
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const reply: SessionCreatedMessage = {
      type: 'session-created',
      sessionId,
      header: snapshot.session,
      workspaceId: workspace.id,
    }
    jsonLine(socket, reply)
  }

  const prompt = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires a sessionId',
      })
      return
    }
    if (typeof message.text !== 'string' || message.text.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires non-empty text',
      })
      return
    }
    const mode = message.mode === undefined ? 'queue' : message.mode
    if (mode !== 'queue' && mode !== 'steer') {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: `unsupported prompt mode: ${String(message.mode)}`,
      })
      return
    }

    if (socket.destroyed) return
    const agent = await liveAgent(message.sessionId)
    if (socket.destroyed) return
    watch(socket, message.sessionId)
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `dshell-${randomUUID()}`

    // Acknowledge before waking the Agent: followup() may synchronously emit
    // turn/start, and the client should see `accepted` before those events.
    jsonLine(socket, {
      type: 'accepted',
      sessionId: message.sessionId,
      requestId,
      mode,
    })

    const userMessage: UserMessageLike = {
      id: requestId,
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }
    if (mode === 'steer') agent.steer(userMessage)
    else agent.followup(userMessage)
  }

  const cancel = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'session/cancel requires a sessionId' })
      return
    }
    const agent = ctx.agents.get(message.sessionId)
    if (agent !== undefined) agent.cancel({ kind: 'user' })
    jsonLine(socket, {
      type: 'cancelled',
      sessionId: message.sessionId,
      ...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
    })
  }

  const settleApproval = (
    requestId: string,
    outcome: string,
    source: 'cli' | 'other' | 'timeout' | 'disconnect',
  ): boolean => {
    const pending = pendingApprovals.get(requestId)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    pendingApprovals.delete(requestId)
    const resolved: ApprovalResolvedMessage = {
      type: 'approval-resolved',
      sessionId: pending.sessionId,
      requestId,
      outcome,
      source,
    }
    broadcast(pending.sessionId, resolved)
    pending.resolve(outcome)
    return true
  }

  const answerApproval = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'approval/answer requires requestId' })
      return
    }
    if (message.outcome !== 'allowed-once' && message.outcome !== 'rejected') {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'approval outcome must be allowed-once or rejected' })
      return
    }
    const pending = pendingApprovals.get(message.requestId)
    if (pending === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'APPROVAL_NOT_PENDING',
        message: `approval "${message.requestId}" is not pending`,
      })
      return
    }
    if (watched.get(socket)?.has(pending.sessionId) !== true) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'this client is not watching the approval session',
      })
      return
    }
    settleApproval(message.requestId, message.outcome, 'cli')
  }

  const handleLine = async (socket: Socket, line: string): Promise<void> => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'message is not valid JSON',
      })
      return
    }

    try {
      switch (message.type) {
        case 'hello': {
          if (message.protocol !== PROTOCOL_VERSION) {
            sendError(socket, {
              type: 'error',
              code: 'PROTOCOL_MISMATCH',
              message: `protocol ${String(message.protocol)} is not supported; expected ${PROTOCOL_VERSION}`,
              action: 'Update the dshell CLI or the dshell-host plugin so both use protocol 2.',
            })
            return
          }
          jsonLine(socket, {
            type: 'welcome',
            protocol: PROTOCOL_VERSION,
            pluginVersion: packageVersion(),
            dshVersion: inferDshVersion(),
            capabilities: [...CAPABILITIES] as Capability[],
            socketPath,
            // Keep the handshake O(1). Session enumeration can block on a
            // shared DSH home (other live Hosts, locked stores); clients issue
            // an explicit `list` after connecting, where a slow path can be
            // reported without making the whole Host look absent.
            sessions: [],
            workspaces: workspaceList(),
          })
          return
        }
        case 'ping':
          jsonLine(socket, { type: 'pong', time: Date.now() })
          return
        case 'list':
        case 'session/list':
          jsonLine(socket, {
            type: 'sessions',
            sessions: await listSessions(typeof message.workspaceId === 'string' ? message.workspaceId : undefined),
          })
          return
        case 'workspaces':
          jsonLine(socket, { type: 'workspaces', workspaces: workspaceList() })
          return
        case 'workspace/create':
          await createWorkspace(socket, message)
          return
        case 'session/create':
          await createSession(socket, message)
          return
        case 'session/history':
          await history(socket, message)
          return
        case 'attach':
          await attach(socket, message.sessionId)
          return
        case 'watch':
          if (typeof message.sessionId === 'string') watch(socket, message.sessionId)
          return
        case 'unwatch':
          unwatch(socket, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          return
        case 'detach':
          unwatch(socket, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          jsonLine(socket, {
            type: 'detached',
            ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
          })
          return
        case 'prompt':
          await prompt(socket, message)
          return
        case 'session/cancel':
          cancel(socket, message)
          return
        case 'approval/answer':
          answerApproval(socket, message)
          return
        default:
          sendError(socket, {
            type: 'error',
            code: 'BAD_REQUEST',
            message: `unknown message type: ${String(message.type)}`,
          })
      }
    } catch (error) {
      sendError(socket, mappedError(error))
    }
  }

  const enqueue = (socket: Socket, line: string): void => {
    const previous = queues.get(socket) ?? Promise.resolve()
    const next = previous
      .then(() => handleLine(socket, line))
      .catch((error: unknown) => sendError(socket, mappedError(error)))
    queues.set(socket, next)
    void next.finally(() => {
      if (queues.get(socket) === next) queues.delete(socket)
    })
  }

  const cleanupSocket = (socket: Socket): void => {
    clients.delete(socket)
    unwatch(socket)
    queues.delete(socket)
    for (const [requestId, pending] of [...pendingApprovals]) {
      if (watchersFor(pending.sessionId).length === 0) {
        settleApproval(requestId, 'unavailable', 'disconnect')
      }
    }
  }

  const server = createServer((socket) => {
    clients.add(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket })
    lines.on('error', () => cleanupSocket(socket))
    lines.on('line', (line) => {
      if (line.trim().length > 0) enqueue(socket, line)
    })
    socket.on('close', () => cleanupSocket(socket))
    socket.on('error', () => cleanupSocket(socket))
  })

  server.on('error', (error) => {
    console.error(`[dshell-host] socket error: ${errorText(error)}`)
  })

  const disposeSessionEvent = ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
    broadcast(session.id, { type: 'event', sessionId: session.id, event })
  })

  const disposeAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }: {
    agent: AgentLike
    frame: unknown
  }) => {
    broadcast(agent.id, { type: 'stream', sessionId: agent.id, frame })
  })

  const disposeAgentStatus = ctx.on('agent/status', ({ agent, status }: {
    agent: AgentLike
    status: string
  }) => {
    broadcast(agent.id, { type: 'status', sessionId: agent.id, status })
  })

  const handleApproval = async (request: ApprovalRequestLike, next: () => Promise<string>): Promise<string> => {
    const sessionId = request.agent.session.id
    if (watchersFor(sessionId).length === 0) return next()

    const requestId = `approval-${randomUUID()}`
    let resolveCli!: (outcome: string) => void
    const cli = new Promise<string>((resolve) => {
      resolveCli = resolve
    })
    const timer = setTimeout(() => {
      settleApproval(requestId, 'unavailable', 'timeout')
    }, approvalTimeoutMs)
    pendingApprovals.set(requestId, { sessionId, resolve: resolveCli, timer })
    const onAbort = (): void => {
      settleApproval(requestId, 'unavailable', 'disconnect')
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const requestMessage: ApprovalRequestMessage = {
      type: 'approval-request',
      sessionId,
      requestId,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      expiresAt: Date.now() + approvalTimeoutMs,
    }
    broadcast(sessionId, requestMessage)

    const other = Promise.resolve()
      .then(() => next())
      .then(
        (outcome) => ({ source: 'other' as const, outcome }),
        () => ({ source: 'other' as const, outcome: 'unavailable' }),
      )
    const winner = await Promise.race([
      cli.then((outcome) => ({ source: 'cli' as const, outcome })),
      other,
    ])
    request.signal?.removeEventListener('abort', onAbort)
    if (winner.source === 'other' && pendingApprovals.has(requestId)) {
      settleApproval(requestId, winner.outcome, 'other')
    }
    return winner.outcome
  }

  // Agent-scoped waterfalls filter ordinary listeners by context. A global
  // listener is the supported way for the Host plugin to observe approvals
  // for every Agent it owns without duplicating the Web answerer.
  const disposeApproval = ctx.on('approval/request', handleApproval, { global: true, prepend: true })

  try {
    await listen(server, socketPath)
    chmodSync(socketPath, 0o600)
  } catch (error) {
    disposeSessionEvent()
    disposeAssistantStream()
    disposeAgentStatus()
    disposeApproval()
    await closeServer(server)
    throw error
  }

  console.error(`[dshell-host] listening on ${socketPath}`)

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    disposeSessionEvent()
    disposeAssistantStream()
    disposeAgentStatus()
    disposeApproval()
    for (const requestId of [...pendingApprovals.keys()]) {
      settleApproval(requestId, 'unavailable', 'disconnect')
    }
    for (const socket of clients) socket.destroy()
    clients.clear()
    watched.clear()
    await closeServer(server)
    for (const handle of handles.values()) {
      await handle.dispose().catch(() => {})
    }
    handles.clear()
    try {
      unlinkSync(socketPath)
    } catch {
      // Already gone.
    }
  }

  ctx.effect(() => () => close())
}
