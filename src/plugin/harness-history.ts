import type { SessionEvent, SessionHeader } from '../protocol/index.js'

export interface HistoryPage {
  records: readonly { type: 'event'; event: SessionEvent }[]
  hasMore: boolean
}
export interface HistoryOpening extends HistoryPage {
  type: 'snapshot'
  header: SessionHeader
  cursor: number
  projections?: { values?: Record<string, unknown> }
}
export interface HarnessHistoryOwner {
  follow?(request: { address: { kind: 'session'; sessionId: string }; maxMessages: number },
    signal: AbortSignal): AsyncIterable<HistoryOpening | { type: string }>
  page?(request: { address: { kind: 'session'; sessionId: string }; throughSeq: number; beforeSeq?: number; maxMessages: number },
    signal: AbortSignal): Promise<HistoryPage>
}

/** The opening cursor belongs to the owner and fixes the cut for all older pages. */
export async function openHistory(owner: HarnessHistoryOwner, sessionId: string, signal: AbortSignal): Promise<HistoryOpening> {
  if (!owner.follow || !owner.page) throw new Error('Host has no paged history owner')
  const abort = new AbortController()
  const onAbort = (): void => abort.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const iterator = owner.follow({ address: { kind: 'session', sessionId }, maxMessages: 80 }, abort.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('Host returned no history opening')
    return first.value as HistoryOpening
  } finally {
    abort.abort()
    signal.removeEventListener('abort', onAbort)
    await iterator.return?.()
  }
}

export function historyEvents(page: HistoryPage): SessionEvent[] {
  return page.records.filter(record => record.type === 'event').map(record => record.event)
}

