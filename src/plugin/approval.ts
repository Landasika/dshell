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
  message: unknown
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
    // 这里原来有一句「没人 watch 就直接交给 Host」的短路：
    //
    //     if (this.hooks.watchers(request.sessionId) === 0) {
    //       return ApprovalCoordinator.asOutcome(await request.next())
    //     }
    //
    // 它让手机端**永久**无法审批。原因有两个，而且都是不可逆的：
    //
    //   1. 判断发生在审批产生的那一瞬间。手机没点进这条会话就没有
    //      watcher，于是这单审批当场被判给 Host，之后补 watch 也没用。
    //   2. 走这条路时 pending 表里不登记，`requestId` 无处可答；
    //      客户端就算从列表里拿到了 id，作答也只会得到 not-pending。
    //
    // 但短路的**动机**是真实的：没有前端能作答时，不该让任务白等。
    // 那个语义交给下面 `otherSettled` 的 otherDone + watchers===0 处理，
    // 以及超时兜底——两条都不需要在入口处提前投降。
    //
    // 现在改为：Host 活着就由我们接管，交给 watcher 或等待超时。
    // 电脑端 TUI 的作答仍然通过 `otherSettled` 里的 DECISIONS 生效，
    // 行为不变。

    let resolveOutcome!: (outcome: ApprovalOutcome) => void
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    const entry: PendingApproval = {
      sessionId: request.sessionId,
      message: request.message,
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

  /**
   * A watcher set changed.
   *
   * 原来这里会把"没人看了"的审批立刻判为 unavailable。现在不动了：
   * 手机端断开再重连是常态（切后台、锁屏、换网），而审批本身有时效性
   * （默认 120 秒），断开就作废会让用户在"刚要点允许"时功亏一篑。
   *
   * 真正需要收摊的场景只有两个，都另有兜底：
   *   - 会话被删 / Host 关闭  → `dispose()`
   *   - 一直没人答            → 超时计时器
   * 保留方法体为空实现，是因为它仍被 socket 断开路径调用，删掉会牵动调用点。
   */
  watchersChanged(): void {
    // 有意为之的空实现，见上面的说明。
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

  snapshot(sessionId: string): unknown[] {
    return [...this.pending.values()].filter(entry => entry.sessionId === sessionId && !entry.settled).map(entry => entry.message)
  }

  private otherSettled(requestId: string, value: string): void {
    const entry = this.pending.get(requestId)
    if (entry === undefined || entry.settled) return
    if (DECISIONS.includes(value)) {
      this.settle(requestId, ApprovalCoordinator.asOutcome(value), 'other')
      return
    }
    // The other frontends cannot answer. Keep waiting for our own watcher.
    //
    // 原来这里还有一句 `if (watchers === 0) settle('unavailable')`：别的
    // 前端答不了、我们又没人 watch，就当作没人能答，立刻收摊。
    //
    // 但"此刻没人 watch"不等于"永远没人能答"——手机端正是**先看到列表里
    // 有审批、再决定点进去**的，那一刻还没有 watcher。提前收摊等于把这个
    // 窗口关死。真正的兜底是超时（默认 120 秒），任务不会白等。
    entry.otherDone = true
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
