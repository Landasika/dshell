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
  const archivedSessionIds = new Set()
  const pinnedSessionIds = new Set()
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
      observeSession: async sessionId => {
        const record = sessions.get(sessionId)
        if (record === undefined) throw Object.assign(new Error(`session ${sessionId} not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { header: record.header, projections: { values: {} }, [Symbol.dispose]() {} }
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archivedSessionIds] },
      get pinnedSessionIds() { return [...pinnedSessionIds] },
      archiveSession: async (sessionId) => { archivedSessionIds.add(sessionId) },
      unarchiveSession: async (sessionId) => { archivedSessionIds.delete(sessionId) },
      pinSession: async (sessionId) => { pinnedSessionIds.add(sessionId) },
      unpinSession: async (sessionId) => { pinnedSessionIds.delete(sessionId) },
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
  return { ctx, agents, sessions, workspaces, archivedSessionIds, pinnedSessionIds, listeners, disposers, emit, handles, recordOf, units, services }
}

/** An agent with a real, manipulable inbox — enough for queue commands. */
function makeAgent(sessionId) {
  const state = { cancelled: 0, cancelOptions: undefined }
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
    cancel(_cause, options) {
      state.cancelled += 1
      state.cancelOptions = options
      if (!options?.keepInbox) {
        inbox.nextTurn = []
        inbox.nextStep = []
      }
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
  // 三条测试隔离（都是踩过的坑）：
  //
  // 1. warmSessionList: false —— 预热会在 apply 返回后自己去查列表，抢在
  //    测试准备好会话数据之前把空结果写进缓存，害 10 个用例拿到空断言。
  // 2. sessionIndexFile 指向本测试的临时目录 —— 默认路径是真实的
  //    `$DSH_HOME/dshell-ws/session-index.jsonl`，不改的话测试会往用户的
  //    生产索引里写，而且用例之间互相污染（索引是追加式文件，前一个用例
  //    造出来的会话会出现在后一个用例的列表里）。
  // 3. deviceFile 同理，别碰真实设备库。
  await apply(harness.ctx, {
    warmSessionList: false,
    sessionIndexFile: join(directory, 'session-index.jsonl'),
    deviceFile: join(directory, 'devices.json'),
    socketPath,
    ...config,
  })
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

function makeProviderEditor(options = {}) {
  const row = {
    inherited: options.inherited ?? {},
    entry: {
      options: {
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            relay: {
              displayName: 'Old relay',
              baseURL: 'https://old.example/v1',
              apiKeyEnv: 'EXTERNAL_RELAY_API_KEY',
              models: [{ id: 'relay-model' }],
            },
          },
        },
      },
    },
    override: options.override ?? {},
  }
  const state = { editCalls: 0 }
  const editor = {
    documentPath: options.documentPath ?? '/virtual/dshell/cordis.patch.yml',
    configuration: () => [row],
    edit: async (_entry, change) => {
      state.editCalls += 1
      const current = options.currentForEdit?.(row.entry.options.config) ?? row.entry.options.config
      row.entry.options.config = change(current, row.inherited)
    },
  }
  return { editor, row, state }
}

function makeCredentialStore() {
  const values = new Map()
  const sets = []
  const unsets = []
  return {
    values,
    sets,
    unsets,
    service: {
      async set(ref, value) { sets.push({ ref, value }); values.set(ref, value) },
      async unset(ref) { unsets.push(ref); values.delete(ref) },
    },
  }
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

test('provider/save commits all fields once and reports config-editor source metadata', async (t) => {
  const fixture = makeProviderEditor({ inherited: { providers: { base: {} } }, override: { providers: { relay: {} } } })
  const harness = await startHarness(t, {}, { configEditor: fixture.editor })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({
    type: 'provider/save',
    providerId: 'relay',
    changes: { displayName: 'Relay Two', baseURL: 'https://new.example/v1', apiKeyEnv: 'RELAY_TWO_API_KEY' },
  })
  const saved = await client.next()
  assert.equal(saved.type, 'provider-saved')
  assert.equal(fixture.state.editCalls, 1)
  assert.deepEqual(saved.fields, ['displayName', 'baseURL', 'apiKeyEnv'])
  assert.deepEqual(saved.source, { kind: 'config-editor', layer: 'entry', inherited: true, overridden: true })
  assert.equal(saved.providers[0].displayName, 'Relay Two')
  assert.equal(saved.providers[0].baseURL, 'https://new.example/v1')
  assert.equal(saved.providers[0].apiKeyEnv, 'RELAY_TWO_API_KEY')

  client.send({ type: 'provider/list' })
  const listed = await client.next()
  assert.equal(listed.type, 'provider-list')
  assert.deepEqual(listed.source, saved.source)
})

test('provider/save rejects config-editor revision conflicts and rolls back a staged key', async (t) => {
  const fixture = makeProviderEditor({
    currentForEdit: (current) => ({ ...current, externallyChanged: true }),
  })
  const credentials = makeCredentialStore()
  const harness = await startHarness(t, {}, { configEditor: fixture.editor, credentials: credentials.service })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'provider/save', providerId: 'relay', changes: { displayName: 'Will conflict' }, apiKey: 'sk-conflict' })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'CONFIG_CONFLICT')
  assert.match(reply.message, /configuration changed/)
  assert.equal(credentials.sets.length, 1)
  assert.deepEqual(credentials.unsets, [credentials.sets[0].ref])
  assert.equal(credentials.values.size, 0)
  assert.equal(fixture.row.entry.options.config.providers.relay.displayName, 'Old relay')
})

test('provider/save retires only the previous dshell-owned key after commit', async (t) => {
  const fixture = makeProviderEditor()
  const credentials = makeCredentialStore()
  const harness = await startHarness(t, {}, { configEditor: fixture.editor, credentials: credentials.service })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'provider/save', providerId: 'relay', changes: {}, apiKey: 'sk-first' })
  const first = await client.next()
  assert.equal(first.type, 'provider-saved')
  assert.equal(credentials.unsets.includes('EXTERNAL_RELAY_API_KEY'), false)
  assert.equal(credentials.values.get(first.ref), 'sk-first')

  client.send({ type: 'provider/save', providerId: 'relay', changes: {}, apiKey: 'sk-second' })
  const second = await client.next()
  assert.equal(second.type, 'provider-saved')
  assert.notEqual(second.ref, first.ref)
  assert.deepEqual(credentials.unsets, [first.ref])
  assert.equal(credentials.values.has(first.ref), false)
  assert.equal(credentials.values.get(second.ref), 'sk-second')
  assert.equal(fixture.row.entry.options.config.providers.relay.apiKeyEnv, second.ref)
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
  const harness = await startHarness(t)
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  unit.inbox.nextTurn.push({ id: 'r1', role: 'user', content: [{ type: 'text', text: 'waiting' }], source: { kind: 'user' } })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  await harness.emit('session/event', { id: 's1' }, {
    type: 'user/message',
    seq: 1,
    data: { message: { id: 'r1', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'running' }] } },
  })

  client.send({ type: 'session/cancel', sessionId: 's1', requestId: 'r1' })
  const replies = await client.burst()
  assert.deepEqual(
    replies.map((message) => message.type),
    ['cancelled'],
    `session/cancel must produce only its ack, got ${JSON.stringify(replies)}`,
  )
  assert.equal(unit.state.cancelled, 1)
  assert.equal([...unit.inbox.nextTurn, ...unit.inbox.nextStep].length, 0, 'an explicit full stop still clears pending work')
})

test('cancel with continueQueued preserves the queue order, message identities and attachments and wakes it once', async t => {
  const harness = await startHarness(t)
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const queued = ['q1', 'q2', 'q3'].map(id => ({ id, role: 'user', source: { kind: 'user', rpcId: id }, content: [
    { type: 'text', text: id }, { type: 'image', mediaType: 'image/png', data: 'image-data' },
  ] }))
  const steering = { id: 'steer', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'pending steer' }] }
  unit.inbox.nextTurn.push(...queued)
  unit.inbox.nextStep.push(steering)
  unit.agent.followup = message => {
    unit.sentMessages.push({ mode: 'followup', message })
    unit.inbox.nextTurn.push(message)
  }
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next()
  assert.ok(welcome.capabilities.includes('cancel-continue'))
  client.send({ type: 'session/cancel', sessionId: 's1', continueQueued: true })
  assert.equal((await client.next()).type, 'cancelled')
  assert.equal(unit.state.cancelled, 1)
  assert.deepEqual(unit.state.cancelOptions, { keepInbox: true })
  assert.deepEqual(unit.inbox.nextTurn, queued, 'the same messages must retain FIFO order')
  assert.deepEqual(unit.inbox.nextStep, [steering])
  assert.equal(unit.sentMessages.length, 1, 'only one wake is needed for the driver to drain the queue')
  assert.equal(unit.sentMessages[0].message, queued[2], 'waking must reuse the same message object, including attachments')
})

test('cancel continues steering-only input without inserting an artificial user prompt', async t => {
  const harness = await startHarness(t)
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const steering = ['s1', 's2'].map(id => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] }))
  unit.inbox.nextStep.push(...steering)
  unit.agent.steer = message => { unit.sentMessages.push({ message }); unit.inbox.nextStep.push(message) }
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/cancel', sessionId: 's1', continueQueued: true })
  assert.equal((await client.next()).type, 'cancelled')
  assert.deepEqual(unit.inbox.nextStep, steering)
  assert.equal(unit.sentMessages[0].message, steering[1])
  assert.equal(unit.inbox.nextTurn.length, 0)
})

test('continuing cancellation delegates to the owner and reports owner failure without waking or clearing the queue', async t => {
  const ownerCalls = []
  const harness = await startHarness(t, {}, { sessionController: {
    modelCatalog: async () => ({}),
    cancel: async request => { ownerCalls.push(request); throw new Error('owner rejected cancellation') },
  } })
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const pending = { id: 'q1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'keep me' }] }
  unit.inbox.nextTurn.push(pending)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/cancel', sessionId: 's1', continueQueued: true, rpcId: 'stop-owner' })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.rpcId, 'stop-owner')
  assert.match(reply.message, /owner rejected/)
  assert.deepEqual(ownerCalls, [{ sessionId: 's1' }])
  assert.deepEqual(unit.inbox.nextTurn, [pending])
  assert.equal(unit.state.cancelled, 0)
  assert.equal(unit.sentMessages.length, 0)
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

test('session/list previews the latest human prompt and filters injected context', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [
    { type: 'user/message', seq: 1, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please review  the API\nthen fix the tests.' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'working' }] } } },
    { type: 'user/message', seq: 3, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 6, step 21: 2026-11-04' }] } } },
  ])
  makeSession(harness, 's2', [
    { type: 'user/message', seq: 1, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Current runtime context. internal only' }] } } },
  ])
  makeSession(harness, 's3', [
    { type: 'user/message', seq: 1, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(80) }] } } },
  ])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const reply = await client.next()
  assert.equal(reply.type, 'sessions')
  assert.equal(reply.sessions.find((session) => session.sessionId === 's1').preview, 'Please review the API then fix the tests.')
  assert.equal(Object.hasOwn(reply.sessions.find((session) => session.sessionId === 's2'), 'preview'), false)
  assert.equal(reply.sessions.find((session) => session.sessionId === 's3').preview, `${'x'.repeat(60)}…`)
})

test('session previews preserve emoji graphemes and skip malformed message payloads', async t => {
  const harness = await startHarness(t)
  const emoji = '👩🏽‍💻'
  makeSession(harness, 's1', [
    { type: 'user/message', seq: 1, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: emoji.repeat(61) }] } } },
    { type: 'user/message', seq: 2, data: { message: { source: { kind: 'user' }, content: [null, { type: 'text', text: { bad: true } }] } } },
    { type: 'user/message', seq: 3, data: null },
  ])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const reply = await client.next()
  assert.equal(reply.sessions.find(session => session.sessionId === 's1').preview, `${emoji.repeat(60)}…`)
})

test('a timed-out preview is retried on the next uncached list instead of cached empty for five minutes', async t => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [{ type: 'user/message', seq: 1, data: { message: {
    source: { kind: 'user' }, content: [{ type: 'text', text: 'recovered preview' }],
  } } }])
  const read = harness.ctx.sessionQuery.readSession
  let slow = true
  harness.ctx.sessionQuery.readSession = id => slow ? new Promise(() => {}) : read(id)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const first = await client.next()
  assert.equal(Object.hasOwn(first.sessions[0], 'preview'), false)
  slow = false
  client.send({ type: 'session/list', includeArchived: true })
  const reply = await client.next()
  assert.equal(reply.sessions.find(session => session.sessionId === 's1').preview, 'recovered preview')
})

test('session preview reads are capped to the first 24 rows', async t => {
  const harness = await startHarness(t)
  for (let i = 0; i < 40; i += 1) makeSession(harness, `s${i}`)
  const read = harness.ctx.sessionQuery.readSession
  const reads = []
  harness.ctx.sessionQuery.readSession = id => { reads.push(id); return read(id) }
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  assert.equal((await client.next()).sessions.length, 40)
  assert.equal(reads.length, 24)
  assert.equal(reads.includes('s24'), false)
})

test('legacy attach restores a model selection before its bounded tail page', async t => {
  const harness = await startHarness(t)
  const selected = { provider: 'p', model: 'saved', reasoningEffort: 'high' }
  makeSession(harness, 's1', Array.from({ length: 700 }, (_, seq) => ({ seq,
    type: seq === 0 ? 'model/selection' : 'custom/event', data: seq === 0 ? selected : {},
  })))
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  const attached = await client.next()
  assert.equal(attached.events.length, 500)
  assert.deepEqual(attached.modelSelection, selected)
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

test('attach uses owner paging and caps its opening history window', async (t) => {
  const events = Array.from({ length: 400 }, (_, seq) => ({ type: 'custom/event', seq, data: { seq } }))
  const controller = {
    modelCatalog: async () => ({}),
    follow: async function* ({ maxMessages }) {
      const records = events.slice(-maxMessages).map(event => ({ type: 'event', event }))
      yield { type: 'snapshot', header: { id: 's1', cwd: '/work' }, cursor: 399, records, hasMore: true,
        projections: { asOfSeq: 399, values: { modelSelection: {
          lastUsed: { provider: 'p', model: 'old' }, next: { provider: 'p', model: 'next', reasoningEffort: 'high' },
        } } } }
    },
    page: async ({ beforeSeq, maxMessages }) => {
      const eligible = events.filter(event => event.seq < beforeSeq)
      const records = eligible.slice(-maxMessages).map(event => ({ type: 'event', event }))
      return { records, hasMore: eligible.length > records.length }
    },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', events)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  const attached = await client.next()
  assert.equal(attached.events.length, 80)
  assert.equal(attached.events[0].seq, 320)
  assert.equal(attached.hasMore, true)
  assert.deepEqual(attached.modelSelection, { provider: 'p', model: 'next', reasoningEffort: 'high' })
  assert.deepEqual(attached.modelSelectionLastUsed, { provider: 'p', model: 'old' })
  assert.equal((await client.next()).type, 'status')
  client.send({ type: 'session/history', sessionId: 's1', before: 320, limit: 50 })
  const history = await client.next()
  assert.equal(history.events.length, 50)
  assert.equal(history.events[0].seq, 270)
  assert.equal(history.events.at(-1).seq, 319)
})

test('owner message budgets cannot send unbounded non-message events through attach or paging', async t => {
  const events = Array.from({ length: 1200 }, (_, seq) => ({ type: 'model/selection', seq, data: { provider: 'p', model: `m${seq}` } }))
  const controller = {
    modelCatalog: async () => ({}),
    follow: async function* () {
      yield { type: 'snapshot', header: { id: 's1', cwd: '/work' }, cursor: 1199,
        records: events.map(event => ({ type: 'event', event })), hasMore: false,
        projections: { asOfSeq: 1199, values: { modelSelection: { lastUsed: null, next: events.at(-1).data } } } }
    },
    page: async ({ beforeSeq, throughSeq }) => {
      assert.equal(throughSeq, 1199)
      return { records: events.filter(event => event.seq < beforeSeq).map(event => ({ type: 'event', event })), hasMore: false }
    },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', events)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 's1' })
  const attached = await client.next()
  assert.equal(attached.events.length, 500)
  assert.equal(attached.events[0].seq, 700)
  assert.equal(attached.hasMore, true)
  assert.deepEqual(attached.modelSelection, { provider: 'p', model: 'm1199' })
  await client.next()
  const recovered = [...attached.events]
  let before = attached.events[0].seq
  for (;;) {
    client.send({ type: 'session/history', sessionId: 's1', before, limit: 137 })
    const page = await client.next()
    assert.ok(page.events.length <= 137)
    assert.equal(page.events.at(-1).seq, before - 1)
    recovered.unshift(...page.events)
    before = page.events[0].seq
    if (!page.hasMore) break
  }
  assert.deepEqual(recovered.map(event => event.seq), events.map(event => event.seq), 'paging must recover every event exactly once')
})

test('a pending question survives its last watcher disconnect and is restored on attach', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1')
  makeSession(harness, 's2')
  const unit = makeAgent('s1')
  harness.agents.set('s1', unit.agent)
  const first = new NdjClient(harness.socketPath)
  t.after(() => first.destroy())
  first.send({ type: 'hello', protocol: 2 })
  await first.next()
  first.send({ type: 'attach', sessionId: 's1' })
  await first.next()
  await first.next()
  const waiting = harness.emit('user-questions/request', {
    agent: unit.agent,
    questions: [{ id: 'approve', question: 'Apply this plan?', detail: 'Full plan text', intent: { kind: 'plan-review' }, options: [{ label: 'Apply' }] }],
    wait: { callId: 'plan-1', timed: false },
  }, async () => new Promise(() => {}))
  const request = await first.next()
  assert.equal(request.type, 'question/request')
  first.destroy()
  await first.closed

  const second = new NdjClient(harness.socketPath)
  t.after(() => second.destroy())
  second.send({ type: 'hello', protocol: 2 })
  await second.next()
  second.send({ type: 'attach', sessionId: 's1' })
  const attached = await second.next()
  assert.equal(attached.questions[0].callId, 'plan-1')
  assert.equal(attached.questions[0].questions[0].detail, 'Full plan text')
  await second.next()
  second.send({ type: 'attach', sessionId: 's2' })
  await second.next()
  await second.next()
  second.send({ type: 'question/answer', sessionId: 's2', callId: 'plan-1', answers: [{ id: 'approve', selected: ['Apply'] }] })
  assert.equal((await second.next()).type, 'error')
  second.send({ type: 'question/answer', sessionId: 's1', callId: 'plan-1', answers: [{ id: 'approve', selected: ['Apply'] }] })
  assert.equal((await second.next()).type, 'question/closed')
  assert.equal((await second.next()).type, 'question-answered')
  assert.deepEqual(await waiting, [{ answers: [{ id: 'approve', selected: ['Apply'] }] }])
})

test('session organization uses workspace owner APIs and never moves session directories', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1')
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next()
  assert.equal(welcome.capabilities.includes('session-archive'), true)
  client.send({ type: 'session/archive', sessionId: 's1' })
  assert.equal((await client.next()).type, 'session-updated')
  client.send({ type: 'session/list' })
  assert.deepEqual((await client.next()).sessions, [])
  client.send({ type: 'session/list', includeArchived: true })
  assert.equal((await client.next()).sessions[0].archived, true)
  client.send({ type: 'session/restore', sessionId: 's1' })
  assert.equal((await client.next()).type, 'session-updated')
  client.send({ type: 'session/pin', sessionId: 's1', pinned: true })
  assert.equal((await client.next()).type, 'session-updated')
  client.send({ type: 'session/list' })
  assert.equal((await client.next()).sessions[0].pinned, true)
  client.send({ type: 'session/delete', sessionId: 's1' })
  const rejected = await client.next()
  assert.equal(rejected.type, 'error')
  assert.match(rejected.message, /archive/i)
  assert.equal(harness.sessions.has('s1'), true)
})

test('session/compact delegates to the kernel commands service and reports its receipt', async (t) => {
  // 为什么走 commands 而不是自己找 compaction：`BasicCompactionEngine` 由
  // preset fiber 提供，host ctx 上拿不到（实测 strict 与非 strict 都是
  // undefined）。`/compact` 的实现在 dsh-command-compact 里，它自己持有
  // compaction 依赖。所以 Host 只负责把命令行交给 commands 服务。
  // commands 是 ctx.get('commands') 取的服务，所以必须通过 services 注入，
  // 直接赋值 harness.ctx.commands 是拿不到的。
  const calls = []
  const commands = {
    execute: async (agent, line, attachments, signal) => {
      calls.push({ agentId: agent.id, line, attachmentCount: attachments.length, hasSignal: signal instanceof AbortSignal })
      return { text: 'Compacted 12 messages, freed ~18k tokens.' }
    },
  }
  const harness = await startHarness(t, {}, { commands })
  // 用 session/create 建一个真正 live 的 agent：`ctx.agents.get` 只认活跃
  // 句柄，直接 makeSession 只写 sessionQuery，压缩入口会先撞 SESSION_NOT_FOUND。
  const boot = new NdjClient(harness.socketPath)
  t.after(() => boot.destroy())
  boot.send({ type: 'hello', protocol: 2 })
  await boot.next()
  boot.send({ type: 'session/create', cwd: '/work' })
  const made = await boot.next()
  assert.equal(made.type, 'session-created')
  const liveId = made.sessionId
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/compact', sessionId: liveId })
  const reply = await client.next()
  assert.equal(reply.type, 'session-compacted')
  assert.equal(reply.sessionId, liveId)
  assert.equal(reply.text, 'Compacted 12 messages, freed ~18k tokens.')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].line, '/compact')
  assert.equal(calls[0].attachmentCount, 0)
  assert.equal(calls[0].hasSignal, true)
})

test('session/compact fails closed when the commands service is absent', async (t) => {
  // 精简 profile 可能没有命令服务。此时必须回一条可读的错误，而不是抛栈
  // 或假装成功——压缩没做就是没做。
  const harness = await startHarness(t)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/create', cwd: '/work' })
  const made = await client.next()
  client.send({ type: 'session/compact', sessionId: made.sessionId })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'CAPABILITY_MISSING')
  assert.match(reply.message, /命令服务/)
})

test('session/compact reports a missing session instead of silently doing nothing', async (t) => {
  const harness = await startHarness(t)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/compact', sessionId: 'session-does-not-exist' })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'SESSION_NOT_FOUND')
})

test('a session created through the controller path still lands in the workspace list', async (t) => {
  // 回归：`controller.create({ cwd })` 只建会话、不注册 workspace，导致该目录
  // 永远不进 workspace.json；此后按 workspace 过滤的列表会把会话静默丢掉，
  // 用户看到的就是"会话又没了"，而磁盘上的日志完好。
  //
  // 修复后 dshell 先 `registry.create(cwd)` 拿到 workspaceId，再交给
  // controller——所以这里断言 controller 收到的是 workspaceId。
  const cwd = '/tmp/controller-cwd-regress'
  const received = []
  const controller = {
    async create(request) {
      received.push(request)
      const sessionId = 'session-controller-made'
      makeSession(harness, sessionId, [], { cwd })
      return { sessionId }
    },
    async read() { return undefined },
    async history() { return { events: [], hasMore: false } },
    async cancel() {},
    async archive() {},
    async unarchive() {},
    async rename() {},
    async fork() { return { sessionId: 'x' } },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/create', cwd })
  const created = await client.next()
  assert.equal(created.type, 'session-created')
  // 关键断言：controller 收到的是 workspaceId，而不是裸 cwd。传 cwd 会让内核
  // 跳过 attachSession，那正是这个 bug 的成因。
  assert.equal(received.length, 1)
  assert.equal(typeof received[0].workspaceId, 'string')
  assert.equal(received[0].cwd, undefined)
  // 而且这个 workspace 必须真的登记在册，否则后续过滤依旧看不见会话。
  client.send({ type: 'workspaces' })
  const workspaces = await client.next()
  const match = (workspaces.workspaces ?? []).find((workspace) => workspace.path === cwd)
  assert.ok(match, `cwd must be registered as a workspace (got ${JSON.stringify((workspaces.workspaces ?? []).map((w) => w.path))})`)
})

test('a session whose cwd has no registered workspace is still visible under that workspace filter', async (t) => {
  // 已经存在的孤儿会话（历史 bug 留下的）不能因为 workspace 缺失就被过滤掉：
  // 过滤应当按 cwd 归属，而不是只认注册表。
  const harness = await startHarness(t)
  makeSession(harness, 'orphan', [], { cwd: '/tmp/never-registered-dir' })
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const all = await client.next()
  assert.equal(all.sessions.some((session) => session.sessionId === 'orphan'), true)
})

test('startup adopts workspaces for parent sessions but never for subagents or deleted dirs', async (t) => {
  // 两条硬约束：
  //  1. subagent 的 cwd 与父会话相同，且本就不该出现在会话列表（isSubagentRow），
  //     补登记也只围绕父会话做——否则统计口径会被子会话污染。
  //  2. 磁盘上已删除的目录不补登记，避免留下永远打不开的空壳 workspace。
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'dsh-adopt-'))
  const alive = pathMod.join(root, 'alive-project')
  await fs.mkdir(alive, { recursive: true })
  const gone = pathMod.join(root, 'deleted-project')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  // 打开预热，让启动流程真的去跑补登记。索引文件路径由 startHarness 指定在
  // 临时目录里，所以这里必须用同一个路径预写内容。
  const indexDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'dsh-adopt-idx-'))
  t.after(() => fs.rm(indexDir, { recursive: true, force: true }))
  const indexFile = pathMod.join(indexDir, 'session-index.jsonl')
  await fs.writeFile(indexFile, [
    { sessionId: 'parent-alive', cwd: alive, createdAt: 1 },
    { sessionId: 'child-of-alive', cwd: alive, createdAt: 2, origin: 'subagent', parentSessionId: 'parent-alive' },
    { sessionId: 'parent-gone', cwd: gone, createdAt: 3 },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  // startHarness 允许覆盖索引路径（它自己也用它做测试隔离）。
  const harness = await startHarness(t, { warmSessionList: true, sessionIndexFile: indexFile })
  // 预热在 apply 之后跑，轮询等待它把 workspace 补进来。
  const pathsOf = () => [...harness.workspaces.values()].map((workspace) => workspace.path)
  for (let i = 0; i < 100 && !pathsOf().includes(alive); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const paths = pathsOf()
  if (!paths.includes(alive)) {
    const diag = await fs.readFile(indexFile, 'utf8').catch((e) => `unreadable: ${e}`)
    assert.fail(`existing dir must be adopted, got ${JSON.stringify(paths)}; index=${String(diag).slice(0, 300)}`)
  }
  assert.equal(paths.includes(gone), false, 'deleted dir must not become a workspace')
  // 子会话与父同 cwd，不应额外产生重复条目。
  assert.equal(paths.filter((entry) => entry === alive).length, 1)
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

test('prompt content is validated and delegated to the Harness session owner in order', async (t) => {
  const calls = []
  const controller = {
    prompt: async (request) => { calls.push(request); return { accepted: true } },
    modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] }),
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1')
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next()
  assert.equal(welcome.capabilities.includes('prompt-content'), true)
  client.send({
    type: 'prompt', sessionId: 's1', requestId: 'media-1', mode: 'queue',
    content: [
      { type: 'text', text: 'inspect' },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
      { type: 'file', receiptId: 'receipt-1' },
    ],
  })
  assert.equal((await client.next()).type, 'accepted')
  assert.deepEqual(calls[0].content, [
    { type: 'text', text: 'inspect' },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
    { type: 'file', receiptId: 'receipt-1' },
  ])
  client.send({ type: 'prompt', sessionId: 's1', content: [{ type: 'image', mediaType: 'image/svg+xml', data: 'x' }] })
  const bad = await client.next()
  assert.equal(bad.type, 'error')
  assert.equal(bad.code, 'BAD_REQUEST')
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
  const calls = []
  const harness = await startHarness(t, {}, { userQuestions: { answer(agent, callId, answer) { calls.push({ agent: agent.id, callId, answer }); return true } } })
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
  assert.equal(unit.sentMessages.length, 0)
  assert.deepEqual(calls, [{ agent: 's1', callId: 'q1', answer: { answers: [{ id: 'pkg', selected: ['A'], custom: 'note' }] } }])
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
    data: { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ id: 'pkg', question: 'which?', options: [{ label: 'pnpm' }, { label: 'npm' }] }] }) },
  })
  await client.burst()

  const controller = new AbortController()
  const outcome = harness.emit('user-questions/request', {
    questions: [{ id: 'pkg', question: 'which?', options: [{ label: 'pnpm' }, { label: 'npm' }] }],
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
    data: { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ id: 'pkg', question: 'which?', options: [{ label: 'pnpm' }, { label: 'npm' }] }] }) },
  })
  await client.burst()

  const outcome = harness.emit('user-questions/request', {
    questions: [{ id: 'pkg', question: 'which?', options: [{ label: 'pnpm' }, { label: 'npm' }] }],
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

test('prompt maps a writer-held resume to SESSION_ALREADY_LIVE', async (t) => {
  const held = Object.assign(new Error('session "s9" is already owned by an active write handle'), {
    code: 'session/writer-held',
  })
  const harness = await startHarness(t, {}, {
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => {
        throw held
      },
      create: async () => {
        throw new Error('unused')
      },
    },
  })
  makeSession(harness, 's9', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'prompt', sessionId: 's9', text: 'wake up' })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'SESSION_ALREADY_LIVE')
})

test('prompt still maps a raw SessionAlreadyOwnedError message to SESSION_ALREADY_LIVE', async (t) => {
  const harness = await startHarness(t, {}, {
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async () => {
        // The persistence seam's own error, without the controller's code.
        throw new Error('session "s9" is already owned by an active write handle')
      },
      create: async () => {
        throw new Error('unused')
      },
    },
  })
  makeSession(harness, 's9', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'prompt', sessionId: 's9', text: 'wake up' })
  const reply = await client.next()
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'SESSION_ALREADY_LIVE')
})

/**
 * 运行态投影失败时，`status` 必须是**未知**而不是 `idle`。
 *
 * 背景：`status` 靠 `controller.list()` 给的 running 集合算出来，那个调用
 * 有 4 秒超时。超时后原先的写法会把所有会话写成 `status:'idle'`——
 * 不是"中性默认值"，而是**错误结论**：正在跑的任务被报成空闲，客户端首页
 * 于是显示"没有进行中的任务"。
 *
 * 用户的实际症状是"来回切换一下账号，进行中的任务就没了"：切换主机触发
 * 重连，正好撞上投影还没就绪的那几秒。而错误结果还会进缓存（4 秒），
 * 把一次瞬时故障延长成确定的 4 秒空白。
 */
test('投影超时时 status 缺省为未知，不谎报 idle', async t => {
  const controller = {
    list: async () => { throw new Error('projection timeout') },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const reply = await client.next()
  const row = reply.sessions.find((s) => s.sessionId === 's1')
  assert.ok(row, '会话本身必须照常返回')
  assert.equal(row.status, undefined, 'status 缺失表示"不知道"，不能是 idle')
  assert.equal(row.live, true, 'live 仍然反映常驻状态')
})

test('投影正常时 status 照常给出 running', async t => {
  // 对照组：别为了修故障路径把正常路径也弄成 undefined
  const controller = {
    list: async () => ({ items: [{ sessionId: 's1', updatedAt: Date.now(), running: true }] }),
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  const reply = await client.next()
  assert.equal(reply.sessions.find((s) => s.sessionId === 's1').status, 'running')
})

test('投影失败的结果不进缓存，下一次请求能立刻拿到正确状态', async t => {
  let fail = true
  const controller = {
    list: async () => {
      if (fail) throw new Error('projection timeout')
      return { items: [{ sessionId: 's1', updatedAt: Date.now(), running: true }] }
    },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'session/list' })
  const first = await client.next()
  assert.equal(first.sessions.find((s) => s.sessionId === 's1').status, undefined)

  // 故障恢复后立刻再问一次：若第一次的错误结果被缓存（4 秒），这里仍是 undefined
  fail = false
  client.send({ type: 'session/list' })
  const second = await client.next()
  assert.equal(
    second.sessions.find((s) => s.sessionId === 's1').status,
    'running',
    '投影失败的结果不能被缓存，否则切换主机后的 4 秒里一直是空的',
  )
})

/**
 * controller.list 绝不能收到 AbortSignal：abort 会在 host 查询链深处产生
 * 无人接住的拒绝，而 host 把任何 unhandledRejection 当致命错误 exit(1)。
 */
test('controller.list 不收到 AbortSignal（abort 信号会把 host 打死）', async t => {
  const calls = []
  const controller = {
    list: async (...args) => {
      calls.push(args)
      return { items: [{ sessionId: 's1', updatedAt: Date.now(), running: false }] }
    },
  }
  const harness = await startHarness(t, {}, { sessionController: controller })
  makeSession(harness, 's1', [])
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/list' })
  await client.next()
  assert.ok(calls.length >= 1, '投影查询应该被发起')
  for (const args of calls) {
    assert.equal(
      args.length, 1,
      `controller.list 只应收到 request 一个参数（不能传 AbortSignal），实际收到 ${String(args.length)} 个`,
    )
  }
})

/** 索引命中后的后台补全要限流：否则多端轮询把全量枚举变成常驻负载。 */
test('索引命中后短时间内不重复开后台枚举', async t => {
  const harness = await startHarness(t, {})
  makeSession(harness, 's1', [])
  const real = harness.ctx.sessionQuery.listSessions
  let calls = 0
  harness.ctx.sessionQuery.listSessions = () => { calls += 1; return real() }

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  // 第一次：冷缓存、空索引，必须真的枚举一次（走慢路径并填充索引）
  client.send({ type: 'list' })
  const first = await client.next(5_000)
  assert.equal(first.type, 'sessions')
  assert.equal(calls, 1)

  // 等 4 秒列表缓存过期（否则第二次直接命中缓存，测不到后台补全）
  await new Promise((resolve) => setTimeout(resolve, 4_300))

  // 第二次：索引已有内容，应命中索引立即返回；且 30 秒限流窗口内
  // 不再开后台全量枚举
  client.send({ type: 'list' })
  const second = await client.next(2_000)
  assert.equal(second.type, 'sessions')
  assert.deepEqual(second.sessions.map((s) => s.sessionId), ['s1'])
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls, 1, '限流窗口内的列表请求不应再次触发全量枚举')
})

/**
 * 会话列表查询超时必须发 error 帧，**不能发空 sessions**。
 *
 * 背景：`sessionQuery.listSessions()` 撞上 15 秒预算时，原先直接
 * `return []`，把"查不出来"伪装成"这台机器上没有会话"。客户端收到空列表
 * 就把首页清空了——而用户那 6 个 live 会话其实一直在跑。
 *
 * 空列表和"没查到"必须让客户端能分清：前者该清空界面，后者该保留现有数据
 * 并提示刷新失败。
 */
test('会话列表超时发 error 帧而不是空 sessions', async t => {
  // 预算压到 100ms：这条测的是"超时走哪条分支"，不是真的等 15 秒
  const harness = await startHarness(t, { sessionListTimeoutMs: 100 })
  makeSession(harness, 's1', [])
  // 让底层查询永远不返回，触发 15s 超时预算（用 fake timer 不好使，
  // 这里直接卡住并靠测试超时兜底——见下面的短预算测试）
  harness.ctx.sessionQuery.listSessions = () => new Promise(() => {})
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'list' })
  const reply = await client.next(5_000)
  assert.equal(reply.type, 'error', '超时必须报错，不能假装成功')
  assert.equal(reply.code, 'SESSION_LIST_TIMEOUT')
})

/**
 * 缓存过期后要**先返回旧数据**，同时后台刷新。
 *
 * 枚举一个大的 DSH home 要 14~15 秒（实测 249 个会话 / 266MB），正好卡在
 * 15 秒预算边缘，于是同一份数据时好时坏：这一次 249 条，下一次超时变空。
 * 用户看到的就是"任务一会儿有一会儿没有"。
 *
 * 所以过期后不能阻塞在慢查询上：先给已知数据，让新鲜度由后台那一次去追。
 */
test('session/children 返回某个会话的子 agent', async t => {
  const harness = await startHarness(t)
  makeSession(harness, 'parent')
  makeSession(harness, 'kid-a', [], { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 })
  makeSession(harness, 'kid-b', [], { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 })
  makeSession(harness, 'other', [], { origin: 'subagent', parentSession: 'parent-x' })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  // 先让索引被填充（列表会走一次慢路径）
  client.send({ type: 'list' })
  await client.next(5_000)

  client.send({ type: 'session/children', sessionId: 'parent' })
  const reply = await client.next(5_000)
  assert.equal(reply.type, 'session-children')
  assert.equal(reply.sessionId, 'parent')
  // 只返回这个父会话的，别的父会话的子 agent 不能混进来
  assert.deepEqual(reply.children.map((c) => c.sessionId).sort(), ['kid-a', 'kid-b'])
})

/**
 * 标题补齐走的是**直接读日志**这条路，不是 `readSession`。
 *
 * 实测过为什么：`readTitleSnapshots` / `readSession` 都要重放整个事件流做
 * 投影，单条 > 8s / > 1.5s，日志里刷满 timed out；而直接读 `.zstd` + 多帧
 * 解压只要 21ms，差 400 倍。所以测试里造一个假的日志文件，验证真路径。
 */
test('子会话没有 header 标题时，从日志的 session/title 事件补上', async t => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  // 造一个真实布局：$DSH_HOME/sessions/<slug>/<id>/session.v4.jsonl.zstd
  // 用临时 DSH_HOME，绝不碰用户的真实会话目录
  const home = await mkdtemp(join(tmpdir(), 'dshell-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const slug = '--work--'
  const dir = join(home, 'sessions', slug, 'kid')
  mkdirSync(dir, { recursive: true })
  const jsonl = [
    JSON.stringify({ type: 'session', version: 4, id: 'kid', cwd: '/work', createdAt: 1_000 }),
    '{"type":"session/title","seq":1,"data":{"title":"帮我查一下 Cisco 固件"}}',
  ].join('\n')
  const { zstdCompressSync } = await import('node:zlib')
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(jsonl)))

  const harness = await startHarness(t)
  makeSession(harness, 'parent')
  makeSession(harness, 'kid', [], { origin: 'subagent', parentSession: 'parent', cwd: '/work', delegationDepth: 1 })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'list' })
  await client.next(5_000)

  client.send({ type: 'session/children', sessionId: 'parent' })
  const reply = await client.next(5_000)
  assert.equal(reply.children.length, 1)
  assert.equal(reply.children[0].title, '帮我查一下 Cisco 固件')
})

test('子会话既没标题也没用户消息时，不编造标题', async t => {
  const harness = await startHarness(t)
  makeSession(harness, 'parent')
  makeSession(harness, 'kid', [], { origin: 'subagent', parentSession: 'parent' })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'list' })
  await client.next(5_000)

  client.send({ type: 'session/children', sessionId: 'parent' })
  const reply = await client.next(5_000)
  // 没标题就是没有这个字段——客户端会退化成显示 ID 前 8 位，
  // 而不是显示一个编出来的假标题
  assert.equal(reply.children[0].title, undefined)
})

test('session/children 缺 sessionId 时报 BAD_REQUEST 而不是崩', async t => {
  const harness = await startHarness(t)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'session/children' })
  const reply = await client.next(5_000)
  assert.equal(reply.type, 'error')
  assert.equal(reply.code, 'BAD_REQUEST')
})

test('缓存过期后先返回旧列表而不是阻塞在慢查询上', async t => {
  const harness = await startHarness(t, { sessionListTimeoutMs: 5_000 })
  makeSession(harness, 's1', [])
  const real = harness.ctx.sessionQuery.listSessions
  let calls = 0
  harness.ctx.sessionQuery.listSessions = () => { calls += 1; return real() }

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  // 第一次：冷缓存，必须真的查一次
  client.send({ type: 'list' })
  const first = await client.next(5_000)
  assert.equal(first.type, 'sessions')
  assert.equal(calls, 1)

  // 让 4 秒缓存过期
  await new Promise((resolve) => setTimeout(resolve, 4_200))

  // 第二次：缓存已过期，但应立刻返回旧数据，不被慢查询阻塞
  const startedAt = Date.now()
  client.send({ type: 'list' })
  const second = await client.next(2_000)
  const elapsed = Date.now() - startedAt
  assert.equal(second.type, 'sessions', '过期后仍要给出数据，不能因为刷新中而报错')
  assert.deepEqual(second.sessions.map((s) => s.sessionId), ['s1'])
  assert.ok(elapsed < 2_000, `应立刻返回旧数据（实际 ${String(elapsed)}ms）`)
})

/*
 * `list` 的运行状态必须来自 Host 内存里的 `ctx.agents`。
 *
 * ## 为什么这几条测试存在
 *
 * 实测（一个跑了 24.7 秒的真实任务，58 次采样）：
 *
 *     attach 报 running:  57 次   ✅
 *     list   报 running:   0 次   ❌
 *
 * 同一时刻直接问 `ctx.agents`，它明确说 `running`。也就是说 Host **知道**
 * 谁在跑，只是没把这件事告诉 `list` 的调用方。手机上看到的现象就是
 * "电脑终端在跑，列表里全是空闲"。
 *
 * 根因有两处，两处都得修：
 *
 *  1. `listSessionsFromIndex` —— **索引路径才是主路径**（命中索引就直接
 *     返回，走不到慢路径）。它原来干脆没写 status。
 *  2. `listSessionsFresh` —— 慢路径只会看 `runningIds`，而那个数据源
 *     （`controller.list()` 的 `items[].running`）实测永远是空的。
 */
test('list 从 ctx.agents 拿到 running —— 主路径（索引命中）', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [
    { type: 'turn/start', seq: 1, data: {} },
  ])
  // Host 内存里这个 agent 正在跑
  harness.agents.set('s1', { id: 's1', status: 'running', session: { id: 's1' } })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'list' })
  const reply = await client.next()
  assert.equal(reply.type, 'sessions')
  const row = reply.sessions.find((s) => s.sessionId === 's1')
  assert.equal(row?.status, 'running')
  assert.equal(row?.running, true)
})

test('list 对已结束的 agent 报 idle，而不是漏掉状态', async (t) => {
  const harness = await startHarness(t)
  makeSession(harness, 's1', [
    { type: 'turn/start', seq: 1, data: {} },
    { type: 'turn/end', seq: 2, data: {} },
  ])
  harness.agents.set('s1', { id: 's1', status: 'idle', session: { id: 's1' } })

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'list' })
  const reply = await client.next()
  const row = reply.sessions.find((s) => s.sessionId === 's1')
  assert.equal(row?.status, 'idle')
  assert.notEqual(row?.running, true)
})

test('不在 ctx.agents 里的会话不能报成 running', async (t) => {
  // 反向保护：闲着的会话根本不在内存表里，这时必须走回原来的推断
  // （live / idle），不能被误判成"在跑"。
  const harness = await startHarness(t)
  makeSession(harness, 's1', [{ type: 'turn/end', seq: 1, data: {} }])

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'list' })
  const reply = await client.next()
  const row = reply.sessions.find((s) => s.sessionId === 's1')
  assert.notEqual(row?.status, 'running')
  assert.notEqual(row?.running, true)
})

test('新建会话立刻出现在 list 里（不用等索引全量刷新）', async (t) => {
  // ⚠️ 这条测试**抓不到**它要抓的 bug。
  //
  // 要抓的问题是"索引路径看不见新会话"，但 `indexPrimed` 只有在索引
  // 刷新跑完之后才为 true，而测试都是新建 harness（indexPrimed = false），
  // 所以永远走慢路径。我把它留着是当行为契约（新建 → 立刻可见），
  // 但它不能替代对索引路径的保护 —— 那部分靠上面两条 status 测试，
  // 它们是真的会红的（回滚验证过：2 条失败）。
  const harness = await startHarness(t)

  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()

  client.send({ type: 'session/create', cwd: '/work' })
  const created = await client.next()
  assert.equal(created.type, 'session-created')
  const sid = created.sessionId
  assert.ok(typeof sid === 'string' && sid.length > 0)

  client.send({ type: 'list' })
  const reply = await client.next()
  assert.equal(reply.type, 'sessions')
  const ids = reply.sessions.map((s) => s.sessionId)
  assert.ok(ids.includes(sid), `新建的会话应当立刻出现在列表里，实际只有：${ids.join(',')}`)
})

test('audit: cancel and repeated turn completion events promote exactly one deferred prompt per turn', async t => {
  const calls = []
  const harness = await startHarness(t, {}, { sessionController: { prompt: async request => { calls.push(request) } } })
  makeSession(harness, 's1')
  const unit = makeAgent('s1')
  unit.agent.status = 'running'
  harness.agents.set('s1', unit.agent)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  for (const requestId of ['q1', 'q2', 'q3']) {
    client.send({ type: 'prompt', sessionId: 's1', requestId, text: requestId, mode: 'queue' })
    assert.equal((await client.next()).deferred, true)
  }
  client.send({ type: 'queue/edit', sessionId: 's1', requestId: 'q1', text: 'edited first' })
  assert.equal((await client.next()).action, 'edit')
  client.send({ type: 'queue/remove', sessionId: 's1', requestId: 'q3' })
  assert.equal((await client.next()).action, 'remove')
  client.send({ type: 'session/cancel', sessionId: 's1', continueQueued: true })
  assert.equal((await client.next()).type, 'cancelled')
  await harness.emit('session/event', { id: 's1' }, { type: 'turn/failed', seq: 1, data: {} })
  await harness.emit('session/event', { id: 's1' }, { type: 'turn/end', seq: 2, data: {} })
  unit.agent.status = 'idle'
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(calls.length, 1, 'overlapping retry timers must share one admission reservation')
  assert.equal(calls[0].requestId, 'q1')
  assert.equal(calls[0].content[0].text, 'edited first')
  await harness.emit('session/event', { id: 's1' }, { type: 'turn/failed', seq: 2, data: {} })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls.length, 1, 'late completion of the previous turn must not release the next prompt')
  unit.agent.status = 'running'
  await harness.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 3, data: {} })
  unit.agent.status = 'idle'
  await harness.emit('session/event', { id: 's1' }, { type: 'turn/end', seq: 4, data: {} })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls.map(call => call.requestId), ['q1', 'q2'])
})

test('audit: print idle and media capability checks precede deferred admission', async t => {
  const harness = await startHarness(t)
  makeSession(harness, 's1')
  const unit = makeAgent('s1')
  unit.agent.status = 'running'
  harness.agents.set('s1', unit.agent)
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'prompt', sessionId: 's1', text: 'print', mode: 'queue', requireIdle: true })
  assert.equal((await client.next()).code, 'SESSION_ACTIVE')
  client.send({ type: 'prompt', sessionId: 's1', mode: 'queue', content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] })
  assert.equal((await client.next()).code, 'UNSUPPORTED_CAPABILITY')
})

test('audit: compact resumes an attached cold session through the same agent path as prompts', async t => {
  const calls = []
  const harness = await startHarness(t, {}, { commands: { execute: async agent => { calls.push(agent.session.id); return { text: 'compacted' } } } })
  makeSession(harness, 'cold')
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'attach', sessionId: 'cold' })
  await client.next()
  client.send({ type: 'session/compact', sessionId: 'cold' })
  let reply
  do { reply = await client.next() } while (reply.type === 'status')
  assert.equal(reply.type, 'session-compacted')
  assert.deepEqual(calls, ['cold'])
})

test('audit: failed Unix bind releases the WebSocket listener and all plugin subscriptions', async t => {
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const directory = await mkdtemp(join(tmpdir(), 'dshell-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = createFakeCtx()
  // The WS bind is initiated before listen(server, path). Force the latter
  // to fail synchronously after prepareSocketPath has already succeeded.
  const socketPath = join(directory, 'sock')
  const { mkdirSync } = await import('node:fs')
  const originalOn = harness.ctx.on
  harness.ctx.on = (...args) => {
    const off = originalOn(...args)
    if (args[0] === 'approval/request') {
      // A directory at the bind path makes listen fail after startup setup.
      mkdirSync(socketPath)
    }
    return off
  }
  await assert.rejects(apply(harness.ctx, { socketPath, wsPort: port,
    wsHost: '127.0.0.1', deviceFile: join(directory, 'devices.json'), warmSessionList: false }))
  assert.equal([...harness.listeners.values()].flat().length, 0)
  const replacement = createServer()
  t.after(() => new Promise(resolve => replacement.close(resolve)))
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve) })
})

test('audit: malformed user log records do not hide a later child session title', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { zstdCompressSync } = await import('node:zlib')
  const directory = await mkdtemp(join(tmpdir(), 'dshell-child-title-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(directory, { recursive: true, force: true })
  })
  const harness = await startHarness(t)
  makeSession(harness, 'child', [], { origin: 'subagent', parentSession: 'parent', cwd: '/work' })
  const logDir = join(directory, 'sessions', '--work--', 'child')
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(
    '{"type":"user/message",broken\n' + JSON.stringify({ type: 'session/title', data: { title: 'Recovered child title' } }) + '\n')))
  const client = new NdjClient(harness.socketPath)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next()
  client.send({ type: 'session/children', sessionId: 'parent' })
  const reply = await client.next()
  assert.equal(reply.type, 'session-children')
  assert.equal(reply.children[0].title, 'Recovered child title')
})
