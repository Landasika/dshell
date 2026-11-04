import type { ModelSelection } from '../protocol/index.js'
import type { SessionEventLike } from './session-events.js'

export interface ModelSelectionState {
  lastUsed?: ModelSelection
  pending?: ModelSelection
}

export function readModelSelection(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object') return
  const row = value as Record<string, unknown>
  if (typeof row.provider !== 'string' || !row.provider || typeof row.model !== 'string' || !row.model) return
  return { provider: row.provider, model: row.model,
    ...(typeof row.reasoningEffort === 'string' ? { reasoningEffort: row.reasoningEffort } : {}) }
}

export function sameModelSelection(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort
}

/** A request already in flight must not consume a newer choice for the next request. */
export function advanceModelSelection(state: ModelSelectionState, event: SessionEventLike): ModelSelectionState {
  if (!event.data || typeof event.data !== 'object') return state
  if (event.type === 'model/selection') {
    const pending = readModelSelection(event.data)
    return pending ? { ...state, pending } : state
  }
  if (event.type !== 'request/header') return state
  const data = event.data as Record<string, any>
  const lastUsed = readModelSelection(data.header?.config ?? data.config)
  if (!lastUsed) return state
  return { lastUsed, ...(sameModelSelection(lastUsed, state.pending) ? {} : { pending: state.pending }) }
}

export function modelSelectionFromEvents(events: readonly SessionEventLike[]): ModelSelection | undefined {
  const state = events.reduce(advanceModelSelection, {} as ModelSelectionState)
  return state.pending ?? state.lastUsed
}
