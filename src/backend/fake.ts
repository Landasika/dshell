import { randomUUID } from 'node:crypto'

import type {
  ModelCatalog,
  ModelSelection,
  ProviderEntry,
  ProviderField,
  SessionEvent,
  SessionHeader,
} from '../protocol/index.js'
import {
  BackendError,
  type CreateSessionOptions,
  type DshellBackend,
  type DshellCapabilities,
  type NewProviderSpec,
  type ProviderList,
  type SendOptions,
  type SendReceipt,
  type SessionHandle,
  type SessionSummary,
  type SessionView,
  type WorkspaceSummary,
} from './types.js'

const CAPABILITIES: DshellCapabilities = {
  list: true,
  attach: true,
  prompt: true,
  streaming: true,
  workspaces: true,
  createSession: true,
  cancel: true,
  steer: true,
  paging: true,
  approvals: true,
  models: true,
  providers: true,
}

interface FakeSession {
  header: SessionHeader
  events: SessionEvent[]
  cursor: number
  status: 'idle' | 'running'
  streamText: string
  streamReasoning: string
  pendingApproval?: SessionView['pendingApproval']
}

export interface FakeSessionSeed {
  sessionId: string
  cwd?: string
  title?: string
  createdAt?: number
  events?: SessionEvent[]
}

/** In-memory backend used by adapter tests and by `dshell` UI tests. */
export class FakeBackend implements DshellBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly workspaces = new Map<string, WorkspaceSummary>()
  private readonly handles = new Set<FakeSessionHandle>()
  /** Prompts accepted while a turn was running, keyed by request id. */
  private readonly queuedPrompts: { sessionId: string; requestId: string; text: string; mode: 'queue' | 'steer' }[] = []
  private isConnected = false
  private readonly disconnectListeners = new Set<() => void>()
  private nextId = 1
  private defaultModel: ModelSelection = { provider: 'fake', model: 'fake-flash' }
  private readonly sessionModels = new Map<string, ModelSelection>()
  /** Providers the fake patch file declares; `updateProvider` mutates this. */
  private readonly providerRows: ProviderEntry[] = [
    { id: 'fake', displayName: 'Fake Provider', baseURL: 'https://api.example/v1', apiKeyEnv: 'FAKE_API_KEY', models: 2 },
    { id: 'relay', displayName: 'Relay', baseURL: 'http://relay.example:8180', models: 1 },
  ]
  private readonly catalog: ModelCatalog = {
    default: { provider: 'fake', model: 'fake-flash' },
    routableProviders: ['fake', 'relay'],
    groups: [
      {
        id: 'fake',
        name: 'Fake Provider',
        models: [
          { id: 'fake-flash', name: 'Fake Flash' },
          { id: 'fake-pro', name: 'Fake Pro', description: 'slower, stronger' },
        ],
      },
      {
        id: 'relay',
        name: 'Relay',
        models: [
          {
            id: 'relay-flash',
            name: 'Relay Flash',
            reasoning: {
              efforts: [
                { id: 'off', name: 'Off', description: 'No reasoning.' },
                { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
                { id: 'high', name: 'High', description: 'The default balance for most tasks.' },
              ],
              defaultEffort: 'low',
            },
          },
        ],
      },
    ],
    failures: [],
  }

  constructor(seeds: FakeSessionSeed[] = []) {
    for (const seed of seeds) {
      const createdAt = seed.createdAt ?? Date.now()
      this.sessions.set(seed.sessionId, {
        header: { id: seed.sessionId, cwd: seed.cwd, createdAt, ...(seed.title === undefined ? {} : { title: seed.title }) },
        events: [...(seed.events ?? [])],
        cursor: Math.max(-1, ...(seed.events ?? []).map((event) => event.seq)),
        status: 'idle',
        streamText: '',
        streamReasoning: '',
      })
      if (seed.cwd !== undefined) this.ensureWorkspace(seed.cwd)
    }
  }

  get connected(): boolean {
    return this.isConnected
  }

  async connect(): Promise<void> {
    this.isConnected = true
  }

  async disconnect(): Promise<void> {
    this.isConnected = false
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  /** Test hook: behave like a Host that exited or reloaded its plugin. */
  simulateDisconnect(): void {
    if (!this.isConnected) return
    this.isConnected = false
    for (const listener of [...this.disconnectListeners]) listener()
  }

  capabilities(): DshellCapabilities {
    return { ...CAPABILITIES }
  }

  async modelCatalog(): Promise<ModelCatalog> {
    this.assertConnected()
    return {
      ...this.catalog,
      default: { ...this.defaultModel },
      groups: this.catalog.groups.map((group) => ({ ...group, models: group.models.map((model) => ({ ...model })) })),
      routableProviders: [...this.catalog.routableProviders],
      failures: [...this.catalog.failures],
    }
  }

  async selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    this.assertConnected()
    if (!this.sessions.has(sessionId)) throw new BackendError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
    const known = this.catalog.groups.some((group) => group.id === selection.provider
      && group.models.some((model) => model.id === selection.model))
    if (!known) throw new BackendError('BAD_REQUEST', `unknown model ${selection.provider}/${selection.model}`)
    const selected = { ...selection }
    this.sessionModels.set(sessionId, selected)
    this.defaultModel = selected
    return selected
  }

  async providerList(): Promise<ProviderList> {
    this.assertConnected()
    return {
      file: '/fake/cordis.patch.yml',
      writable: true,
      providers: this.providerRows.map((row) => ({ ...row })),
    }
  }

  async updateProvider(providerId: string, field: ProviderField, value: string): Promise<ProviderList> {
    this.assertConnected()
    const row = this.providerRows.find((candidate) => candidate.id === providerId)
    if (row === undefined) throw new BackendError('BAD_REQUEST', `unknown provider ${providerId}`)
    row[field] = value
    return this.providerList()
  }

  async createProvider(spec: NewProviderSpec): Promise<ProviderList> {
    this.assertConnected()
    if (this.providerRows.some((row) => row.id === spec.id)) {
      throw new BackendError('BAD_REQUEST', `provider ${spec.id} already exists`)
    }
    this.providerRows.push({
      id: spec.id,
      ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
      ...(spec.apiKeyEnv === undefined ? {} : { apiKeyEnv: spec.apiKeyEnv }),
      baseURL: spec.baseURL,
      models: spec.models.length,
    })
    return this.providerList()
  }

  async deleteProvider(providerId: string): Promise<ProviderList> {
    this.assertConnected()
    const index = this.providerRows.findIndex((row) => row.id === providerId)
    if (index < 0) throw new BackendError('BAD_REQUEST', `unknown provider ${providerId}`)
    this.providerRows.splice(index, 1)
    return this.providerList()
  }

  async restartHost(): Promise<{ pid: number; argv: string[] }> {
    this.assertConnected()
    return { pid: 4242, argv: ['fake-dsh', 'dshell'] }
  }

  async saveDefaultModel(selection: ModelSelection): Promise<ModelSelection> {
    this.assertConnected()
    const known = this.catalog.groups.some((group) => group.id === selection.provider
      && group.models.some((model) => model.id === selection.model))
    if (!known) throw new BackendError('BAD_REQUEST', `unknown model ${selection.provider}/${selection.model}`)
    this.defaultModel = { ...selection }
    return { ...selection }
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    this.assertConnected()
    return [...this.workspaces.values()].map((workspace) => ({ ...workspace }))
  }

  async listSessions(workspaceId?: string): Promise<SessionSummary[]> {
    this.assertConnected()
    return [...this.sessions.values()]
      .filter((session) => {
        if (workspaceId === undefined) return true
        const workspace = this.workspaceFor(session.header.cwd)
        return workspace?.id === workspaceId
      })
      .map((session) => this.summary(session))
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionHandle> {
    this.assertConnected()
    const cwd = options.cwd ?? process.cwd()
    const sessionId = `fake-${this.nextId++}`
    const header: SessionHeader = { id: sessionId, cwd, createdAt: Date.now() }
    this.sessions.set(sessionId, {
      header,
      events: [],
      cursor: -1,
      status: 'idle',
      streamText: '',
      streamReasoning: '',
    })
    this.ensureWorkspace(cwd)
    const handle = new FakeSessionHandle(sessionId, this, this.sessions.get(sessionId) as FakeSession)
    this.handles.add(handle)
    return handle
  }

  async openSession(sessionId: string): Promise<SessionHandle> {
    this.assertConnected()
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new BackendError('SESSION_NOT_FOUND', `session "${sessionId}" was not found`)
    }
    const handle = new FakeSessionHandle(sessionId, this, session)
    this.handles.add(handle)
    return handle
  }

  /** Test/presentation helper: append a durable event as the Host would. */
  emit(sessionId: string, event: SessionEvent): void {
    const session = this.requireSession(sessionId)
    session.events.push(event)
    session.cursor = Math.max(session.cursor, event.seq)
    if (event.type === 'turn/start') session.status = 'running'
    if (event.type === 'turn/end' || event.type === 'turn/failed') session.status = 'idle'
    for (const handle of this.handles) {
      if (handle.id === sessionId) handle.notify()
    }
  }

  /** Remember a prompt the Host would hold behind or inside the running turn. */
  queuePrompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer'): void {
    this.queuedPrompts.push({ sessionId, requestId, text, mode })
  }

  /** Test helper: start the oldest queued prompt, as the Host does after a turn. */
  startQueued(sessionId: string): boolean {
    const index = this.queuedPrompts.findIndex((entry) => entry.sessionId === sessionId && entry.mode === 'queue')
    if (index < 0) return false
    const next = this.queuedPrompts[index]
    if (next === undefined) return false
    this.queuedPrompts.splice(index, 1)
    this.emit(sessionId, { type: 'turn/start', seq: this.requireSession(sessionId).cursor + 1, data: { turn: 1 } })
    this.deliverEntry(next)
    return true
  }

  /** Test helper: deliver a steered prompt into the running turn. */
  deliverSteer(sessionId: string): boolean {
    const index = this.queuedPrompts.findIndex((entry) => entry.sessionId === sessionId && entry.mode === 'steer')
    if (index < 0) return false
    const next = this.queuedPrompts[index]
    if (next === undefined) return false
    this.queuedPrompts.splice(index, 1)
    this.deliverEntry(next)
    return true
  }

  private deliverEntry(entry: { sessionId: string; requestId: string; text: string }): void {
    this.emit(entry.sessionId, {
      type: 'user/message',
      seq: this.requireSession(entry.sessionId).cursor + 1,
      data: {
        message: {
          id: entry.requestId,
          role: 'user',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'user' },
        },
      },
    })
  }

  /** Test helper: create a pending approval without starting a real turn. */
  askApproval(sessionId: string, question: NonNullable<SessionView['pendingApproval']>): void {
    const session = this.requireSession(sessionId)
    session.pendingApproval = question
    session.status = 'running'
    for (const handle of this.handles) handle.notify()
  }

  requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new BackendError('SESSION_NOT_FOUND', `session "${sessionId}" was not found`)
    }
    return session
  }

  private summary(session: FakeSession): SessionSummary {
    const workspace = this.workspaceFor(session.header.cwd)
    return {
      sessionId: session.header.id,
      ...(session.header.title === undefined ? {} : { title: session.header.title }),
      cwd: session.header.cwd,
      createdAt: session.header.createdAt,
      live: session.status === 'running',
      persisted: true,
      workspaceId: workspace?.id,
      status: session.status,
    }
  }

  private ensureWorkspace(cwd: string): WorkspaceSummary {
    const existing = this.workspaceFor(cwd)
    if (existing !== undefined) return existing
    const workspace: WorkspaceSummary = {
      id: `workspace-${this.workspaces.size + 1}`,
      path: cwd,
      title: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
      sessionIds: [],
    }
    this.workspaces.set(workspace.id, workspace)
    return workspace
  }

  private workspaceFor(cwd: string | undefined): WorkspaceSummary | undefined {
    if (cwd === undefined) return undefined
    return [...this.workspaces.values()].find((workspace) => workspace.path === cwd)
  }

  forget(handle: FakeSessionHandle): void {
    this.handles.delete(handle)
  }

  private assertConnected(): void {
    if (!this.isConnected) {
      throw new BackendError('NOT_CONNECTED', 'backend is not connected')
    }
  }
}

class FakeSessionHandle implements SessionHandle {
  readonly id: string
  readonly header: SessionHeader
  private readonly backend: FakeBackend
  private readonly session: FakeSession
  private readonly listeners = new Set<(view: SessionView) => void>()
  private disposed = false

  constructor(sessionId: string, backend: FakeBackend, session: FakeSession) {
    this.id = sessionId
    this.backend = backend
    this.session = session
    this.header = session.header
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
      events: this.session.events.map((event) => ({ ...event })),
      cursor: this.session.cursor,
      status: this.session.status,
      streamText: this.session.streamText,
      streamReasoning: this.session.streamReasoning,
      ...(this.session.pendingApproval === undefined
        ? {}
        : { pendingApproval: { ...this.session.pendingApproval } }),
    }
  }

  async send(text: string, options: SendOptions = {}): Promise<SendReceipt> {
    this.assertOpen()
    if (text.trim().length === 0) {
      throw new BackendError('BAD_REQUEST', 'prompt must not be empty')
    }
    const requestId = randomUUID()
    if (this.session.status === 'running') {
      // Queue waits for the next turn; steer joins the running one.
      const mode: 'queue' | 'steer' = options.mode ?? 'queue'
      this.backend.queuePrompt(this.id, requestId, text, mode)
      return { requestId, mode }
    }
    const turn = this.session.events.filter((event) => event.type === 'turn/start').length + 1
    this.append({ type: 'turn/start', seq: this.session.cursor + 1, data: { turn } })
    this.append({
      type: 'user/message',
      seq: this.session.cursor + 1,
      data: {
        message: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        },
      },
    })
    const assistant = `echo: ${text}`
    this.session.streamText = assistant
    this.append({
      type: 'assistant/message',
      seq: this.session.cursor + 1,
      data: {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: assistant }],
        },
      },
    })
    this.session.status = 'idle'
    this.append({
      type: 'turn/end',
      seq: this.session.cursor + 1,
      data: { reason: options.mode === 'steer' ? { kind: 'steered' } : { kind: 'completed' } },
    })
    return { requestId }
  }

  async cancel(): Promise<void> {
    this.assertOpen()
    if (this.session.status !== 'running') return
    this.session.status = 'idle'
    this.append({
      type: 'turn/end',
      seq: this.session.cursor + 1,
      data: { reason: { kind: 'cancelled' } },
    })
  }

  async loadOlder(): Promise<boolean> {
    this.assertOpen()
    return false
  }

  async answerApproval(
    requestId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<void> {
    this.assertOpen()
    const pending = this.session.pendingApproval
    if (pending === undefined || pending.requestId !== requestId) {
      throw new BackendError('APPROVAL_NOT_PENDING', `approval "${requestId}" is not pending`)
    }
    this.session.pendingApproval = undefined
    this.session.status = 'idle'
    this.emitChange()
    this.append({
      type: 'approval/decided',
      seq: this.session.cursor + 1,
      data: { id: requestId, outcome },
    })
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.backend.forget(this)
  }

  private append(event: SessionEvent): void {
    this.backend.emit(this.id, event)
    this.emitChange()
  }

  notify(): void {
    this.emitChange()
  }

  private emitChange(): void {
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new BackendError('SESSION_DISPOSED', `session handle "${this.id}" is disposed`)
    }
  }
}
