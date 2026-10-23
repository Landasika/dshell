import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  type Capability,
  type DshellErrorCode,
  type ErrorMessage,
  type SessionEvent,
  type SessionHeader,
  type SessionSummary,
} from '../protocol/index.js'
import { resolveSocketPath } from '../shared/paths.js'

export const name = 'dshell-host'
export const inject = ['agents', 'sessions', 'sessionQuery', 'agentPresets', 'agentDefaultModel']

export interface Config {
  socketPath?: string
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

interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readSession(sessionId: string): Promise<SessionSnapshotLike>
  observeSession(sessionId: string, options?: { projectionMode?: 'all' | 'none' }): Promise<SessionObservationLike>
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
    resume(options: {
      resumeSessionId: string
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandleLike>
  }
  sessions: unknown
  sessionQuery: SessionQueryLike
  agentPresets?: AgentPresetRegistryLike
  agentDefaultModel?: AgentDefaultModelLike
  on(event: string, listener: (...args: any[]) => void): () => void
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
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
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
  const attached = new Map<Socket, string>()
  const handles = new Map<string, AgentHandleLike>()
  const resuming = new Map<string, Promise<AgentHandleLike>>()
  const queues = new WeakMap<Socket, Promise<void>>()
  let closing = false

  const listSessions = async (): Promise<SessionSummary[]> => {
    const records = await ctx.sessionQuery.listSessions()
    return records.map((record) => ({
      sessionId: record.header.id,
      cwd: record.header.cwd,
      createdAt: record.header.createdAt,
      live: record.live,
      persisted: record.persisted,
      formatStatus: record.formatStatus,
    }))
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
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    attached.set(socket, sessionId)
    jsonLine(socket, {
      type: 'attached',
      sessionId,
      header: snapshot.session,
      cursor: snapshot.events.at(-1)?.seq ?? 0,
      events: snapshot.events,
    })
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
    if (message.mode !== undefined && message.mode !== 'queue') {
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
    attached.set(socket, message.sessionId)
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `dshell-${randomUUID()}`

    // Acknowledge before waking the Agent: followup() may synchronously emit
    // turn/start, and the client should see `accepted` before those events.
    jsonLine(socket, {
      type: 'accepted',
      sessionId: message.sessionId,
      requestId,
      mode: 'queue',
    })

    agent.followup({
      id: requestId,
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    })
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
              action: 'Update the dshell CLI or the dshell-host plugin so both use protocol 1.',
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
            sessions: await listSessions(),
          })
          return
        }
        case 'ping':
          jsonLine(socket, { type: 'pong', time: Date.now() })
          return
        case 'list':
          jsonLine(socket, { type: 'sessions', sessions: await listSessions() })
          return
        case 'attach':
          await attach(socket, message.sessionId)
          return
        case 'detach':
          attached.delete(socket)
          jsonLine(socket, { type: 'detached' })
          return
        case 'prompt':
          await prompt(socket, message)
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

  const server = createServer((socket) => {
    clients.add(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket })
    lines.on('line', (line) => {
      if (line.trim().length > 0) enqueue(socket, line)
    })
    const cleanup = () => {
      clients.delete(socket)
      attached.delete(socket)
      queues.delete(socket)
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.on('error', (error) => {
    console.error(`[dshell-host] socket error: ${errorText(error)}`)
  })

  const disposeSessionEvent = ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== session.id) continue
      jsonLine(socket, { type: 'event', sessionId, event })
    }
  })

  const disposeAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }: {
    agent: AgentLike
    frame: unknown
  }) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== agent.id) continue
      jsonLine(socket, { type: 'stream', sessionId, frame })
    }
  })

  const disposeAgentStatus = ctx.on('agent/status', ({ agent, status }: {
    agent: AgentLike
    status: string
  }) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== agent.id) continue
      jsonLine(socket, { type: 'status', sessionId, status })
    }
  })

  try {
    await listen(server, socketPath)
    chmodSync(socketPath, 0o600)
  } catch (error) {
    disposeSessionEvent()
    disposeAssistantStream()
    disposeAgentStatus()
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
    for (const socket of clients) socket.destroy()
    clients.clear()
    attached.clear()
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
