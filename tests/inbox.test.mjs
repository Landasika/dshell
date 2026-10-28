import assert from 'node:assert/strict'
import test from 'node:test'

const { foldInbox } = await import('../dist/tui/inbox.js')

let seq = 0
const splice = (target, start, removedCount, texts, extra = {}) => {
  seq += 1
  return {
    type: 'agent/inbox/spliced',
    seq,
    data: {
      target,
      start,
      ...(removedCount === undefined ? {} : { removedCount }),
      inserted: texts.map((text) => ({
        id: `m${seq}-${text}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      })),
      ...extra,
    },
  }
}

test('insertions and removals fold into the pending queue', () => {
  seq = 0
  const inbox = foldInbox([
    splice('next-turn', 0, undefined, ['first']),
    splice('next-turn', 1, undefined, ['second']),
    splice('next-step', 0, undefined, ['steer now']),
  ])
  assert.deepEqual(inbox.nextTurn.map((item) => item.text), ['first', 'second'])
  assert.deepEqual(inbox.nextStep.map((item) => item.text), ['steer now'])
})

test('a claimed prompt leaves the queue, later ones shift down', () => {
  seq = 0
  const inbox = foldInbox([
    splice('next-turn', 0, undefined, ['a']),
    splice('next-turn', 1, undefined, ['b']),
    splice('next-turn', 0, 1, []),
  ])
  assert.deepEqual(inbox.nextTurn.map((item) => item.text), ['b'])
})

test('a canceled splice drops the items it removed', () => {
  seq = 0
  const inbox = foldInbox([
    splice('next-turn', 0, undefined, ['keep', 'drop']),
    splice('next-turn', 1, 1, [], { outcome: 'canceled' }),
  ])
  assert.deepEqual(inbox.nextTurn.map((item) => item.text), ['keep'])
})

test('an edit replaces the queued text in place', () => {
  seq = 0
  const inbox = foldInbox([
    splice('next-turn', 0, undefined, ['old']),
    splice('next-turn', 0, 1, ['new']),
  ])
  assert.deepEqual(inbox.nextTurn.map((item) => item.text), ['new'])
})

test('malformed splices and other events are ignored', () => {
  seq = 0
  const inbox = foldInbox([
    { type: 'turn/start', seq: 99, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 100, data: { target: 'elsewhere', start: 0, inserted: [] } },
    { type: 'agent/inbox/spliced', seq: 101, data: { target: 'next-turn', start: 5, inserted: [{ noId: true }] } },
    splice('next-turn', 0, undefined, ['ok']),
  ])
  assert.deepEqual(inbox.nextTurn.map((item) => item.text), ['ok'])
})
