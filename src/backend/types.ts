import type {
  DshellErrorCode,
  ModelCatalog,
  ModelSelection,
  SessionEvent,
  SessionHeader,
} from '../protocol/index.js'

/** Errors surfaced by a backend, independent of the transport used underneath. */
export type BackendErrorCode =
  | DshellErrorCode
  | 'NOT_CONNECTED'
  | 'ALREADY_CONNECTED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'REQUEST_TIMEOUT'
  | 'SESSION_DISPOSED'
  | 'APPROVAL_NOT_PENDING'

export class BackendError extends Error {
  readonly code: BackendErrorCode
  readonly action?: string

  constructor(code: BackendErrorCode, message: string, action?: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.action = action
  }
}

export interface DshellCapabilities {
  /** The host can list durable sessions. */
  list: boolean
  /** The host can attach to a session and replay its history. */
  attach: boolean
  /** The host accepts prompts. */
  prompt: boolean
  /** The host streams assistant output before the durable assistant message. */
  streaming: boolean
  /** Workspace records can be listed and selected. */
  workspaces: boolean
  /** New sessions can be created without the Web UI. */
  createSession: boolean
  /** A running turn can be cancelled. */
  cancel: boolean
  /** A prompt can be steered into the current step. */
  steer: boolean
  /** Older history can be loaded incrementally. */
  paging: boolean
  /** Approval requests can be answered from this frontend. */
  approvals: boolean
  /** Provider/model catalog and live model switching are available. */
  models: boolean
}

export interface WorkspaceSummary {
  id: string
  path: string
  title: string
  sessionIds?: string[]
}

export interface SessionSummary {
  sessionId: string
  cwd?: string
  title?: string
  createdAt?: number
  live?: boolean
  persisted?: boolean
  workspaceId?: string
  status?: string
}

export interface ApprovalView {
  /** Stable id chosen by the backend for this pending request. */
  requestId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface SessionView {
  sessionId: string
  header: SessionHeader
  events: SessionEvent[]
  cursor: number
  status: 'idle' | 'running' | 'unknown'
  /** Text accumulated from the current process-local assistant stream, if any. */
  streamText: string
  /** Reasoning accumulated from the same stream (reasoning-delta chunks). */
  streamReasoning: string
  pendingApproval?: ApprovalView
}

export interface SendOptions {
  mode?: 'queue' | 'steer'
}

export interface SendReceipt {
  requestId: string
  mode?: 'queue' | 'steer'
}

/**
 * One open session. The handle owns a subscription, not the Host-side Agent:
 * disposing it must never stop a turn that the Host is still running.
 */
export interface SessionHandle {
  readonly id: string
  readonly header: SessionHeader

  /** Subscribe to the current snapshot and every later change. Returns an unsubscribe function. */
  subscribe(listener: (view: SessionView) => void): () => void
  snapshot(): SessionView

  send(text: string, options?: SendOptions): Promise<SendReceipt>
  cancel(reason?: string): Promise<void>
  /** Load one older page. Returns false when the beginning is reached. */
  loadOlder(limit?: number): Promise<boolean>
  answerApproval(requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>

  /** Drop local subscriptions and transport resources. Never disposes the Host Agent. */
  dispose(): void
}

export interface CreateSessionOptions {
  cwd?: string
  workspaceId?: string
  title?: string
}

/**
 * The only surface the CLI/TUI should use. Transport and DSH types stay below
 * this boundary so a Host upgrade only changes the adapter implementation.
 */
export interface DshellBackend {
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly connected: boolean
  capabilities(): DshellCapabilities

  listWorkspaces(): Promise<WorkspaceSummary[]>
  listSessions(workspaceId?: string): Promise<SessionSummary[]>
  createSession(options?: CreateSessionOptions): Promise<SessionHandle>
  openSession(sessionId: string): Promise<SessionHandle>

  /** Every currently routable provider/model, plus the deployment default. */
  modelCatalog(): Promise<ModelCatalog>
  /** Switch one session's model (the Host also persists it as the new default). */
  selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
  /** Persist the default model for agents created without an explicit model. */
  saveDefaultModel(selection: ModelSelection): Promise<ModelSelection>
}
