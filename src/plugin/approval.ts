/**
 * Approval coordination for the dshell-host plugin.
 *
 * DSH dispatches `approval/request` as a waterfall whose fallback resolves
 * `unavailable` as soon as no later listener (typically the Web answerer)
 * can answer. That value must not end the approval while a CLI watcher is
 * still online and could answer, so this coordinator separates "the other
 * frontends cannot answer" from "this approval should close":
 *
 * - the first valid decision (CLI or other frontend) wins;
 * - `unavailable` or an error from the other frontends never wins while a
 *   watcher of ours is still connected;
 * - timeout, abort, Host shutdown, or losing the last watcher (once the
 *   other frontends are also out) closes the approval as `unavailable`;
 * - late or duplicate answers get a stable `not-pending` result.
 */

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable'
export type ApprovalSource = 'cli' | 'other' | 'timeout' | 'disconnect'

/** Outcomes the Host accepts as a real decision from an answerer. */
const DECISIONS: readonly string[] = ['allowed-once', 'rejected']

export interface ApprovalHooks {
  /** Connected clients currently watching `sessionId`. */
  watchers(sessionId: string): number
  /** Fan a protocol message out to the watchers of `sessionId`. */
  broadcast(sessionId: string, message: unknown): void
}

interface PendingApproval {
  sessionId: string
  settled: boolean
  otherDone: boolean
  resolve: (outcome: ApprovalOutcome) => void
  timer: NodeJS.Timeout
}

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly hooks: ApprovalHooks
  private closed = false

  constructor(hooks: ApprovalHooks) {
    this.hooks = hooks
  }

  /**
   * Run one approval request to its outcome. `next` is the waterfall
   * continuation: a valid decision from another frontend, or
   * `unavailable`/an error when nobody else can answer. `message` is the
   * approval-request frame broadcast to our watchers; it must carry
   * `requestId` so their answers can find this entry.
   */
  async begin(request: {
    requestId: string
    sessionId: string
    timeoutMs: number
    signal?: AbortSignal
    message: unknown
    next: () => Promise<string>
  }): Promise<ApprovalOutcome> {
    if (this.closed) return 'unavailable'
    if (this.hooks.watchers(request.sessionId) === 0) {
      // Nobody of ours is watching: stay transparent and let the Host's
      // waterfall decide (its fallback already means "unavailable").
      try {
        const outcome = await request.next()
        return ApprovalCoordinator.asOutcome(outcome)
      } catch {
        return 'unavailable'
      }
    }

    let resolveOutcome!: (outcome: ApprovalOutcome) => void
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    const entry: PendingApproval = {
      sessionId: request.sessionId,
      settled: false,
      otherDone: false,
      resolve: resolveOutcome,
      timer: setTimeout(() => {
        this.settle(request.requestId, 'unavailable', 'timeout')
      }, request.timeoutMs),
    }
    // Registered before the broadcast so an answer racing the message write
    // still finds its pending entry.
    this.pending.set(request.requestId, entry)
    this.hooks.broadcast(request.sessionId, request.message)

    const onAbort = (): void => {
      this.settle(request.requestId, 'unavailable', 'disconnect')
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    void Promise.resolve()
      .then(() => request.next())
      .then(
        (value) => this.otherSettled(request.requestId, value),
        () => this.otherSettled(request.requestId, 'unavailable'),
      )

    try {
      return await outcome
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      clearTimeout(entry.timer)
      this.pending.delete(request.requestId)
    }
  }

  /** A CLI watcher answered. Returns false when that request is not pending. */
  answer(requestId: string, outcome: 'allowed-once' | 'rejected'): boolean {
    return this.settle(requestId, outcome, 'cli')
  }

  /** A watcher set changed; close approvals nobody can answer anymore. */
  watchersChanged(): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.settled) continue
      if (entry.otherDone && this.hooks.watchers(entry.sessionId) === 0) {
        this.settle(requestId, 'unavailable', 'disconnect')
      }
    }
  }

  /** Close everything the Host shutdown leaves behind. */
  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, 'unavailable', 'disconnect')
    }
    this.closed = true
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  /** The session a pending approval belongs to, for watcher checks. */
  sessionOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId
  }

  private otherSettled(requestId: string, value: string): void {
    const entry = this.pending.get(requestId)
    if (entry === undefined || entry.settled) return
    if (DECISIONS.includes(value)) {
      this.settle(requestId, ApprovalCoordinator.asOutcome(value), 'other')
      return
    }
    // The other frontends cannot answer. Keep waiting for our own watcher;
    // if it is already gone, nothing can ever answer.
    entry.otherDone = true
    if (this.hooks.watchers(entry.sessionId) === 0) {
      this.settle(requestId, 'unavailable', 'other')
    }
  }

  private settle(requestId: string, outcome: ApprovalOutcome, source: ApprovalSource): boolean {
    const entry = this.pending.get(requestId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    clearTimeout(entry.timer)
    this.hooks.broadcast(entry.sessionId, {
      type: 'approval-resolved',
      sessionId: entry.sessionId,
      requestId,
      outcome,
      source,
    })
    entry.resolve(outcome)
    return true
  }

  private static asOutcome(value: string): ApprovalOutcome {
    return DECISIONS.includes(value) ? (value as ApprovalOutcome) : 'unavailable'
  }
}
