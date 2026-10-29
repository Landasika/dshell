/**
 * Host plugin integration harness (DS-004 seed).
 *
 * Loads the real dshell-host plugin against a simulated DSH PluginContext and
 * talks NDJSON over the actual Unix socket it opens, so command dispatch is
 * exercised exactly as the CLI sees it.
 */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { apply } = await import('../dist/plugin/index.js')

function createFakeCtx() {
  const agents = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    agents: {
      get: (sessionId) => agents.get(sessionId),
      list: () => [...agents.values()],
      resume: async () => {
        throw new Error('resume is not part of these tests')
      },
      create: async () => {
        throw new Error('create is not part of these tests')
      },
    },
    sessions: {},
    sessionQuery: {
      listSessions: async () => [],
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    effect: (setup) => {
      const off = setup()
      if (typeof off === 'function' || (off && typeof off.then === 'function')) disposers.push(off)
    },
  }
  return { ctx, agents, listeners, disposers }
}

/** An agent with a real, manipulable inbox — enough for queue commands. */
function makeAgent(sessionId) {
  const state = { cancelled: 0 }
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove(requestId) {
      this.nextTurn = this.nextTurn.filter((message) => message.id !== requestId)
      this.nextStep = this.nextStep.filter((message) => message.id !== requestId)
    },
    replace(requestId, message) {
      const swap = (list) => list.map((item) => (item.id === requestId ? message : item))
      this.nextTurn = swap(this.nextTurn)
      this.nextStep = swap(this.nextStep)
    },
  }
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    inbox,
    followup() {},
    steer() {},
    cancel() {
      state.cancelled += 1
    },
  }
  return { agent, state, inbox }
}

class NdjClient {
  constructor(socketPath) {
    this.messages = []
    this.waiters = []
    this.socket = connect(socketPath)
    this.socket.setEncoding('utf8')
    this.buffer = ''
    this.socket.on('data', (chunk) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline === -1) return
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.length === 0) continue
        const message = JSON.parse(line)
        const waiter = this.waiters.shift()
        if (waiter === undefined) {
          this.messages.push(message)
        } else {
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
    })
    this.closed = new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.once('close', () => resolve())
    })
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  /** Resolve with the next message; rejects after `ms` of silence. */
  async next(ms = 2000) {
    const buffered = this.messages.shift()
    if (buffered !== undefined) return buffered
    return await new Promise((resolve, reject) => {
      const entry = {
        timer: undefined,
        resolve: (message) => resolve(message),
      }
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== entry)
        reject(new Error(`timed out waiting for a plugin message; got ${JSON.stringify(this.messages)}`))
      }, ms)
      this.waiters.push(entry)
    })
  }

  /** All messages that arrive within `ms`, in order (drains the buffer). */
  async burst(ms = 150) {
    const out = []
    for (;;) {
      try {
        out.push(await this.next(ms))
      } catch {
        break
      }
    }
    this.messages.length = 0
    return out
  }

  destroy() {
    this.socket.destroy()
  }
}

async function startHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-plugin-'))
  const socketPath = join(directory, 'dshell.sock')
  const harness = createFakeCtx()
  await apply(harness.ctx, { socketPath })
  t.after(async () => {
    for (const disposer of harness.disposers) await disposer?.()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...harness, socketPath }
}

test('hello completes the handshake against the real plugin', async (t) => {
  const { socketPath } = await startHarness(t)
  const client = new NdjClient(socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next()
  assert.equal(welcome.type, 'welcome')
  assert.equal(welcome.protocol, 2)
  assert.equal(welcome.capabilities.includes('prompt'), true)
})

test('queue/edit rewrites one prompt and leaves it queued (DS-001)', async (t) => {
  const { agents, socketPath } = await startHarness(t)
  const { inbox } = makeAgent('s1')
  agents.set('s1', makeAgent('s1').agent)
  // Reuse one inbox instance so assertions can see the plugin's mutations.
  const unit = makeAgent('s1')
  agents.set('s1', unit.agent)
  unit.inbox.nextTurn.push({ id: 'r1', role: 'user', content: [{ type: 'text', text: 'old text' }], source: { kind: 'user' } })

  const client = new NdjClient(socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'queue/edit', sessionId: 's1', requestId: 'r1', text: 'edited text' })
  const replies = await client.burst()
  const updates = replies.filter((message) => message.type === 'queue-updated')
  assert.deepEqual(
    updates.map((message) => message.action),
    ['edit'],
    `expected exactly one edit ack, got ${JSON.stringify(replies)}`,
  )
  assert.equal(replies.some((message) => message.type === 'error'), false)
  const queued = [...unit.inbox.nextTurn, ...unit.inbox.nextStep]
  assert.equal(queued.length, 1, 'the edited prompt must stay in the inbox')
  assert.equal(queued[0]?.content?.[0]?.text, 'edited text')
})

test('queue/remove deletes exactly one prompt (DS-001)', async (t) => {
  const { agents, socketPath } = await startHarness(t)
  const unit = makeAgent('s1')
  agents.set('s1', unit.agent)
  unit.inbox.nextTurn.push({ id: 'r1', role: 'user', content: [{ type: 'text', text: 'bye' }], source: { kind: 'user' } })

  const client = new NdjClient(socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'queue/remove', sessionId: 's1', requestId: 'r1' })
  const replies = await client.burst()
  assert.deepEqual(
    replies.filter((message) => message.type === 'queue-updated').map((message) => message.action),
    ['remove'],
  )
  assert.equal([...unit.inbox.nextTurn, ...unit.inbox.nextStep].length, 0)
})

test('session/cancel cancels the agent without unrelated replies (DS-001)', async (t) => {
  const { agents, socketPath } = await startHarness(t)
  const unit = makeAgent('s1')
  agents.set('s1', unit.agent)
  unit.inbox.nextTurn.push({ id: 'r1', role: 'user', content: [{ type: 'text', text: 'waiting' }], source: { kind: 'user' } })

  const client = new NdjClient(socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'session/cancel', sessionId: 's1', requestId: 'r1' })
  const replies = await client.burst()
  assert.deepEqual(
    replies.map((message) => message.type),
    ['cancelled'],
    `session/cancel must produce only its ack, got ${JSON.stringify(replies)}`,
  )
  assert.equal(unit.state.cancelled, 1)
  assert.equal([...unit.inbox.nextTurn, ...unit.inbox.nextStep].length, 1, 'cancel itself does not edit the inbox')
})

test('queue commands reject unknown, empty, and consumed items with a single error', async (t) => {
  const { agents, socketPath } = await startHarness(t)
  const unit = makeAgent('s1')
  agents.set('s1', unit.agent)

  const client = new NdjClient(socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'queue/edit', sessionId: 's1', requestId: 'missing', text: 'x' })
  let replies = await client.burst()
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.type, 'error')
  assert.equal(replies[0]?.code, 'QUEUE_ITEM_NOT_FOUND')

  unit.inbox.nextTurn.push({ id: 'r1', role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } })
  client.send({ type: 'queue/edit', sessionId: 's1', requestId: 'r1', text: '   ' })
  replies = await client.burst()
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.code, 'BAD_REQUEST')
  assert.equal(unit.inbox.nextTurn[0]?.content?.[0]?.text, 'a', 'an empty edit must not consume the item')

  client.send({ type: 'queue/remove', sessionId: 's1', requestId: 'nope' })
  replies = await client.burst()
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.code, 'QUEUE_ITEM_NOT_FOUND')

  client.send({ type: 'queue/edit', sessionId: 'ghost', requestId: 'r1', text: 'x' })
  replies = await client.burst()
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.code, 'QUEUE_ITEM_NOT_FOUND')
})
