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

function createFakeCtx(services = {}) {
  const agents = new Map()
  const sessions = new Map() // sessionId -> { header, events, live, persisted }
  const workspaces = new Map() // path -> workspace record
  const listeners = new Map()
  const disposers = []
  let workspaceSeq = 0

  const recordOf = (sessionId) => sessions.get(sessionId)
  const units = new Map()
  const makeHandle = (sessionId) => {
    let agent = agents.get(sessionId)
    if (agent === undefined) {
      const unit = makeAgent(sessionId)
      agents.set(sessionId, unit.agent)
      units.set(sessionId, unit)
      agent = unit.agent
    }
    return {
      agent,
      dispose: async () => {
        handles.delete(sessionId)
      },
    }
  }
  const handles = new Map()

  const ctx = {
    agents: {
      get: (sessionId) => agents.get(sessionId),
      list: () => [...agents.values()],
      resume: async ({ resumeSessionId }) => {
        const handle = makeHandle(resumeSessionId)
        handles.set(resumeSessionId, handle)
        return handle
      },
      create: async ({ sessionId, meta }) => {
        sessions.set(sessionId, {
          header: { id: sessionId, cwd: meta?.cwd ?? '/work', createdAt: Date.now() },
          events: [],
          live: true,
          persisted: true,
        })
        const handle = makeHandle(sessionId)
        handles.set(sessionId, handle)
        return handle
      },
    },
    sessions: {},
    sessionQuery: {
      listSessions: async () => [...sessions.values()],
      readSession: async (sessionId) => {
        const record = sessions.get(sessionId)
        if (record === undefined) throw Object.assign(new Error(`session ${sessionId} not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { session: record.header, events: [...record.events] }
      },
      observeSession: async () => ({
        projections: { values: {} },
        [Symbol.dispose]() {},
      }),
    },
    workspaceRegistry: {
      list: () => [...workspaces.values()],
      get: (id) => [...workspaces.values()].find((workspace) => workspace.id === id),
      create: async (path, title) => {
        workspaceSeq += 1
        const workspace = {
          id: `workspace:${path}`,
          path,
          title: title ?? path,
          sessionIds: [],
          attachSession: async (sessionId) => {
            workspace.sessionIds.push(sessionId)
          },
        }
        workspaces.set(path, workspace)
        return workspace
      },
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
      if (off !== undefined) disposers.push(off)
    },
    get: (name) => services[name],
    ...services,
  }
  /** Invoke the listeners the plugin registered, like DSH waterfalls would. */
  const emit = (event, ...args) => Promise.all(
    (listeners.get(event) ?? []).map((listener) => listener(...args)),
  )
  return { ctx, agents, sessions, workspaces, listeners, disposers, emit, handles, recordOf, units, services }
}

/** An agent with a real, manipulable inbox — enough for queue commands. */
function makeAgent(sessionId) {
  const state = { cancelled: 0 }
  const sent = []
  const sentMessages = []
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
  const record = (mode) => (message) => {
    sent.push({ mode, text: message.content?.[0]?.text ?? '' })
    sentMessages.push({ mode, message })
  }
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    inbox,
    followup: record('followup'),
    steer: record('steer'),
    cancel() {
      state.cancelled += 1
    },
  }
  return { agent, state, inbox, sent, sentMessages }
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

async function startHarness(t, config = {}, services = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-plugin-'))
  const socketPath = join(directory, 'dshell.sock')
  const harness = createFakeCtx(services)
  await apply(harness.ctx, { socketPath, ...config })
  t.after(async () => {
    for (const disposer of harness.disposers) await disposer?.()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...harness, socketPath }
}

/** A persisted session with events, registered for list/read/attach. */
function makeSession(harness, sessionId, events = [], header = {}) {
  harness.sessions.set(sessionId, {
    header: { id: sessionId, cwd: '/work', createdAt: 1_000, ...header },
    events,
    live: true,
    persisted: true,
  })
  return harness.sessions.get(sessionId)
}

test('agents/list reports the presets the Host composes sessions from', async (t) => {
  const configEditor = {
    configuration: () => [
      {
        entry: {
          options: {
            id: 'preset-standard',
            name: '@deepseek-ai/dsh-agent-preset',
            config: {
              id: 'standard',
              name: 'Standard',
              order: 1,
              plugins: [
                { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.' } },
                { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: true },
              ],
            },
          },
        },
        override: { plugins: [] },
      },
      {
        entry: {
          options: {
            id: 'preset-minimal',
            name: '@deepseek-ai/dsh-agent-preset',
            config: { id: 'minimal', order: 2, plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }] },
          },
        },
        override: {},
      },
      {
        entry: { options: { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: {} } },
        override: {},
      },
    ],
  }
  const agentPresets = {
    resolve: async () => ({ id: 'standard' }),
    mount: async () => undefined,
    config: { selectedDefault: { get: () => 'standard' }, default: { get: () => 'minimal' } },
  }
  const harness = await startHarness(t, {}, { configEditor, agentPresets })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next()
  assert.equal(welcome.capabilities.includes('agents'), true)

  client.send({ type: 'agents/list' })
  const roster = await client.next()
  assert.equal(roster.type, 'agents/roster')
  assert.deepEqual(roster.presets.map((preset) => preset.id), ['standard', 'minimal'])
  assert.equal(roster.defaultId, 'standard')
  assert.equal(roster.presets[0].overridden, true)
  assert.equal(roster.presets[0].plugins[1].disabled, true)
  assert.equal(roster.presets[0].plugins[0].config.prefix, 'You are a coding agent.')
  assert.equal(roster.presets[1].overridden, false)
  assert.equal(roster.presets[1].plugins.length, 1)
})

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

test('list returns persisted sessions and skips subagent children', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [], { title: 'one' })
  makeSession(harness, 's2', [], { title: 'child', origin: 'subagent', parentSession: 's1' })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'list' })
  const reply = await client.next()
  assert.equal(reply.type, 'sessions')
  assert.deepEqual(reply.sessions.map((session) => session.sessionId), ['s1'])
})

test('session/create makes an agent, a workspace, and watches it', async (t) => {
  const harness = await startHarness(t)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/create', cwd: '/work/project' })
  const reply = await client.next()
  assert.equal(reply.type, 'session-created')
  assert.match(reply.sessionId, /^session-/)
  assert.equal(reply.workspaceId, 'workspace:/work/project')
  assert.equal(reply.header.cwd, '/work/project')
  assert.equal(harness.agents.has(reply.sessionId), true)
  // The new session is watched, so broadcasts flow without another attach.
  await harness.emit('session/event', { id: reply.sessionId }, { type: 'turn/start', seq: 1, data: {} })
  const event = await client.next()
  assert.equal(event.type, 'event')
  assert.equal(event.sessionId, reply.sessionId)
})

test('attach replays history and reports a running turn', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [
    { type: 'turn/start', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: {} },
  ])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  const attached = await client.next()
  assert.equal(attached.type, 'attached')
  assert.equal(attached.cursor, 2)
  assert.equal(attached.events.length, 2)
  const status = await client.next()
  assert.equal(status.type, 'status')
  assert.equal(status.status, 'running')

  client.send({ type: 'attach', sessionId: 'ghost' })
  const missing = await client.next()
  assert.equal(missing.type, 'error')
  assert.equal(missing.code, 'SESSION_NOT_FOUND')
})

test('session/history pages backwards with hasMore', async (t) => {
  const harness = await startHarness(t)
  const events = Array.from({ length: 8 }, (_, index) => ({ type: 'user/message', seq: index + 1, data: {} }))
  makeSession(harness, 's1', events)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'session/history', sessionId: 's1', limit: 3 })
  let page = await client.next()
  assert.deepEqual(page.events.map((event) => event.seq), [6, 7, 8])
  assert.equal(page.hasMore, true)

  client.send({ type: 'session/history', sessionId: 's1', limit: 3, before: 6 })
  page = await client.next()
  assert.deepEqual(page.events.map((event) => event.seq), [3, 4, 5])
  assert.equal(page.hasMore, true)

  client.send({ type: 'session/history', sessionId: 's1', limit: 3, before: 3 })
  page = await client.next()
  assert.deepEqual(page.events.map((event) => event.seq), [1, 2])
  assert.equal(page.hasMore, false)
})

test('prompt acks, queues or steers, and resumes a cold agent', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'prompt', sessionId: 's1', text: 'hello', mode: 'queue', requestId: 'req-1' })
  const accepted = await client.next()
  assert.equal(accepted.type, 'accepted')
  assert.equal(accepted.requestId, 'req-1')
  assert.equal(accepted.mode, 'queue')
  assert.deepEqual(unit.sent, [{ mode: 'followup', text: 'hello' }])

  client.send({ type: 'prompt', sessionId: 's1', text: 'steer me', mode: 'steer' })
  const steered = await client.next()
  assert.equal(steered.mode, 'steer')
  assert.deepEqual(unit.sent, [
    { mode: 'followup', text: 'hello' },
    { mode: 'steer', text: 'steer me' },
  ])

  // A session without a live agent is resumed through the Host.
  makeSession(harness, 's2', [])
  client.send({ type: 'prompt', sessionId: 's2', text: 'wake up' })
  const resumed = await client.next()
  assert.equal(resumed.type, 'accepted')
  assert.equal(harness.agents.has('s2'), true)
  // The ack is written before the Agent is woken; give the followup a moment.
  for (let index = 0; index < 50 && (harness.units.get('s2')?.sent.length ?? 0) === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(harness.units.get('s2')?.sent, [{ mode: 'followup', text: 'wake up' }])
})

test('durable events, streams, and status fan out to every watcher', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const first = new NdjClient(harness.socketPath)
  const second = new NdjClient(harness.socketPath)
  t.after(() => first.destroy())
  t.after(() => second.destroy())
  for (const client of [first, second]) {
    client.send({ type: 'hello', protocol: 2 })
    await client.next()
    client.send({ type: 'attach', sessionId: 's1' })
    await client.next()
    await client.next() // status after attach
  }

  await harness.emit('session/event', { id: 's1' }, { type: 'assistant/message', seq: 9, data: {} })
  await harness.emit('agent/assistant-stream', { agent: { id: 's1', session: { id: 's1' } }, frame: { chunk: 'x' } })
  await harness.emit('agent/status', { agent: { id: 's1', session: { id: 's1' } }, status: 'running' })

  for (const client of [first, second]) {
    assert.equal((await client.next()).type, 'event')
    assert.equal((await client.next()).type, 'stream')
    assert.equal((await client.next()).type, 'status')
  }
})

test('approval waterfall: a CLI watcher can answer while next() waits', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  const never = new Promise(() => {})
  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
    reason: 'test approval',
    signal: new AbortController().signal,
  }, () => never)

  const request = await client.next()
  assert.equal(request.type, 'approval-request')
  assert.equal(request.toolName, 'bash')

  client.send({ type: 'approval/answer', requestId: request.requestId, outcome: 'allowed-once' })
  const resolved = await client.next()
  assert.equal(resolved.type, 'approval-resolved')
  assert.equal(resolved.outcome, 'allowed-once')
  assert.equal(resolved.source, 'cli')
  assert.equal((await outcomes)[0], 'allowed-once')

  // A late second answer is rejected, not silently ignored.
  client.send({ type: 'approval/answer', requestId: request.requestId, outcome: 'rejected' })
  const late = await client.next()
  assert.equal(late.type, 'error')
  assert.equal(late.code, 'APPROVAL_NOT_PENDING')
})

test('approval without watchers defers straight to the Web answerer', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const outcomes = await harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
  }, async () => 'rejected')
  assert.equal(outcomes[0], 'rejected')
})

test('question/answer steers a user-question-reply message (plugin level)', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({
    type: 'question/answer',
    sessionId: 's1',
    callId: 'q1',
    answers: [{ id: 'pkg', selected: ['A'], custom: 'note' }],
  })
  const reply = await client.next()
  assert.equal(reply.type, 'question-answered')
  assert.equal(reply.callId, 'q1')
  assert.equal(unit.sentMessages.length, 1)
  const steered = unit.sentMessages[0]
  assert.equal(steered.mode, 'steer')
  const message = steered.message
  assert.equal(message.source.kind, 'user-question-reply')
  assert.equal(message.source.callId, 'q1')
  const payload = JSON.parse(message.content[0].text)
  assert.deepEqual(payload.answers, [{ id: 'pkg', selected: ['A'], custom: 'note' }])
  assert.equal(payload.callId, 'q1')
})

test('question waterfall: a TUI watcher answers ask_user_question while the tool waits', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  // The durable log names the call before the tool blocks.
  await harness.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 1,
    data: {
      name: 'ask_user_question',
      callId: 'q1',
      arguments: JSON.stringify({ questions: [{ id: 'pkg', question: 'which package manager?', options: [{ label: 'pnpm' }] }] }),
    },
  })
  await client.burst()

  const questions = [{ id: 'pkg', question: 'which package manager?', options: [{ label: 'pnpm' }] }]
  const outcome = harness.emit('user-questions/request', {
    questions,
    agent: { session: { id: 's1' } },
    signal: new AbortController().signal,
  }, async () => 'from-web')

  const request = await client.next()
  assert.equal(request.type, 'question/request')
  assert.equal(request.sessionId, 's1')
  assert.equal(request.callId, 'q1')
  assert.equal(request.timed, false)
  assert.deepEqual(request.questions, questions)

  client.send({
    type: 'question/answer',
    sessionId: 's1',
    callId: 'q1',
    answers: [{ id: 'pkg', selected: ['pnpm'] }],
  })
  const first = await client.next()
  // The overlay closes before the answer acknowledgement.
  assert.equal(first.type, 'question/closed')
  assert.equal(first.reason, 'answered')
  const second = await client.next()
  assert.equal(second.type, 'question-answered')
  assert.equal(second.callId, 'q1')

  const resolved = await outcome
  // The tool reads `.answers` off the waterfall result.
  assert.deepEqual(resolved[0], { answers: [{ id: 'pkg', selected: ['pnpm'] }] })
})

test('question waterfall: no watcher defers to the Web answerer', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const resolved = await harness.emit('user-questions/request', {
    questions: [{ id: 'pkg', question: 'which?' }],
    agent: { session: { id: 's1' } },
    signal: new AbortController().signal,
  }, async () => 'from-web')
  assert.equal(resolved[0], 'from-web')
})

test('question waterfall: aborting the turn closes the overlay and rejects the tool', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  await harness.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 1,
    data: { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ id: 'pkg', question: 'which?' }] }) },
  })
  await client.burst()

  const controller = new AbortController()
  const outcome = harness.emit('user-questions/request', {
    questions: [{ id: 'pkg', question: 'which?' }],
    agent: { session: { id: 's1' } },
    signal: controller.signal,
  }, async () => 'from-web')
  // Catch now: the rejection lands before the assertions below run.
  const failure = outcome.catch((error) => error)
  assert.equal((await client.next()).type, 'question/request')

  controller.abort(new Error('turn cancelled'))
  const closed = await client.next()
  assert.equal(closed.type, 'question/closed')
  assert.equal(closed.reason, 'aborted')
  assert.match(String((await failure).message), /turn cancelled/)
})

test('question waterfall: a late answer from a second window is refused, not steered', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  await harness.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 1,
    data: { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ id: 'pkg', question: 'which?' }] }) },
  })
  await client.burst()

  const outcome = harness.emit('user-questions/request', {
    questions: [{ id: 'pkg', question: 'which?' }],
    agent: { session: { id: 's1' } },
    signal: new AbortController().signal,
  }, async () => 'from-web')
  assert.equal((await client.next()).type, 'question/request')

  client.send({ type: 'question/answer', sessionId: 's1', callId: 'q1', answers: [{ id: 'pkg', selected: ['pnpm'] }] })
  await client.next() // question/closed
  await client.next() // question-answered
  await outcome

  // The first answer settled the call; a stale second one must not steer a reply.
  client.send({ type: 'question/answer', sessionId: 's1', callId: 'q1', answers: [{ id: 'pkg', selected: ['npm'] }] })
  const rejected = await client.next()
  assert.equal(rejected.type, 'error')
  assert.equal(rejected.code, 'QUESTION_NOT_PENDING')
  assert.equal(unit.sentMessages.length, 0)
})

test('dispose unlinks the socket and settles pending approvals unavailable', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  const never = new Promise(() => {})
  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
  }, () => never)
  await client.next() // approval-request

  for (const disposer of harness.disposers) await disposer?.()
  assert.equal((await outcomes)[0], 'unavailable')
  await client.closed
  await assert.rejects(() => import('node:fs').then((fs) => fs.promises.access(harness.socketPath)))
})

test('approval survives an immediate waterfall unavailable and the CLI answers (DS-002)', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  // No Web answerer exists: the waterfall fallback resolves at once.
  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
    reason: 'sandbox escalation',
  }, async () => 'unavailable')

  const request = await client.next()
  assert.equal(request.type, 'approval-request')
  // The request must still be answerable — this is the DS-002 regression.
  await new Promise((resolve) => setTimeout(resolve, 25))
  client.send({ type: 'approval/answer', requestId: request.requestId, outcome: 'allowed-once' })
  const resolved = await client.next()
  assert.equal(resolved.type, 'approval-resolved')
  assert.equal(resolved.outcome, 'allowed-once')
  assert.equal(resolved.source, 'cli')
  assert.equal((await outcomes)[0], 'allowed-once')
})

test('a web decision settles first and a late CLI answer is not-pending (DS-002)', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
  }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return 'allowed-once'
  })

  const request = await client.next()
  assert.equal(request.type, 'approval-request')
  const resolved = await client.next()
  assert.equal(resolved.type, 'approval-resolved')
  assert.equal(resolved.outcome, 'allowed-once')
  assert.equal(resolved.source, 'other')
  assert.equal((await outcomes)[0], 'allowed-once')

  client.send({ type: 'approval/answer', requestId: request.requestId, outcome: 'rejected' })
  const late = await client.next()
  assert.equal(late.type, 'error')
  assert.equal(late.code, 'APPROVAL_NOT_PENDING')
})

test('losing the last watcher settles the approval unavailable (DS-002)', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const first = new NdjClient(harness.socketPath)
  const second = new NdjClient(harness.socketPath)
  t.after(() => first.destroy())
  for (const client of [first, second]) {
    client.send({ type: 'hello', protocol: 2 })
    await client.next()
    client.send({ type: 'attach', sessionId: 's1' })
    await client.next()
    await client.next()
  }

  const never = new Promise(() => {})
  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
  }, async () => 'unavailable')
  await first.next() // approval-request

  second.destroy()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(Array.isArray(await Promise.race([outcomes, new Promise((resolve) => setTimeout(() => resolve('pending'), 5))])), false, 'one watcher still online')

  first.destroy()
  assert.equal((await outcomes)[0], 'unavailable')
})

test('close() releases the socket path for the replacement Host (DS-009)', async (t) => {
  const harness = await startHarness(t)
  // Node's server.close() removes the file at the listen path, which is the
  // property the restart handover relies on: after this plugin closes, the
  // path is free for the re-exec'd Host to bind.
  for (const disposer of harness.disposers) await disposer?.()
  const { accessSync, constants } = await import('node:fs')
  assert.throws(() => accessSync(harness.socketPath, constants.F_OK), /ENOENT/)
  // And a fresh plugin can bind the same path immediately afterwards.
  const second = await startHarness(t)
  const probe = new NdjClient(second.socketPath)
  probe.send({ type: 'hello', protocol: 2 })
  const welcome = await probe.next()
  assert.equal(welcome.type, 'welcome')
  probe.destroy()
})

test('shutdown flushes the final approval resolution before closing (DS-009)', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  await client.next()
  await client.next()

  const never = new Promise(() => {})
  const outcomes = harness.emit('approval/request', {
    agent: { session: { id: 's1' } },
    toolName: 'bash',
  }, () => never)
  await client.next() // approval-request

  for (const disposer of harness.disposers) await disposer?.()
  // The resolution frame must arrive before the connection ends.
  const resolved = await client.next(2000)
  assert.equal(resolved.type, 'approval-resolved')
  assert.equal(resolved.outcome, 'unavailable')
  assert.equal((await outcomes)[0], 'unavailable')
  await client.closed
})
