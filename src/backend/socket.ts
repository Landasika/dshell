import { randomUUID } from 'node:crypto'

import { DshellError, HostConnection } from '../client/socket-client.js'
import type {
  AgentRosterMessage,
  AttachedMessage,
  ErrorMessage,
  HostRestartingMessage,
  ModelCatalog,
  ModelCatalogMessage,
  ModelSelectedMessage,
  ModelSelection,
  ProviderCreatedMessage,
  ProviderKeyStoredMessage,
  ProviderDiscoveredMessage,
  ProviderSyncPlanMessage,
  ProviderSyncAppliedMessage,
  ProviderDeletedMessage,
  ProviderField,
  ProviderListMessage,
  ProviderUpdatedMessage,
  QuestionAnswer,
  QueueUpdatedMessage,
  ServerMessage,
  SessionCreatedMessage,
  SessionEvent,
  SessionHeader,
  SessionsMessage,
  SkillMessage,
  SkillsMessage,
} from '../protocol/index.js'
import { isStreamStart, streamChunkParts } from './stream.js'
import {
  BackendError,
  type CreateSessionOptions,
  type DshellBackend,
  type DshellCapabilities,
  type NewProviderSpec,
  type ProviderList,
  type AgentRoster,
  type SendOptions,
  type SkillCatalog,
  type SendReceipt,
  type SessionHandle,
  type SessionSummary,
  type SessionView,
  type WorkspaceSummary,
} from './types.js'

/** True when the newest turn event in the log is a `turn/start`. */
function lastTurnOpen(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/end') return false
    if (type === 'turn/start') return true
  }
  return false
}

function mapError(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  if (error instanceof DshellError) {
    // A Host that predates a command answers "unknown message type"; point at
    // the restart instead of a bare BAD_REQUEST.
    if (/unknown message type/i.test(error.message)) {
      return new BackendError('UNSUPPORTED_CAPABILITY', error.message, 'restart the Host to load the current dshell-host plugin')
    }
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
    workspaces: has('workspaces'),
    createSession: has('create-session'),
    cancel: has('cancel'),
    steer: has('steer'),
    paging: has('history'),
    approvals: has('approval'),
    questions: has('questions'),
    models: has('models'),
    providers: has('providers'),
    providerKey: has('provider-key'),
    providerDiscover: has('provider-discover'),
    agents: has('agents'),
    skills: has('skills'),
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
  private readonly disconnectListeners = new Set<() => void>()
  private closingByUs = false

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  get connected(): boolean {
    return this.control !== null
  }

  async modelCatalog(): Promise<ModelCatalog> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ModelCatalogMessage>(
        { type: 'model/catalog' },
        (candidate) => candidate.type === 'model-catalog',
        20_000,
      )
      return message.catalog
    } catch (error) {
      throw mapError(error)
    }
  }

  async selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ModelSelectedMessage>(
        {
      type: 'model/select',
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
        (candidate) => candidate.type === 'model-selected',
        25_000,
      )
      return message.selected
    } catch (error) {
      throw mapError(error)
    }
  }

  async listSkills(cwd?: string, sessionId?: string): Promise<SkillCatalog> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<SkillsMessage>(
        {
          type: 'skills/list',
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        (candidate) => candidate.type === 'skills',
        20_000,
      )
      return { hub: message.hub, skills: message.skills }
    } catch (error) {
      throw mapError(error)
    }
  }

  async getSkill(name: string, cwd?: string, sessionId?: string): Promise<string> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<SkillMessage>(
        {
          type: 'skills/get',
          name,
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        (candidate) => candidate.type === 'skill',
        20_000,
      )
      return message.content
    } catch (error) {
      throw mapError(error)
    }
  }

  async agentRoster(): Promise<AgentRoster> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<AgentRosterMessage>(
        { type: 'agents/list' },
        (candidate) => candidate.type === 'agents/roster',
        15_000,
      )
      return {
        presets: message.presets,
        ...(message.defaultId === undefined ? {} : { defaultId: message.defaultId }),
      }
    } catch (error) {
      throw mapError(error)
    }
  }

  async providerList(): Promise<ProviderList> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderListMessage>(
        { type: 'provider/list' },
        (candidate) => candidate.type === 'provider-list',
        15_000,
      )
      return { file: message.file, writable: message.writable, providers: message.providers }
    } catch (error) {
      throw mapError(error)
    }
  }

  async updateProvider(providerId: string, field: ProviderField, value: string): Promise<ProviderList> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderUpdatedMessage>(
        { type: 'provider/update', providerId, field, value },
        (candidate) => candidate.type === 'provider-updated',
        15_000,
      )
      return { file: message.file, writable: true, providers: message.providers }
    } catch (error) {
      throw mapError(error)
    }
  }

  async storeProviderKey(providerId: string, value: string): Promise<ProviderList & { ref: string }> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderKeyStoredMessage>(
        { type: 'provider/api-key', providerId, value },
        (candidate) => candidate.type === 'provider-key-stored',
        15_000,
      )
      return { file: message.file, writable: true, providers: message.providers, ref: message.ref }
    } catch (error) {
      throw mapError(error)
    }
  }

  async discoverProviderModels(
    baseURL: string,
    api?: string,
    apiKey?: string,
  ): Promise<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[]> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderDiscoveredMessage>(
        { type: 'provider/discover', baseURL, ...(api === undefined ? {} : { api }), ...(apiKey === undefined ? {} : { apiKey }) },
        (candidate) => candidate.type === 'provider-discovered',
        30_000,
      )
      return message.models
    } catch (error) {
      throw mapError(error)
    }
  }

  async providerSyncPlan(providerId: string): Promise<{ added: string[]; removed: string[]; kept: number }> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderSyncPlanMessage>(
        { type: 'provider/sync-plan', providerId },
        (candidate) => candidate.type === 'provider-sync-plan',
        30_000,
      )
      return { added: message.added, removed: message.removed, kept: message.kept }
    } catch (error) {
      throw mapError(error)
    }
  }

  async applyProviderSync(providerId: string, add: string[], remove: string[]): Promise<ProviderList> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderSyncAppliedMessage>(
        { type: 'provider/sync-apply', providerId, add, remove },
        (candidate) => candidate.type === 'provider-sync-applied',
        15_000,
      )
      return { file: message.file, writable: true, providers: message.providers }
    } catch (error) {
      throw mapError(error)
    }
  }

  async createProvider(spec: NewProviderSpec): Promise<ProviderList> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderCreatedMessage>(
        {
      type: 'provider/create',
      providerId: spec.id,
      baseURL: spec.baseURL,
      models: spec.models,
      ...(spec.api === undefined ? {} : { api: spec.api }),
      ...(spec.apiKeyEnv === undefined ? {} : { apiKeyEnv: spec.apiKeyEnv }),
      ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
    },
        (candidate) => candidate.type === 'provider-created',
        15_000,
      )
      return { file: message.file, writable: true, providers: message.providers }
    } catch (error) {
      throw mapError(error)
    }
  }

  async deleteProvider(providerId: string): Promise<ProviderList> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ProviderDeletedMessage>(
        { type: 'provider/delete', providerId },
        (candidate) => candidate.type === 'provider-deleted',
        15_000,
      )
      return { file: message.file, writable: true, providers: message.providers }
    } catch (error) {
      throw mapError(error)
    }
  }

  async restartHost(): Promise<{ pid: number; argv: string[] }> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<HostRestartingMessage>(
        { type: 'host/restart' },
        (candidate) => candidate.type === 'host-restarting',
        10_000,
      )
      return { pid: message.pid, argv: message.argv }
    } catch (error) {
      throw mapError(error)
    }
  }

  async saveDefaultModel(selection: ModelSelection): Promise<ModelSelection> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<ModelSelectedMessage>(
        {
          type: 'model/default',
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
        (candidate) => candidate.type === 'model-selected',
        10_000,
      )
      return message.selected
    } catch (error) {
      throw mapError(error)
    }
  }

  async connect(): Promise<void> {
    if (this.control !== null) throw new BackendError('ALREADY_CONNECTED', 'backend is already connected')
    try {
      this.control = await HostConnection.connect(this.socketPath)
    } catch (error) {
      throw mapError(error)
    }
    const connection = this.control
    connection.onClose(() => {
      if (this.closingByUs || this.control !== connection) return
      this.control = null
      for (const handle of [...this.handles]) handle.dispose()
      this.handles.clear()
      for (const listener of [...this.disconnectListeners]) {
        try {
          listener()
        } catch {
          // Reconnect policy lives in the caller.
        }
      }
    })
  }

  async disconnect(): Promise<void> {
    this.closingByUs = true
    for (const handle of [...this.handles]) handle.dispose()
    this.handles.clear()
    this.control?.close()
    this.control = null
    this.closingByUs = false
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  capabilities(): DshellCapabilities {
    return capabilitiesFrom(this.control?.welcome ?? null)
  }

  async listSessions(workspaceId?: string): Promise<SessionSummary[]> {
    const connection = this.requireControl()
    let message: SessionsMessage
    try {
      // A shared DSH home can hold hundreds of sessions; enumeration plus
      // title snapshots is allowed to take a while before it reports empty.
      message = await connection.request<SessionsMessage>(
        { type: 'session/list', ...(workspaceId === undefined ? {} : { workspaceId }) },
        (candidate) => candidate.type === 'sessions',
        25_000,
      )
    } catch (error) {
      throw mapError(error)
    }
    const sessions = message.sessions.map((session) => ({
      ...session,
      status: session.status ?? (session.live === true ? 'running' : 'idle'),
    }))
    if (workspaceId === undefined) return sessions
    return sessions.filter((session) => session.workspaceId === workspaceId)
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const connection = this.requireControl()
    try {
      const message = await connection.request<{ type: 'workspaces'; workspaces: WorkspaceSummary[] }>(
        { type: 'workspaces' },
        (candidate) => candidate.type === 'workspaces',
        10_000,
      )
      return message.workspaces
    } catch (error) {
      throw mapError(error)
    }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionHandle> {
    const connection = this.requireControl()
    let created: SessionCreatedMessage | ErrorMessage
    try {
      created = await connection.request<SessionCreatedMessage | ErrorMessage>(
        {
          type: 'session/create',
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.title === undefined ? {} : { title: options.title }),
        },
        (candidate) => candidate.type === 'session-created' || candidate.type === 'error',
        60_000,
      )
    } catch (error) {
      throw mapError(error)
    }
    if (created.type === 'error') {
      throw new BackendError(created.code, created.message, created.action)
    }
    return this.openSession(created.sessionId)
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
  private streamReasoning = ''
  private pendingApproval: SessionView['pendingApproval']
  private pendingAsk: SessionView['pendingAsk']
  private pendingHistory: {
    resolve: (hasMore: boolean) => void
    reject: (error: Error) => void
  } | null = null
  private pendingApprovalAnswer: string | null = null
  private pendingQuestionAnswer: string | null = null
  private hasMoreHistory = true
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
    // The handshake reply is the last thing this connection waits for; every
    // later frame is fanout the handle consumes through its subscription, so
    // stop stashing history it will never claim (DS-005).
    this.connection.setBroadcastOnly()
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
      // The events array is append/rebuild-only and every event object is
      // treated as immutable downstream, so views can share it instead of
      // copying the whole history on every notify (DS-007).
      events: this.events,
      cursor: this.cursor,
      status: this.status,
      streamText: this.streamText,
      streamReasoning: this.streamReasoning,
      ...(this.pendingApproval === undefined
        ? {}
        : { pendingApproval: { ...this.pendingApproval } }),
      ...(this.pendingAsk === undefined
        ? {}
        : { pendingAsk: { ...this.pendingAsk, questions: [...this.pendingAsk.questions] } }),
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
    this.assertOpen()
    this.connection.send({ type: 'session/cancel', sessionId: this.id })
  }

  async removeQueued(requestId: string): Promise<void> {
    this.assertOpen()
    this.connection.send({ type: 'queue/remove', sessionId: this.id, requestId })
    await this.awaitQueueUpdate(requestId, 'remove')
  }

  async editQueued(requestId: string, text: string): Promise<void> {
    this.assertOpen()
    this.connection.send({ type: 'queue/edit', sessionId: this.id, requestId, text })
    await this.awaitQueueUpdate(requestId, 'edit')
  }

  private async awaitQueueUpdate(requestId: string, action: 'edit' | 'remove'): Promise<void> {
    try {
      await this.connection.waitFor<QueueUpdatedMessage>(
        (candidate) => candidate.type === 'queue-updated' && candidate.requestId === requestId && candidate.action === action,
        10_000,
      )
    } catch (error) {
      throw mapError(error)
    }
  }

  async loadOlder(limit = 50): Promise<boolean> {
    this.assertOpen()
    if (!this.hasMoreHistory) return false
    const oldest = this.events[0]?.seq
    if (oldest === undefined) return false
    if (this.pendingHistory !== null) {
      throw new BackendError('BAD_REQUEST', 'a history page is already loading')
    }
    const result = new Promise<boolean>((resolve, reject) => {
      this.pendingHistory = { resolve, reject }
    })
    this.connection.send({ type: 'session/history', sessionId: this.id, before: oldest, limit })
    return await withTimeout(result, 10_000, 'timed out loading older history')
  }

  async answerApproval(
    requestId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<void> {
    this.assertOpen()
    if (this.pendingApproval?.requestId !== requestId) {
      throw new BackendError('APPROVAL_NOT_PENDING', `approval "${requestId}" is not pending`)
    }
    if (this.pendingApprovalAnswer !== null) {
      throw new BackendError('BAD_REQUEST', 'an approval answer is already pending')
    }
    this.pendingApprovalAnswer = requestId
    this.connection.send({ type: 'approval/answer', requestId, outcome })
  }

  async answerQuestion(callId: string, answers: QuestionAnswer[]): Promise<void> {
    this.assertOpen()
    if (this.pendingQuestionAnswer !== null) {
      throw new BackendError('BAD_REQUEST', 'a question answer is already pending')
    }
    this.pendingQuestionAnswer = callId
    this.connection.send({ type: 'question/answer', sessionId: this.id, callId, answers })
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
    // Attaching in the middle of a turn must not look idle: the tail of the
    // log says whether the last turn is still open. (A current Host also sends
    // an explicit status right after `attached`.)
    this.status = lastTurnOpen(message.events) ? 'running' : 'idle'
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
      if (isStreamStart(frame)) {
        this.streamText = ''
        this.streamReasoning = ''
      } else {
        const parts = streamChunkParts(frame)
        this.streamText += parts.text
        this.streamReasoning += parts.reasoning
      }
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
      pending?.resolve({ requestId: message.requestId, mode: message.mode })
      return
    }
    if (message.type === 'history' && message.sessionId === this.id) {
      const known = new Set(this.events.map((event) => event.seq))
      const older = message.events.filter((event) => !known.has(event.seq))
      this.events.unshift(...older)
      this.events.sort((left, right) => left.seq - right.seq)
      this.hasMoreHistory = message.hasMore
      const pending = this.pendingHistory
      this.pendingHistory = null
      pending?.resolve(message.hasMore)
      this.emit()
      return
    }
    if (message.type === 'approval-request' && message.sessionId === this.id) {
      this.pendingApproval = {
        requestId: message.requestId,
        sessionId: message.sessionId,
        toolName: message.toolName,
        ...(message.callId === undefined ? {} : { callId: message.callId }),
        ...(message.reason === undefined ? {} : { reason: message.reason }),
      }
      this.status = 'running'
      this.emit()
      return
    }
    if (message.type === 'approval-resolved' && message.sessionId === this.id) {
      if (this.pendingApproval?.requestId === message.requestId) this.pendingApproval = undefined
      this.pendingApprovalAnswer = null
      this.emit()
      return
    }
    if (message.type === 'question/request' && message.sessionId === this.id) {
      this.pendingAsk = {
        sessionId: message.sessionId,
        callId: message.callId,
        questions: message.questions,
        timed: message.timed,
        ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
      }
      this.emit()
      return
    }
    if (message.type === 'question/closed' && message.sessionId === this.id) {
      if (this.pendingAsk?.callId === message.callId) this.pendingAsk = undefined
      this.emit()
      return
    }
    if (message.type === 'question-answered' && message.sessionId === this.id) {
      this.pendingQuestionAnswer = null
      this.emit()
      return
    }
    if (message.type === 'error') {
      const error = new BackendError(message.code, message.message, message.action)
      if (this.pendingAccepted !== null) {
        this.pendingAccepted.reject(error)
        this.pendingAccepted = null
      }
      if (this.pendingQuestionAnswer !== null) {
        this.pendingQuestionAnswer = null
      }
      if (this.pendingHistory !== null) {
        this.pendingHistory.reject(error)
        this.pendingHistory = null
      }
    }
  }

  private noteEvent(event: SessionEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'session/title' && typeof data.title === 'string' && data.title.length > 0) {
      this.header = { ...this.header, title: data.title }
    }
    if (event.type === 'turn/start') this.status = 'running'
    if (event.type === 'turn/end' || event.type === 'turn/failed') this.status = 'idle'
    if (event.type === 'assistant/message') {
      this.streamText = ''
      this.streamReasoning = ''
    }
    // A scheduled retry discards the failed attempt's partial output: the
    // preview must not keep claiming the model is writing through the whole
    // backoff ladder while nothing is streaming.
    if (event.type === 'llm/retry') {
      this.streamText = ''
      this.streamReasoning = ''
    }
    // Only the Host's `approval-request` message carries an answerable id.
    // The durable `approval/asked` event has its own id and may be replayed
    // from history; using it would send an answer for an already-dead request.
    if (event.type === 'approval/decided') this.pendingApproval = undefined
    if (event.type === 'tool/result') {
      const message = (data.message ?? {}) as Record<string, unknown>
      if (this.pendingAsk?.callId === message.toolCallId) this.pendingAsk = undefined
    }
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
