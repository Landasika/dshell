import { randomUUID } from 'node:crypto'

import { DshellError, HostConnection } from '../client/socket-client.js'
import type {
  AttachedMessage,
  ServerMessage,
  SessionEvent,
  SessionHeader,
  SessionsMessage,
} from '../protocol/index.js'
import { isStreamStart, streamChunkText } from './stream.js'
import {
  BackendError,
  type CreateSessionOptions,
  type DshellBackend,
  type DshellCapabilities,
  type SendOptions,
  type SendReceipt,
  type SessionHandle,
  type SessionSummary,
  type SessionView,
  type WorkspaceSummary,
} from './types.js'

function mapError(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  if (error instanceof DshellError) {
    return new BackendError(error.code, error.message, error.action)
  }
  return new BackendError('INTERNAL', error instanceof Error ? error.message : String(error))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackendError('REQUEST_TIMEOUT', message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(mapError(error))
      },
    )
  })
}

function capabilitiesFrom(welcome: { capabilities?: readonly string[] } | null): DshellCapabilities {
  const has = (name: string) => welcome?.capabilities?.includes(name) === true
  return {
    list: has('list'),
    attach: has('attach'),
    prompt: has('prompt'),
    streaming: has('stream'),
    workspaces: has('list'),
    createSession: false,
    cancel: false,
    steer: false,
    paging: false,
    approvals: false,
  }
}

/**
 * Socket-backed adapter. One control connection serves listings; every open
 * session gets its own connection so multiple sessions can be subscribed
 * independently by the P3 session core.
 */
export class SocketBackend implements DshellBackend {
  private readonly socketPath: string
  private control: HostConnection | null = null
  private readonly handles = new Set<SocketSessionHandle>()

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  get connected(): boolean {
    return this.control !== null
  }

  async connect(): Promise<void> {
    if (this.control !== null) throw new BackendError('ALREADY_CONNECTED', 'backend is already connected')
    try {
      this.control = await HostConnection.connect(this.socketPath)
    } catch (error) {
      throw mapError(error)
    }
  }

  async disconnect(): Promise<void> {
    for (const handle of [...this.handles]) handle.dispose()
    this.handles.clear()
    this.control?.close()
    this.control = null
  }

  capabilities(): DshellCapabilities {
    return capabilitiesFrom(this.control?.welcome ?? null)
  }

  async listSessions(workspaceId?: string): Promise<SessionSummary[]> {
    const connection = this.requireControl()
    connection.send({ type: 'list' })
    let message: SessionsMessage
    try {
      message = await connection.waitFor<SessionsMessage>(
        (candidate) => candidate.type === 'sessions',
        10_000,
      )
    } catch (error) {
      throw mapError(error)
    }
    const sessions = message.sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      live: session.live,
      persisted: session.persisted,
      status: session.live === true ? 'running' : 'idle',
    }))
    if (workspaceId === undefined) return sessions
    return sessions.filter((session) => workspaceIdFor(session.cwd) === workspaceId)
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const sessions = await this.listSessions()
    const byPath = new Map<string, WorkspaceSummary>()
    for (const session of sessions) {
      const cwd = session.cwd
      if (cwd === undefined) continue
      const existing = byPath.get(cwd)
      if (existing !== undefined) {
        existing.sessionIds?.push(session.sessionId)
        continue
      }
      byPath.set(cwd, {
        id: `workspace:${cwd}`,
        path: cwd,
        title: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
        sessionIds: [session.sessionId],
      })
    }
    return [...byPath.values()]
  }

  async createSession(_options?: CreateSessionOptions): Promise<SessionHandle> {
    throw new BackendError(
      'UNSUPPORTED_CAPABILITY',
      'this Host cannot create sessions from dshell yet',
      'Create the session in the Web UI, then run dshell list.',
    )
  }

  async openSession(sessionId: string): Promise<SessionHandle> {
    this.requireControl()
    let connection: HostConnection
    try {
      connection = await HostConnection.connect(this.socketPath)
    } catch (error) {
      throw mapError(error)
    }
    const handle = new SocketSessionHandle(sessionId, connection)
    try {
      await handle.start()
    } catch (error) {
      handle.dispose()
      throw mapError(error)
    }
    this.handles.add(handle)
    return handle
  }

  private requireControl(): HostConnection {
    if (this.control === null) {
      throw new BackendError('NOT_CONNECTED', 'backend is not connected')
    }
    return this.control
  }
}

function workspaceIdFor(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : `workspace:${cwd}`
}

export class SocketSessionHandle implements SessionHandle {
  readonly id: string
  header: SessionHeader = { id: '' }

  private readonly connection: HostConnection
  private readonly listeners = new Set<(view: SessionView) => void>()
  private readonly buffered: ServerMessage[] = []
  private readonly events: SessionEvent[] = []
  private cursor = -1
  private status: SessionView['status'] = 'unknown'
  private streamText = ''
  private pendingApproval: SessionView['pendingApproval']
  private ready = false
  private disposed = false
  private off: (() => void) | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private pendingAccepted: {
    resolve: (receipt: SendReceipt) => void
    reject: (error: Error) => void
  } | null = null

  constructor(sessionId: string, connection: HostConnection) {
    this.id = sessionId
    this.connection = connection
    this.header = { id: sessionId }
  }

  async start(): Promise<void> {
    const attached = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.off = this.connection.onMessage((message) => this.receive(message))
    this.connection.send({ type: 'attach', sessionId: this.id })
    try {
      await withTimeout(attached, 10_000, `timed out attaching to ${this.id}`)
    } catch (error) {
      throw mapError(error)
    }
  }

  subscribe(listener: (view: SessionView) => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): SessionView {
    return {
      sessionId: this.id,
      header: { ...this.header },
      events: this.events.map((event) => ({ ...event })),
      cursor: this.cursor,
      status: this.status,
      streamText: this.streamText,
      ...(this.pendingApproval === undefined
        ? {}
        : { pendingApproval: { ...this.pendingApproval } }),
    }
  }

  async send(text: string, options: SendOptions = {}): Promise<SendReceipt> {
    this.assertOpen()
    if (text.trim().length === 0) {
      throw new BackendError('BAD_REQUEST', 'prompt must not be empty')
    }
    if (this.pendingAccepted !== null) {
      throw new BackendError('BAD_REQUEST', 'a prompt is already awaiting acceptance')
    }
    const accepted = new Promise<SendReceipt>((resolve, reject) => {
      this.pendingAccepted = { resolve, reject }
    })
    try {
      this.connection.send({
        type: 'prompt',
        sessionId: this.id,
        text,
        mode: options.mode ?? 'queue',
        requestId: randomUUID(),
      })
      return await withTimeout(accepted, 10_000, 'timed out waiting for prompt acceptance')
    } catch (error) {
      this.pendingAccepted = null
      throw mapError(error)
    }
  }

  async cancel(): Promise<void> {
    throw new BackendError(
      'UNSUPPORTED_CAPABILITY',
      'this Host does not support cancel over the dshell protocol yet',
    )
  }

  async loadOlder(): Promise<boolean> {
    throw new BackendError(
      'UNSUPPORTED_CAPABILITY',
      'this Host does not support history paging over the dshell protocol yet',
    )
  }

  async answerApproval(): Promise<void> {
    throw new BackendError(
      'UNSUPPORTED_CAPABILITY',
      'this Host does not support approval answers over the dshell protocol yet',
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off?.()
    this.off = null
    this.listeners.clear()
    this.readyReject?.(new BackendError('SESSION_DISPOSED', 'session handle was disposed'))
    this.connection.close()
  }

  private receive(message: ServerMessage): void {
    if (!this.ready) {
      this.buffered.push(message)
      if (message.type === 'attached') {
        this.applyAttached(message)
        this.ready = true
        this.readyResolve?.()
        const pending = this.buffered.splice(0)
        for (const item of pending) this.applyMessage(item)
      } else if (message.type === 'error') {
        this.readyReject?.(new BackendError(message.code, message.message, message.action))
      }
      return
    }
    this.applyMessage(message)
  }

  private applyAttached(message: AttachedMessage): void {
    this.header = message.header
    this.events.length = 0
    this.events.push(...message.events)
    this.cursor = message.cursor
    this.status = 'idle'
    for (const event of message.events) this.noteEvent(event)
  }

  private applyMessage(message: ServerMessage): void {
    if (message.type === 'event' && message.sessionId === this.id) {
      const event = message.event
      if (event.seq <= this.cursor) return
      this.events.push(event)
      this.cursor = event.seq
      this.noteEvent(event)
      this.emit()
      return
    }
    if (message.type === 'stream' && message.sessionId === this.id) {
      const frame = message.frame
      if (isStreamStart(frame)) this.streamText = ''
      else this.streamText += streamChunkText(frame)
      this.emit()
      return
    }
    if (message.type === 'status' && message.sessionId === this.id) {
      this.status = message.status === 'running' ? 'running' : 'idle'
      this.emit()
      return
    }
    if (message.type === 'accepted' && message.sessionId === this.id) {
      const pending = this.pendingAccepted
      this.pendingAccepted = null
      pending?.resolve({ requestId: message.requestId })
      return
    }
    if (message.type === 'error') {
      const error = new BackendError(message.code, message.message, message.action)
      if (this.pendingAccepted !== null) {
        this.pendingAccepted.reject(error)
        this.pendingAccepted = null
      }
    }
  }

  private noteEvent(event: SessionEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'turn/start') this.status = 'running'
    if (event.type === 'turn/end' || event.type === 'turn/failed') this.status = 'idle'
    if (event.type === 'assistant/message') this.streamText = ''
    if (event.type === 'approval/asked') {
      this.pendingApproval = {
        requestId: String(data.id ?? `approval-${event.seq}`),
        sessionId: this.id,
        toolName: String(data.toolName ?? 'tool'),
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
      }
    }
    if (event.type === 'approval/decided') this.pendingApproval = undefined
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new BackendError('SESSION_DISPOSED', `session handle "${this.id}" is disposed`)
    }
  }
}
