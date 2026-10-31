import type {
  AgentPresetSummary,
  AskedQuestion,
  DshellErrorCode,
  ModelCatalog,
  ModelSelection,
  ProviderEntry,
  ProviderField,
  QuestionAnswer,
  SessionEvent,
  SessionHeader,
  SkillEntry,
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
  | 'QUEUE_ITEM_NOT_FOUND'

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
  /** Pending `ask_user_question` calls can be answered from this frontend. */
  questions: boolean
  /** Provider/model catalog and live model switching are available. */
  models: boolean
  /** The Host can read and rewrite its provider patch file, and restart itself. */
  providers: boolean
  /** The Host credential store can hold pasted keys (`sk-…`). */
  providerKey: boolean
  /** The Host can list an upstream's models for the provider draft. */
  providerDiscover: boolean
  /** The Host exposes its `ctx.skills` catalog for browsing. */
  skills: boolean
  /** The Host can read the agent presets it composes sessions from. */
  agents: boolean
}

/** A skill catalog plus the hub roots the Host serves. */
export interface SkillCatalog {
  hub: string[]
  skills: SkillEntry[]
}

/** A provider row the TUI asks the Host to create. */
export interface NewProviderSpec {
  id: string
  baseURL: string
  /** Wire protocol; required when a model is not in the installed catalog. */
  api?: string
  apiKeyEnv?: string
  displayName?: string
  models: string[]
}

/** The agent presets the Host composes sessions from. */
export interface AgentRoster {
  presets: AgentPresetSummary[]
  /** The preset a session created now would compose. */
  defaultId?: string
}

/** The provider rows of the Host's active patch file. */
export interface ProviderList {
  file: string
  writable: boolean
  providers: ProviderEntry[]
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
  /** Durable time of the last user prompt (falls back to createdAt). */
  updatedAt?: number
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

/** A live `ask_user_question` the Host is holding open for an answer. */
export interface PendingAskView {
  sessionId: string
  callId: string
  questions: AskedQuestion[]
  /** False for the blocking legacy tool: the model waits until answered. */
  timed: boolean
  timeoutMs?: number
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
  /**
   * The Host's live question request. Durable events alone are not enough: the
   * tool blocks inside the Host, so an overlay driven only by the log would
   * appear late (or never, when no answerer is registered).
   */
  pendingAsk?: PendingAskView
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
  /** Cancel the running turn; `killSubagents` also aborts its live subagents. */
  cancel(killSubagents?: boolean): Promise<void>
  /** Delete one prompt still waiting in the Host inbox. */
  removeQueued(requestId: string): Promise<void>
  /** Rewrite one prompt still waiting in the Host inbox. */
  editQueued(requestId: string, text: string): Promise<void>
  /** Load one older page. Returns false when the beginning is reached. */
  loadOlder(limit?: number): Promise<boolean>
  answerApproval(requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>
  /** Answer a pending `ask_user_question` call with a batch of structured answers. */
  answerQuestion(callId: string, answers: QuestionAnswer[]): Promise<void>

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
  /**
   * Notified when the Host connection drops on its own (Host exit, plugin
   * reload after a config edit). Not called for a `disconnect()` the client
   * asked for. Returns an unsubscribe function.
   */
  onDisconnect?(listener: () => void): () => void
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

  /** Read the providers declared in the Host's patch file. */
  listSkills(cwd?: string, sessionId?: string): Promise<SkillCatalog>
  getSkill(name: string, cwd?: string, sessionId?: string): Promise<string>
  providerList(): Promise<ProviderList>
  /** Read the agent presets the Host would compose a session from. */
  agentRoster(): Promise<AgentRoster>
  /** Rewrite one provider field; takes effect after the Host restarts. */
  updateProvider(providerId: string, field: ProviderField, value: string): Promise<ProviderList>
  /** Store a raw key in the Host credential store; returns the ref it now answers to. */
  storeProviderKey(providerId: string, value: string): Promise<ProviderList & { ref: string }>
  /** Interrogate an upstream's model listing; candidate ids, nothing stored. */
  discoverProviderModels(baseURL: string, api?: string, apiKey?: string): Promise<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>
  /** Diff a configured provider's models against its upstream. */
  providerSyncPlan(providerId: string): Promise<{ added: string[]; removed: string[]; kept: number }>
  /** Adopt new model ids and/or drop gone ones; existing rows keep their fields. */
  applyProviderSync(providerId: string, add: string[], remove: string[]): Promise<ProviderList>
  /** Append a new provider block; takes effect after the Host restarts. */
  createProvider(spec: NewProviderSpec): Promise<ProviderList>
  /** Remove a provider block; takes effect after the Host restarts. */
  deleteProvider(providerId: string): Promise<ProviderList>
  /** Re-exec the Host process; the socket disappears and comes back. */
  restartHost(): Promise<{ pid: number; argv: string[] }>
}
