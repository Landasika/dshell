/**
 * Writer-held retry helper: brief, bounded retry when another writer holds
 * the session, immediate rethrow for everything else.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { retryOnWriterHeld } = await import('../dist/tui/retry.js')

function held() {
  return Object.assign(new Error('session "s" is already owned by an active write handle'), {
    code: 'SESSION_ALREADY_LIVE',
  })
}

test('retries a writer-held failure until the operation succeeds', async () => {
  const sleeps = []
  const retries = []
  let attempts = 0
  const result = await retryOnWriterHeld(
    async () => {
      attempts += 1
      if (attempts < 3) throw held()
      return 'attached'
    },
    {
      delaysMs: [10, 20, 40],
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onRetry: (attempt, total) => retries.push([attempt, total]),
    },
  )
  assert.equal(result, 'attached')
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.deepEqual(retries, [[1, 3], [2, 3]])
})

test('rethrows a non-writer-held error immediately without sleeping', async () => {
  const sleeps = []
  let attempts = 0
  await assert.rejects(
    retryOnWriterHeld(
      async () => {
        attempts += 1
        throw new Error('session gone')
      },
      {
        delaysMs: [10, 20],
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    ),
    /session gone/,
  )
  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
})

test('gives up after the last delay and throws the final error', async () => {
  const retries = []
  let attempts = 0
  await assert.rejects(
    retryOnWriterHeld(
      async () => {
        attempts += 1
        throw held()
      },
      {
        delaysMs: [5, 5],
        sleep: async () => {},
        onRetry: (attempt) => retries.push(attempt),
      },
    ),
    /already owned/,
  )
  assert.equal(attempts, 3) // initial try + both retries
  assert.deepEqual(retries, [1, 2])
})

test('succeeds on the first try without retrying', async () => {
  const retries = []
  const result = await retryOnWriterHeld(async () => 42, {
    sleep: async () => {
      throw new Error('must not sleep')
    },
    onRetry: () => retries.push('called'),
  })
  assert.equal(result, 42)
  assert.deepEqual(retries, [])
})
