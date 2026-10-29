import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ApprovalCoordinator } = await import('../dist/plugin/approval.js')

function rig(watcherCount = 1) {
  const state = { watchers: watcherCount }
  const broadcasts = []
  const coordinator = new ApprovalCoordinator({
    watchers: (sessionId) => (sessionId === 's1' ? state.watchers : 0),
    broadcast: (sessionId, message) => broadcasts.push({ sessionId, message }),
  })
  return { coordinator, state, broadcasts }
}

const request = (over = {}) => ({
  requestId: 'a1',
  sessionId: 's1',
  timeoutMs: 60_000,
  message: { type: 'approval-request', requestId: 'a1' },
  ...over,
})

test('an immediate unavailable from the waterfall does not close the approval', async () => {
  const { coordinator, broadcasts } = rig(1)
  const outcome = coordinator.begin(request({ next: async () => 'unavailable' }))
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(broadcasts.length, 1, 'the CLI watcher still sees the request')
  assert.equal(coordinator.answer('a1', 'allowed-once'), true)
  assert.equal(await outcome, 'allowed-once')
  assert.deepEqual(
    broadcasts.at(-1),
    { sessionId: 's1', message: { type: 'approval-resolved', sessionId: 's1', requestId: 'a1', outcome: 'allowed-once', source: 'cli' } },
  )
})

test('a waterfall error is treated as unavailable, not as a decision', async () => {
  const { coordinator } = rig(1)
  const outcome = coordinator.begin(request({ next: async () => { throw new Error('web gone') } }))
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(coordinator.answer('a1', 'rejected'), true)
  assert.equal(await outcome, 'rejected')
})

test('an explicit other-frontend decision wins and settles the CLI side', async () => {
  const { coordinator, broadcasts } = rig(1)
  const outcome = coordinator.begin(request({ next: async () => 'allowed-once' }))
  assert.equal(await outcome, 'allowed-once')
  assert.equal(broadcasts.at(-1).message.source, 'other')
  // A late CLI answer is a stable not-pending, never a second decision.
  assert.equal(coordinator.answer('a1', 'rejected'), false)
})

test('a CLI rejection cannot be overridden by a later other-frontend allow', async () => {
  const { coordinator } = rig(1)
  let releaseWeb
  const web = new Promise((resolve) => { releaseWeb = resolve })
  const outcome = coordinator.begin(request({ next: () => web }))
  assert.equal(coordinator.answer('a1', 'rejected'), true)
  assert.equal(await outcome, 'rejected')
  releaseWeb('allowed-once') // late — must not resurrect or hang anything
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(coordinator.has('a1'), false)
})

test('timeout and abort end as unavailable, never allowed', async () => {
  const never = () => new Promise(() => {})
  let timed = rig(1)
  let outcome = timed.coordinator.begin(request({ timeoutMs: 20, next: never }))
  assert.equal(await outcome, 'unavailable')

  const aborted = rig(1)
  const controller = new AbortController()
  outcome = aborted.coordinator.begin(request({ signal: controller.signal, next: never }))
  controller.abort()
  assert.equal(await outcome, 'unavailable')
  assert.equal(aborted.broadcasts.at(-1).message.source, 'disconnect')
})

test('losing the last watcher closes only once the other frontends are out too', async () => {
  const { coordinator, state } = rig(2)
  const outcome = coordinator.begin(request({ next: async () => 'unavailable' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  state.watchers = 1
  coordinator.watchersChanged()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(coordinator.has('a1'), true, 'one watcher still online keeps the approval open')
  state.watchers = 0
  coordinator.watchersChanged()
  assert.equal(await outcome, 'unavailable')
})

test('a watcher leaving while the web answerer still works does not close', async () => {
  const { coordinator, state } = rig(1)
  let releaseWeb
  const web = new Promise((resolve) => { releaseWeb = resolve })
  const outcome = coordinator.begin(request({ next: () => web }))
  state.watchers = 0
  coordinator.watchersChanged()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(coordinator.has('a1'), true, 'the web answerer may still decide')
  releaseWeb('rejected')
  assert.equal(await outcome, 'rejected')
})

test('dispose settles everything unavailable and blocks new approvals', async () => {
  const { coordinator } = rig(1)
  const outcome = coordinator.begin(request({ next: () => new Promise(() => {}) }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  coordinator.dispose()
  assert.equal(await outcome, 'unavailable')
  const after = await coordinator.begin(request({ next: async () => 'allowed-once' }))
  assert.equal(after, 'unavailable', 'a disposed coordinator never approves anything')
})

test('without watchers the coordinator stays transparent to the waterfall', async () => {
  const { coordinator, broadcasts } = rig(0)
  const outcome = await coordinator.begin(request({ next: async () => 'rejected' }))
  assert.equal(outcome, 'rejected')
  assert.equal(broadcasts.length, 0)
})
