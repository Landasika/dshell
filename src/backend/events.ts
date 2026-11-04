import type { SessionEvent as WireSessionEvent } from '../protocol/index.js'

/** Event vocabulary consumed by dshell frontends, independent of Harness names. */
export type SessionEventType =
  | 'system/message' | 'user/message' | 'assistant/message'
  | 'tool/call' | 'tool/result' | 'todo/write' | 'todo/update'
  | 'turn/start' | 'turn/end' | 'turn/failed' | 'step/start'
  | 'request/context' | 'request/header' | 'llm/retry'
  | 'session/title' | 'model/selection' | 'agent/inbox/spliced'
  | 'subagent/catalog' | 'subagent/descriptor' | 'subagent/start' | 'subagent/end' | 'subagent/status'
  | 'approval/asked' | 'approval/decided' | 'job/registered' | 'job/settled'
  | 'error' | 'diagnostic'

export interface SessionEvent {
  type: SessionEventType
  seq: number
  time?: number
  data: Record<string, any>
  /** Original upstream event name for diagnostics and trace compatibility. */
  sourceType?: string
}

const KNOWN = new Set<SessionEventType>([
  'system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'todo/write', 'todo/update', 'turn/start', 'turn/end', 'turn/failed', 'step/start',
  'request/context', 'request/header', 'llm/retry', 'session/title', 'model/selection', 'agent/inbox/spliced',
  'subagent/catalog', 'subagent/descriptor', 'subagent/start', 'subagent/end', 'subagent/status',
  'approval/asked', 'approval/decided', 'job/registered', 'job/settled', 'error',
])

const ALIASES: Readonly<Record<string, SessionEventType>> = {
  'assistant/attempt': 'assistant/message',
  'todo/set': 'todo/write',
  'agent/child-started': 'subagent/start',
  'agent/child-ended': 'subagent/end',
}

function dataOf(event: WireSessionEvent): Record<string, any> {
  return typeof event.data === 'object' && event.data !== null ? event.data as Record<string, any> : {}
}

/** Translate one wire event once; unknown events survive as diagnostic records. */
export function adaptSessionEvent(event: WireSessionEvent): SessionEvent {
  const type = ALIASES[event.type] ?? (KNOWN.has(event.type as SessionEventType) ? event.type as SessionEventType : 'diagnostic')
  return {
    type,
    seq: Number.isSafeInteger(event.seq) ? event.seq : -1,
    ...(typeof event.time === 'number' ? { time: event.time } : {}),
    data: type === 'diagnostic' ? { sourceType: event.type, payload: dataOf(event) } : dataOf(event),
    ...(type === event.type ? {} : { sourceType: event.type }),
  }
}

export function adaptSessionEvents(events: readonly WireSessionEvent[]): SessionEvent[] {
  return events.map(adaptSessionEvent)
}
