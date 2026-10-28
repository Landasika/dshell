/** Wire protocol between the dshell CLI and the dshell-host plugin. */
export const PROTOCOL_VERSION = 2 as const

/** Capabilities advertised by a protocol-v2 host. */
export const CAPABILITIES = [
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
  'steer',
  'approval',
  'models',
  'providers',
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
  | 'APPROVAL_NOT_PENDING'
  | 'BAD_REQUEST'
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
  sessionId: string
  cwd?: string
  title?: string
  createdAt?: number
  live?: boolean
  persisted?: boolean
  formatStatus?: string
  workspaceId?: string
  status?: string
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
}

export interface HistoryMessage {
  type: 'history'
  sessionId: string
  events: SessionEvent[]
  /** Lowest seq in this page. Pass it as `before` to load the previous page. */
  cursor: number
  hasMore: boolean
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
  providers: ProviderEntry[]
}

export interface ProviderUpdatedMessage {
  type: 'provider-updated'
  file: string
  providerId: string
  field: ProviderField
  value: string
  providers: ProviderEntry[]
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

export interface ErrorMessage {
  type: 'error'
  code: DshellErrorCode
  message: string
  action?: string
}

export type ClientMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'ping' }
  | { type: 'list' }
  | { type: 'session/list'; workspaceId?: string }
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId?: string }
  | { type: 'watch'; sessionId: string }
  | { type: 'unwatch'; sessionId: string }
  | { type: 'workspaces' }
  | { type: 'workspace/create'; path: string; title?: string }
  | { type: 'session/create'; cwd?: string; workspaceId?: string; title?: string }
  | { type: 'session/history'; sessionId: string; before?: number; limit?: number }
  | { type: 'session/cancel'; sessionId: string; requestId?: string }
  | {
      type: 'prompt'
      sessionId: string
      text: string
      mode?: 'queue' | 'steer'
      requestId?: string
    }
  | { type: 'approval/answer'; requestId: string; outcome: ApprovalOutcome }
  | { type: 'model/catalog' }
  | { type: 'provider/list' }
  | { type: 'provider/update'; providerId: string; field: ProviderField; value: string }
  | { type: 'host/restart' }
  | { type: 'model/select'; sessionId: string; provider: string; model: string; reasoningEffort?: string }
  | { type: 'model/default'; provider: string; model: string; reasoningEffort?: string }

export type ServerMessage =
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
  | EventMessage
  | StreamMessage
  | StatusMessage
  | ApprovalRequestMessage
  | ApprovalResolvedMessage
  | ModelCatalogMessage
  | ModelSelectedMessage
  | ProviderListMessage
  | ProviderUpdatedMessage
  | HostRestartingMessage
  | ErrorMessage
