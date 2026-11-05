/** Wire protocol between the dshell CLI and the dshell-host plugin. */
export const PROTOCOL_VERSION = 2 as const

/** Capabilities advertised by a protocol-v2 host. */
export const CAPABILITIES = [
  'session-rename',
  'session-archive',
  'session-pin',
  'session-fork',
  'rpc-id',
  'pending-snapshot',
  'turn-correlation',
  'prompt-content',
  'list',
  'attach',
  'prompt',
  'event',
  'stream',
  'status',
  'workspaces',
  'create-session',
  'history',
  'cancel',
  'cancel-continue',
  'steer',
  'approval',
  'questions',
  'skills',
  'models',
  'providers',
  'provider-key',
  'provider-discover',
  'agents',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export type DshellErrorCode =
  | 'HOST_NOT_RUNNING'
  | 'SOCKET_PERMISSION_DENIED'
  | 'PLUGIN_MISSING'
  | 'PROTOCOL_MISMATCH'
  | 'DSH_VERSION_UNSUPPORTED'
  | 'CAPABILITY_MISSING'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_LIVE'
  | 'SESSION_ACTIVE'
  | 'INTERACTION_REQUIRED'
  | 'CONFIG_CONFLICT'
  | 'APPROVAL_NOT_PENDING'
  | 'QUESTION_NOT_PENDING'
  | 'QUEUE_ITEM_NOT_FOUND'
  | 'SKILLS_UNAVAILABLE'
  | 'SKILLS_FAILED'
  | 'SKILL_MISSING'
  | 'BAD_REQUEST'
  /**
   * 会话列表查询超时（底层 `sessionQuery.listSessions()` 没在预算内返回）。
   *
   * 单独一个码而不是复用 `INTERNAL`，是因为它的**处置方式完全不同**：
   * 这代表"这次没查到"，不是"没有会话"。客户端收到它应当保留现有列表、
   * 提示刷新失败，而**不是把界面清空**。
   */
  | 'SESSION_LIST_TIMEOUT'
  | 'INTERNAL'

/** One provider/model route the Host can run. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelOption {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ModelReasoningEffort[]
    defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelOption[]
  /** Route facts for the picker's disambiguation line (never the full key). */
  baseURL?: string
  keyHint?: string
}

export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

export interface ModelCatalog {
  default: ModelSelection
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}

/** One provider row of the Host's active patch file. */
export interface ProviderEntry {
  id: string
  displayName?: string
  baseURL?: string
  apiKeyEnv?: string
  /** Number of model rows declared under the provider. */
  models: number
}

/** Fields the TUI may rewrite; credentials never live in the patch file. */
export type ProviderField = 'baseURL' | 'apiKeyEnv' | 'displayName'

export interface WorkspaceSummary {
  id: string
  path: string
  title: string
  sessionIds?: string[]
}

export interface SessionSummary {
  archived?: boolean
  pinned?: boolean
  sessionId: string
  cwd?: string
  title?: string
  createdAt?: number
  /** Durable time of the last user prompt (falls back to createdAt). */
  updatedAt?: number
  live?: boolean
  persisted?: boolean
  formatStatus?: string
  workspaceId?: string
  status?: string
  /** A turn is open in this session right now (Host-computed). */
  running?: boolean
  /** The open turn is waiting on the user: an approval or a question. */
  needsInput?: 'approval' | 'question'
  /** First line of the latest real user prompt, collapsed and clipped by the Host. */
  preview?: string
}

export interface SessionHeader {
  id: string
  cwd?: string
  createdAt?: number
  title?: string
  [key: string]: unknown
}

export interface SessionEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
  [key: string]: unknown
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Ordered prompt content; image bytes and file receipts are admitted by the Host owner. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
  | { type: 'file'; receiptId: string }

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  pluginVersion: string
  dshVersion: string
  capabilities: Capability[]
  socketPath: string
  sessions: SessionSummary[]
  workspaces: WorkspaceSummary[]
}

export interface PongMessage {
  type: 'pong'
  time: number
}

export interface SessionsMessage {
  type: 'sessions'
  sessions: SessionSummary[]
}

export interface WorkspacesMessage {
  type: 'workspaces'
  workspaces: WorkspaceSummary[]
}

export interface AttachedMessage {
  type: 'attached'
  sessionId: string
  header: SessionHeader
  cursor: number
  events: SessionEvent[]
  hasMore?: boolean
  status?: string
  /** Effective owner projection; it may predate the opening history page. */
  modelSelection?: ModelSelection
  /** Last request's model, so an inherited default is not mistaken for a pending choice. */
  modelSelectionLastUsed?: ModelSelection
  approvals?: ApprovalRequestMessage[]
  questions?: QuestionRequestMessage[]
}

export interface HistoryMessage {
  type: 'history'
  sessionId: string
  events: SessionEvent[]
  /** Lowest seq in this page. Pass it as `before` to load the previous page. */
  cursor: number
  hasMore: boolean
}

/** One skill the Host's `ctx.skills` registry can serve. */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  /** Discovery bucket: project-dsh, user-dsh, custom, bundled, ... */
  source: string
  provider: string
  /** Instruction file, when the provider has a real path. */
  path?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillsMessage {
  type: 'skills'
  /** True when the catalog was read through a session's agent scope. */
  scoped?: boolean
  /** Workspace the catalog was read for (project roots are cwd sensitive). */
  cwd?: string
  /** Skill hub directories the Host is configured to serve. */
  hub: string[]
  skills: SkillEntry[]
}

export interface SkillMessage {
  type: 'skill'
  name: string
  content: string
}

export interface DetachedMessage {
  type: 'detached'
  sessionId?: string
}

export interface SessionCreatedMessage {
  type: 'session-created'
  sessionId: string
  header: SessionHeader
  workspaceId?: string
}

export interface ModelCatalogMessage {
  type: 'model-catalog'
  catalog: ModelCatalog
}

export interface ModelSelectedMessage {
  type: 'model-selected'
  /** Present when the selection applies to one session. */
  sessionId?: string
  selected: ModelSelection
  /** True when the selection was also saved as the default for new agents. */
  savedAsDefault?: boolean
}

export interface ProviderListMessage {
  type: 'provider-list'
  /** Patch file the rows were read from. */
  file: string
  writable: boolean
  source?: ProviderConfigSource
  providers: ProviderEntry[]
}

export interface ProviderConfigSource {
  kind: 'config-editor' | 'file'
  layer: 'entry'
  inherited: boolean
  overridden: boolean
}

export interface ProviderUpdatedMessage {
  type: 'provider-updated'
  file: string
  providerId: string
  field: ProviderField
  value: string
  providers: ProviderEntry[]
}

export interface ProviderSavedMessage {
  type: 'provider-saved'
  file: string
  providerId: string
  fields: ProviderField[]
  ref?: string
  source?: ProviderConfigSource
  providers: ProviderEntry[]
}

export interface ProviderKeyStoredMessage {
  type: 'provider-key-stored'
  /** Credentials file the secret landed in. */
  credentialsFile: string
  /** The reference `apiKeyEnv` now carries. */
  ref: string
  file: string
  providerId: string
  providers: ProviderEntry[]
}

export interface ProviderDiscoveredMessage {
  type: 'provider-discovered'
  /** Candidate ids the upstream listed; adoption into the patch file is manual. */
  models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]
}

export interface ProviderSyncPlanMessage {
  type: 'provider-sync-plan'
  providerId: string
  /** Declared upstream but not in the patch file. */
  added: string[]
  /** Declared in the patch file but the upstream no longer lists. */
  removed: string[]
  kept: number
}

export interface ProviderSyncAppliedMessage {
  type: 'provider-sync-applied'
  file: string
  providerId: string
  providers: ProviderEntry[]
}

export interface ProviderCreatedMessage {
  type: 'provider-created'
  file: string
  providerId: string
  providers: ProviderEntry[]
}

export interface ProviderDeletedMessage {
  type: 'provider-deleted'
  file: string
  providerId: string
  providers: ProviderEntry[]
}

/**
 * One plugin row inside an agent preset. A preset is the composition a session
 * runs: its prompt layers, tools, skills and permission policy are all rows
 * here, so showing them is showing the whole harness.
 */
export interface AgentPresetPlugin {
  /** Row id inside the preset (`persona`, `tool-bash`, …). */
  id?: string
  /** Plugin package the row mounts. */
  name: string
  disabled?: boolean
  /** Row config as the preset declares it (prompt prefix, tool options, …). */
  config?: Record<string, unknown>
}

/** One agent preset from the Host's composition. */
export interface AgentPresetSummary {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: AgentPresetPlugin[]
  /** The profile patch overrides this preset's rows, so it is user-owned. */
  overridden: boolean
}

export interface AgentRosterMessage {
  type: 'agents/roster'
  presets: AgentPresetSummary[]
  /** The preset a session created now would compose. */
  defaultId?: string
}

export interface HostRestartingMessage {
  type: 'host-restarting'
  pid: number
  /** argv the Host will re-exec, for the client's diagnostic line. */
  argv: string[]
}

export interface AcceptedMessage {
  type: 'accepted'
  sessionId: string
  requestId: string
  mode: 'queue' | 'steer'
}

export interface CancelledMessage {
  type: 'cancelled'
  sessionId: string
  requestId?: string
}

export interface QueueUpdatedMessage {
  type: 'queue-updated'
  sessionId: string
  requestId: string
  action: 'edit' | 'remove'
}

export interface EventMessage {
  type: 'event'
  sessionId: string
  event: SessionEvent
}

export interface StreamMessage {
  type: 'stream'
  sessionId: string
  frame: unknown
}

export interface StatusMessage {
  type: 'status'
  sessionId: string
  status: string
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'

export interface ApprovalRequestMessage {
  type: 'approval-request'
  sessionId: string
  requestId: string
  toolName: string
  callId?: string
  reason?: string
  expiresAt?: number
}

export interface ApprovalResolvedMessage {
  type: 'approval-resolved'
  sessionId: string
  requestId: string
  outcome: string
  source: 'cli' | 'other' | 'timeout' | 'disconnect'
}

/** One question the model asked through `ask_user_question`. */
export interface AskedQuestion {
  id: string
  question: string
  detail?: string
  intent?: { kind: string; approve?: string; callId?: string; [key: string]: unknown }
  header?: string
  multiSelect?: boolean
  options?: { label: string; description?: string }[]
}

/** One structured answer sent back for an `ask_user_question` call. */
export interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

/**
 * A live `user-questions/request` the Host is waiting on. The Host's
 * `ask_user_question` pauses inside a waterfall until an answerer returns, so
 * this message — not the durable log — is what makes the overlay appear the
 * moment the model asks.
 */
export interface QuestionRequestMessage {
  type: 'question/request'
  sessionId: string
  /** The `ask_user_question` call this request belongs to. */
  callId: string
  questions: AskedQuestion[]
  /** True when an unanswered wait settles as `{pending: true}` at the deadline. */
  timed: boolean
  /** Foreground wait in milliseconds, when the Host declared one. */
  timeoutMs?: number
}

/** The Host stopped waiting: answered, aborted with the turn, or the client left. */
export interface QuestionClosedMessage {
  type: 'question/closed'
  sessionId: string
  callId: string
  reason: 'answered' | 'aborted' | 'detached'
}

export interface QuestionAnsweredMessage {
  type: 'question-answered'
  sessionId: string
  callId: string
}

export interface ErrorMessage {
  type: 'error'
  code: DshellErrorCode
  message: string
  action?: string
}

export type ClientPayload =
  | { type: 'hello'; protocol: number }
  | { type: 'ping' }
  | { type: 'list' }
  | { type: 'session/list'; workspaceId?: string; includeArchived?: boolean }
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId?: string }
  | { type: 'watch'; sessionId: string }
  | { type: 'unwatch'; sessionId: string }
  | { type: 'workspaces' }
  | { type: 'workspace/create'; path: string; title?: string }
  | { type: 'session/create'; cwd?: string; workspaceId?: string; title?: string }
  | { type: 'session/rename'; sessionId: string; title: string }
  | { type: 'session/archive' | 'session/restore'; sessionId: string }
  | { type: 'session/pin'; sessionId: string; pinned: boolean }
  | { type: 'session/fork'; sessionId: string }
  | { type: 'session/history'; sessionId: string; before?: number; limit?: number }
  | { type: 'session/cancel'; sessionId: string; requestId?: string; killSubagents?: boolean; continueQueued?: boolean }
  | { type: 'queue/edit'; sessionId: string; requestId: string; text: string }
  | { type: 'queue/remove'; sessionId: string; requestId: string }
  | {
      type: 'prompt'
      sessionId: string
      /** Legacy text form; current clients send `content`. */
      text?: string
      content?: PromptContentPart[]
      mode?: 'queue' | 'steer'
      requestId?: string
      requireIdle?: boolean
    }
  | { type: 'approval/answer'; requestId: string; outcome: ApprovalOutcome }
  | { type: 'question/answer'; sessionId: string; callId: string; answers: QuestionAnswer[] }
  | { type: 'skills/list'; cwd?: string; sessionId?: string }
  | { type: 'skills/get'; name: string; cwd?: string; sessionId?: string }
  | { type: 'model/catalog' }
  | { type: 'provider/list' }
  | { type: 'provider/update'; providerId: string; field: ProviderField; value: string }
  | { type: 'provider/save'; providerId: string; changes: Partial<Record<ProviderField, string>>; apiKey?: string }
  | { type: 'provider/api-key'; providerId: string; value: string }
  | { type: 'provider/discover'; baseURL: string; api?: string; apiKey?: string }
  | { type: 'provider/sync-plan'; providerId: string }
  | { type: 'provider/sync-apply'; providerId: string; add: string[]; remove: string[] }
  | {
      type: 'provider/create'
      providerId: string
      baseURL: string
      models: string[]
      apiKeyEnv?: string
      displayName?: string
    }
  | { type: 'provider/delete'; providerId: string }
  | { type: 'agents/list' }
  | { type: 'host/restart' }
  | { type: 'model/select'; sessionId: string; provider: string; model: string; reasoningEffort?: string }
  | { type: 'model/default'; provider: string; model: string; reasoningEffort?: string }

export interface SessionUpdatedMessage {
  type: "session-updated"
  sessionId: string
  newSessionId?: string
  action: string
  title?: string
  seq?: number
}

export type ServerPayload =
  | SessionUpdatedMessage
  | WelcomeMessage
  | PongMessage
  | SessionsMessage
  | WorkspacesMessage
  | AttachedMessage
  | HistoryMessage
  | DetachedMessage
  | SessionCreatedMessage
  | AcceptedMessage
  | CancelledMessage
  | QueueUpdatedMessage
  | EventMessage
  | StreamMessage
  | StatusMessage
  | ApprovalRequestMessage
  | ApprovalResolvedMessage
  | QuestionRequestMessage
  | QuestionClosedMessage
  | QuestionAnsweredMessage
  | SkillsMessage
  | SkillMessage
  | ModelCatalogMessage
  | ModelSelectedMessage
  | ProviderListMessage
  | ProviderUpdatedMessage
  | ProviderSavedMessage
  | ProviderKeyStoredMessage
  | ProviderDiscoveredMessage
  | ProviderSyncPlanMessage
  | ProviderSyncAppliedMessage
  | ProviderCreatedMessage
  | ProviderDeletedMessage
  | AgentRosterMessage
  | HostRestartingMessage
  | ErrorMessage

/** RPC identity is distinct from prompt/approval requestId. Broadcasts omit it. */
export type ClientMessage = ClientPayload & { rpcId?: string }
export type ServerMessage = ServerPayload & { rpcId?: string }
