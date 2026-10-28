import type { SessionEvent } from '../protocol/index.js'

/** One prompt waiting in the Host's inbox, queued by any client. */
export interface InboxItem {
  id: string
  text: string
  target: 'next-turn' | 'next-step'
  rpcId?: string
}

export interface InboxState {
  nextTurn: InboxItem[]
  nextStep: InboxItem[]
}

export const EMPTY_INBOX: InboxState = { nextTurn: [], nextStep: [] }

function textOf(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

function toItem(message: unknown, target: InboxItem['target']): InboxItem | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const source = record.source as Record<string, unknown> | undefined
  return {
    id,
    text: textOf(record),
    target,
    ...(typeof source?.rpcId === 'string' ? { rpcId: source.rpcId } : {}),
  }
}

/**
 * Rebuild the pending inbox from `agent/inbox/spliced` events.
 *
 * dsh treats the inbox as a projection over these durable events: each one
 * says "at `start` remove `removedCount` entries, then insert these messages".
 * Folding them client-side gives every client the same queue, including rows
 * another terminal (or the Web UI) queued.
 */
export function foldInbox(events: readonly SessionEvent[]): InboxState {
  const state: InboxState = { nextTurn: [], nextStep: [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const target = data.target
    if (target !== 'next-turn' && target !== 'next-step') continue
    const list = target === 'next-turn' ? state.nextTurn : state.nextStep
    const start = Math.max(0, Math.min(list.length, typeof data.start === 'number' ? data.start : list.length))
    const removed = typeof data.removedCount === 'number' ? Math.max(0, data.removedCount) : 0
    const inserted: InboxItem[] = []
    if (Array.isArray(data.inserted)) {
      for (const message of data.inserted) {
        const item = toItem(message, target)
        if (item !== undefined) inserted.push(item)
      }
    }
    list.splice(start, removed, ...inserted)
  }
  return state
}
