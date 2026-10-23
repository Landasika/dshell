/** Wire protocol between the dshell CLI and the dshell-host plugin. */
export const PROTOCOL_VERSION = 1 as const

/** Capabilities advertised by a protocol-v1 host. */
export const CAPABILITIES = [
  'list',
  'attach',
  'prompt',
  'event',
  'stream',
  'status',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export type DshellErrorCode =
  | 'HOST_NOT_RUNNING'
  | 'SOCKET_PERMISSION_DENIED'
  | 'PLUGIN_MISSING'
  | 'PROTOCOL_MISMATCH'
  | 'DSH_VERSION_UNSUPPORTED'
  | 'CAPABILITY_MISSING'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_LIVE'
  | 'BAD_REQUEST'
  | 'INTERNAL'

export interface SessionSummary {
  sessionId: string
  cwd?: string
  createdAt?: number
  live?: boolean
  persisted?: boolean
  formatStatus?: string
}

export interface SessionHeader {
  id: string
  cwd?: string
  createdAt?: number
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
}

export interface PongMessage {
  type: 'pong'
  time: number
}

export interface SessionsMessage {
  type: 'sessions'
  sessions: SessionSummary[]
}

export interface AttachedMessage {
  type: 'attached'
  sessionId: string
  header: SessionHeader
  cursor: number
  events: SessionEvent[]
}

export interface DetachedMessage {
  type: 'detached'
}

export interface AcceptedMessage {
  type: 'accepted'
  sessionId: string
  requestId: string
  mode: 'queue'
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
  | { type: 'attach'; sessionId: string }
  | { type: 'detach' }
  | { type: 'prompt'; sessionId: string; text: string; mode?: 'queue'; requestId?: string }

export type ServerMessage =
  | WelcomeMessage
  | PongMessage
  | SessionsMessage
  | AttachedMessage
  | DetachedMessage
  | AcceptedMessage
  | EventMessage
  | StreamMessage
  | StatusMessage
  | ErrorMessage
