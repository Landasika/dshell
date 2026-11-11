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

test('losing the last watcher preserves the approval for a reconnecting answerer', async () => {
  const { coordinator, state } = rig(2)
  const outcome = coordinator.begin(request({ next: async () => 'unavailable' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  state.watchers = 1
  coordinator.watchersChanged()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(coordinator.has('a1'), true, 'one watcher still online keeps the approval open')
  state.watchers = 0
  coordinator.watchersChanged()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(coordinator.has('a1'), true, 'disconnect keeps the request available')
  state.watchers = 1
  coordinator.watchersChanged()
  assert.equal(coordinator.answer('a1', 'allowed-once'), true)
  assert.equal(await outcome, 'allowed-once')
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

// 这一条断言的是**新**语义。旧版本在这里断言的是相反的：
//
//   "没有 watcher 就把决定权完全让给其它前端，插件一个字都不广播"
//
// 那个设计让手机端永久无法审批：判断发生在审批产生的那一瞬间，手机没点进
// 会话就没有 watcher，于是这单审批当场被判给 Host，之后补 watch 也没用，
// pending 表里也没登记，拿到 requestId 也答不了。
//
// 现在改为：Host 活着就接管。没有 watcher 意味着没有**广播对象**，
// 但审批本身仍然登记在案，任何拿到 requestId 的一端（手机从列表里拿）
// 都能作答。
test('without watchers the coordinator still owns the approval', async () => {
  const { coordinator, broadcasts } = rig(0)
  const outcome = coordinator.begin(request({ next: async () => 'unavailable' }))
  await new Promise((resolve) => setTimeout(resolve, 25))

  // `begin()` 是无条件调用 broadcast 的；真实 Host 里 `broadcast()` 只发给
  // `watchersFor(sessionId)`，而这里 watcher 数为 0，所以帧发出去也没有
  // 接收方。测试 rig 只是把调用记下来，不模拟"发给几个人"，所以这里不能
  // 断言 broadcasts.length === 0——那断言的是"有没有调用"，不是"谁收到了"。
  assert.equal(broadcasts.length, 1, 'the frame is emitted, but reaches zero watchers')

  // 关键在下面：它仍然 pending：requestId 可查、可作答。手机端正是靠这一点才能
  // 在"没点进会话"的情况下，从列表里拿到 requestId 后直接作答。
  assert.equal(coordinator.has('a1'), true, 'the approval stays answerable')
  assert.equal(coordinator.sessionOf('a1'), 's1')

  assert.equal(coordinator.answer('a1', 'allowed-once'), true)
  assert.equal(await outcome, 'allowed-once')
  assert.equal(broadcasts.at(-1).message.outcome, 'allowed-once')
})

test('a waterfall that cannot answer no longer closes a watcher-less approval early', async () => {
  // 旧行为：otherDone && watchers===0 → 立刻判 unavailable，手机还没来得
  // 及点进去，审批就消失了。现在交给超时兜底。
  const { coordinator } = rig(0)
  let settled = false
  const pending = coordinator.begin(request({
    timeoutMs: 200,
    next: async () => 'unavailable',
  })).then((outcome) => { settled = true; return outcome })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false, 'still waiting for someone to answer')
  assert.equal(coordinator.has('a1'), true)

  // 来得及作答
  assert.equal(coordinator.answer('a1', 'rejected'), true)
  assert.equal(await pending, 'rejected')
})

test('a watcher-less approval still times out when nobody answers', async () => {
  // 兜底：不能因为有手机端存在，就让任务无限期卡在审批上。
  const { coordinator } = rig(0)
  const outcome = await coordinator.begin(request({ timeoutMs: 120, next: async () => 'unavailable' }))
  assert.equal(outcome, 'unavailable')
})
