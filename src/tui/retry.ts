/**
 * Bounded retry for operations that lost the session-writer race.
 *
 * Another Host holding the write lease is often transient (a crashed peer's
 * kernel lease releasing, a turn ending next second), so a brief backoff
 * beats failing the user's action outright. Anything that is not
 * SESSION_ALREADY_LIVE rethrows immediately — this helper never masks a
 * real failure.
 */

/** Backoff schedule: ~15s total across four attempts. */
const WRITER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000]

export interface WriterRetryOptions {
  /** Override the backoff schedule (tests pass short delays). */
  delaysMs?: readonly number[]
  /** Notified as (attempt, total) before each retry sleep. */
  onRetry?: (attempt: number, total: number) => void
  /** Override the sleep (tests inject a recorder). */
  sleep?: (ms: number) => Promise<void>
}

function isWriterHeld(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'SESSION_ALREADY_LIVE'
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

/**
 * Run `operation`, retrying while it fails with SESSION_ALREADY_LIVE.
 * Resolves with the first success; rethrows the last error once the
 * schedule is exhausted, or the first non-writer-held error.
 */
export async function retryOnWriterHeld<T>(
  operation: () => Promise<T>,
  options: WriterRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? WRITER_RETRY_DELAYS_MS
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= delays.length || !isWriterHeld(error)) throw error
      const delay = delays[attempt]
      attempt += 1
      options.onRetry?.(attempt, delays.length)
      await sleep(delay)
    }
  }
}
