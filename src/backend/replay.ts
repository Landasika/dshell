import type { SessionEvent as WireSessionEvent, SessionHeader } from '../protocol/index.js'
import { adaptSessionEvents, type SessionEvent } from './events.js'
import type { ConversationBackend, SessionHandle, SessionSummary, SessionView } from './types.js'
import { modelSelectionFromEvents } from '../shared/model-selection.js'

export interface ReplayBackendOptions {
  sessions: { sessionId: string; header: SessionHeader; events: WireSessionEvent[]; archived?: boolean; pinned?: boolean }[]
  pageSize?: number
}

/** Read-only journal backend used to verify the conversation contract without a DSH Host. */
export class ReplayBackend implements ConversationBackend {
  private readonly handles = new Set<ReplayHandle>()
  private connectedState = false

  constructor(private readonly options: ReplayBackendOptions) {}
  get handleCount(): number { return this.handles.size }

  async connect(): Promise<void> { this.connectedState = true }
  async disconnect(): Promise<void> {
    for (const handle of [...this.handles]) handle.dispose()
    this.connectedState = false
  }
  get connected(): boolean { return this.connectedState }
  capabilities() {
    return {
      list: true, attach: true, prompt: false, promptContent: false, streaming: false, workspaces: false,
      createSession: false, cancel: false, steer: false, paging: true, approvals: false,
      questions: false, models: false, providers: false, providerKey: false,
      providerDiscover: false, skills: false, agents: false,
    }
  }
  async listWorkspaces() { return [] }
  async listSessions(_workspaceId?: string, includeArchived = false): Promise<SessionSummary[]> {
    return this.options.sessions.filter(session => includeArchived || session.archived !== true).map(session => ({
      sessionId: session.sessionId, cwd: session.header.cwd, title: session.header.title,
      createdAt: session.header.createdAt, archived: session.archived, pinned: session.pinned,
      live: false, persisted: true, status: 'idle', running: false,
    }))
  }
  async createSession(): Promise<SessionHandle> { throw new Error('replay backend is read-only') }
  async openSession(sessionId: string): Promise<SessionHandle> {
    if (!this.connectedState) throw new Error('replay backend is disconnected')
    const session = this.options.sessions.find(value => value.sessionId === sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const handle = new ReplayHandle(session, this.options.pageSize ?? 80, () => this.handles.delete(handle))
    this.handles.add(handle)
    return handle
  }
}

class ReplayHandle implements SessionHandle {
  readonly id: string
  readonly header: SessionHeader
  private readonly listeners = new Set<(view: SessionView) => void>()
  private events: SessionEvent[]
  private disposed = false
  private readonly modelSelection

  constructor(
    private readonly session: ReplayBackendOptions['sessions'][number],
    private readonly pageSize: number,
    private readonly unregister: () => void,
  ) {
    this.id = session.sessionId
    this.header = session.header
    this.modelSelection = modelSelectionFromEvents(session.events)
    this.events = adaptSessionEvents(session.events.slice(-pageSize))
  }
  subscribe(listener: (view: SessionView) => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }
  snapshot(): SessionView {
    this.assertOpen()
    return {
      sessionId: this.id, header: this.header, events: this.events,
      ...(this.modelSelection === undefined ? {} : { modelSelection: this.modelSelection }),
      cursor: this.events.at(-1)?.seq ?? -1, status: 'idle', streamText: '', streamReasoning: '',
      connected: true, hasMoreHistory: this.session.events.length > this.events.length,
      pendingApprovals: [], pendingAsks: [],
    }
  }
  async send(): Promise<never> { throw new Error('replay backend is read-only') }
  async cancel(): Promise<void> { throw new Error('replay backend is read-only') }
  async removeQueued(): Promise<void> { throw new Error('replay backend is read-only') }
  async editQueued(): Promise<void> { throw new Error('replay backend is read-only') }
  async loadOlder(limit = this.pageSize): Promise<boolean> {
    this.assertOpen()
    const oldest = this.events[0]?.seq ?? Number.POSITIVE_INFINITY
    const older = adaptSessionEvents(this.session.events.filter(event => event.seq < oldest).slice(-Math.max(1, limit)))
    if (older.length === 0) return false
    this.events = [...older, ...this.events]
    this.emit()
    return this.session.events.some(event => event.seq < (this.events[0]?.seq ?? -1))
  }
  async answerApproval(): Promise<void> { throw new Error('replay backend is read-only') }
  async answerQuestion(): Promise<void> { throw new Error('replay backend is read-only') }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.events.length = 0
    this.listeners.clear()
    this.unregister()
  }
  private emit(): void { const view = this.snapshot(); for (const listener of [...this.listeners]) listener(view) }
  private assertOpen(): void { if (this.disposed) throw new Error('session handle is disposed') }
}
