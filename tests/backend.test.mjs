import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { adaptSessionEvent, BackendError, FakeBackend, ReplayBackend, SocketBackend } from '../dist/backend/index.js'

async function socketServer(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-backend-'))
  const socketPath = join(directory, 'dshell.sock')
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) handler(JSON.parse(line), socket)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function write(socket, message) {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The client may close immediately after a cancel; the fake host must not
    // turn that into an unhandled EPIPE.
  }
}

test('FakeBackend exposes workspaces, sessions, streaming, and approval', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work/one', events: [] }])
  await backend.connect()
  assert.equal(backend.capabilities().createSession, true)

  const workspaces = await backend.listWorkspaces()
  assert.equal(workspaces[0].path, '/work/one')
  assert.equal((await backend.listSessions())[0].sessionId, 's1')

  const handle = await backend.createSession({ cwd: '/work/two' })
  const seen = []
  const off = handle.subscribe((view) => seen.push(view))
  const receipt = await handle.send('hello')
  assert.match(receipt.requestId, /^[0-9a-f-]{36}$/)
  const last = seen.at(-1)
  assert.equal(last.events.at(-1).type, 'turn/end')
  assert.equal(last.events.find((event) => event.type === 'assistant/message').data.message.content[0].text, 'echo: hello')
  assert.equal(seen.some((view) => view.events.some((event) => event.type === 'user/message')), true)
  off()
  handle.dispose()
  await backend.disconnect()
})

test('event adapter normalizes aliases and preserves unknown events as diagnostics', () => {
  assert.deepEqual(adaptSessionEvent({ type: 'todo/set', seq: 1, data: { todos: [] } }), {
    type: 'todo/write', seq: 1, data: { todos: [] }, sourceType: 'todo/set',
  })
  assert.deepEqual(adaptSessionEvent({ type: 'future/thing', seq: 2, data: { value: 3 } }), {
    type: 'diagnostic', seq: 2, data: { sourceType: 'future/thing', payload: { value: 3 } }, sourceType: 'future/thing',
  })
})

test('FakeBackend preserves ordered text and image prompt content', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events: [] }])
  await backend.connect()
  const handle = await backend.openSession('s1')
  await handle.send([
    { type: 'text', text: 'inspect this' },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
  ])
  const message = handle.snapshot().events.find((event) => event.type === 'user/message').data.message
  assert.deepEqual(message.content, [
    { type: 'text', text: 'inspect this' },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
  ])
  handle.dispose()
  await backend.disconnect()
})

test('FakeBackend exposes the agent presets a session would compose', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  assert.equal(backend.capabilities().agents, true)

  const roster = await backend.agentRoster()
  assert.equal(roster.defaultId, 'standard')
  assert.deepEqual(roster.presets.map((preset) => preset.id), ['standard', 'minimal'])
  assert.equal(roster.presets[0].plugins.some((plugin) => plugin.id === 'persona'), true)
  assert.equal(roster.presets[0].plugins.find((plugin) => plugin.id === 'tool-pwsh').disabled, true)
  assert.equal(roster.presets[0].overridden, true)
  assert.equal(roster.presets[1].overridden, false)

  // The roster is a detached copy: mutating it must not reach the backend.
  roster.presets[0].plugins.length = 0
  assert.equal((await backend.agentRoster()).presets[0].plugins.length, 4)
  await backend.disconnect()
})

test('ReplayBackend satisfies list, paging, disposal, and read-only contracts', async () => {
  const events = Array.from({ length: 7 }, (_, seq) => ({ type: seq === 0 ? 'user/message' : 'custom/event', seq, data: {} }))
  const backend = new ReplayBackend({
    pageSize: 3,
    sessions: [
      { sessionId: 'open', header: { id: 'open', cwd: '/work', title: 'Open', createdAt: 1 }, events, pinned: true },
      { sessionId: 'archived', header: { id: 'archived', cwd: '/old', title: 'Archived', createdAt: 2 }, events: [], archived: true },
    ],
  })
  await backend.connect()
  assert.deepEqual((await backend.listSessions()).map((session) => session.sessionId), ['open'])
  assert.deepEqual((await backend.listSessions(undefined, true)).map((session) => session.sessionId), ['open', 'archived'])
  assert.equal(backend.capabilities().paging, true)
  assert.equal(backend.capabilities().prompt, false)

  const handle = await backend.openSession('open')
  assert.equal(backend.handleCount, 1)
  assert.deepEqual(handle.snapshot().events.map((event) => event.seq), [4, 5, 6])
  assert.equal(handle.snapshot().hasMoreHistory, true)
  assert.equal(await handle.loadOlder(2), true)
  assert.deepEqual(handle.snapshot().events.map((event) => event.seq), [2, 3, 4, 5, 6])
  assert.equal(await handle.loadOlder(5), false)
  assert.deepEqual(handle.snapshot().events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6])
  await assert.rejects(() => handle.send('no'), /read-only/)
  await assert.rejects(() => handle.cancel(), /read-only/)
  await assert.rejects(() => handle.answerQuestion('q', []), /read-only/)
  handle.dispose()
  assert.equal(backend.handleCount, 0)
  assert.throws(() => handle.snapshot(), /disposed/)
  await backend.disconnect()
  await assert.rejects(() => backend.openSession('open'), /disconnected/)
})

test('SocketBackend answers pending questions', async (t) => {
  let answered = null
  let host = null
  const server = await socketServer((message, socket) => {
    host = socket
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'event', 'status', 'questions'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'attach') {
      write(socket, {
        type: 'attached',
        sessionId: message.sessionId,
        header: { id: message.sessionId, cwd: '/work' },
        cursor: 0,
        events: [],
      })
    } else if (message.type === 'question/answer') {
      answered = message
      write(socket, { type: 'question-answered', sessionId: message.sessionId, callId: message.callId })
    }
  })
  t.after(server.close)

  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  assert.equal(backend.capabilities().questions, true)
  const handle = await backend.openSession('s1')

  // A live request becomes part of the view the moment the Host sends it.
  const views = []
  const off = handle.subscribe((view) => views.push(view))
  write(host, {
    type: 'question/request',
    sessionId: 's1',
    callId: 'q1',
    questions: [{ id: 'pkg', question: 'which?', options: [{ label: 'A' }, { label: 'B' }] }],
    timed: false,
  })
  for (let index = 0; index < 100 && views.at(-1)?.pendingAsk === undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(views.at(-1)?.pendingAsk?.callId, 'q1')
  assert.equal(views.at(-1)?.pendingAsk?.timed, false)
  assert.equal(views.at(-1)?.pendingAsk?.questions[0].id, 'pkg')
  off()

  await handle.answerQuestion('q1', [{ id: 'pkg', selected: ['A'], custom: 'note' }])
  // answerQuestion resolves once the batch is written; the fake host sees it
  // on its next read tick, so wait for the round-trip before asserting.
  for (let index = 0; index < 100 && answered === null; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(answered?.callId, 'q1')
  assert.deepEqual(answered?.answers, [{ id: 'pkg', selected: ['A'], custom: 'note' }])

  // `question/closed` retires the request; the overlay goes with it.
  const latest = []
  const off2 = handle.subscribe((view) => latest.push(view))
  write(host, { type: 'question/closed', sessionId: 's1', callId: 'q1', reason: 'answered' })
  for (let index = 0; index < 100 && latest.at(-1)?.pendingAsk !== undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(latest.at(-1)?.pendingAsk, undefined)
  off2()
  handle.dispose()
  await backend.disconnect()
})

test('SocketBackend sends ordered prompt content and rejects media on legacy hosts', async (t) => {
  let received = null
  const modern = await socketServer((message, socket) => {
    if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test', capabilities: ['attach', 'prompt', 'prompt-content'], socketPath: 'test.sock', sessions: [], workspaces: [] })
    else if (message.type === 'attach') write(socket, { type: 'attached', sessionId: message.sessionId, header: { id: message.sessionId }, cursor: -1, events: [] })
    else if (message.type === 'prompt') { received = message; write(socket, { type: 'accepted', sessionId: message.sessionId, requestId: message.requestId, mode: message.mode }) }
  })
  t.after(modern.close)
  const backend = new SocketBackend(modern.socketPath)
  await backend.connect()
  const handle = await backend.openSession('s1')
  await handle.send([{ type: 'text', text: 'see' }, { type: 'file', receiptId: 'receipt-1' }])
  assert.deepEqual(received.content, [{ type: 'text', text: 'see' }, { type: 'file', receiptId: 'receipt-1' }])
  handle.dispose(); await backend.disconnect()

  const legacy = await socketServer((message, socket) => {
    if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'old', dshVersion: 'old', capabilities: ['attach', 'prompt'], socketPath: 'test.sock', sessions: [], workspaces: [] })
    else if (message.type === 'attach') write(socket, { type: 'attached', sessionId: message.sessionId, header: { id: message.sessionId }, cursor: -1, events: [] })
  })
  t.after(legacy.close)
  const oldBackend = new SocketBackend(legacy.socketPath)
  await oldBackend.connect()
  const oldHandle = await oldBackend.openSession('s1')
  await assert.rejects(() => oldHandle.send([{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }]), /does not accept image/)
  oldHandle.dispose(); await oldBackend.disconnect()
})

test('SocketSessionHandle attaches large histories without argument spreading or retention after dispose', async (t) => {
  const events = Array.from({ length: 100_000 }, (_, seq) => ({ type: 'custom/event', seq }))
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test', capabilities: ['list', 'attach'], socketPath: 'test.sock', sessions: [] })
    else if (message.type === 'attach') write(socket, { type: 'attached', sessionId: message.sessionId, header: { id: message.sessionId }, cursor: events.length - 1, events })
  })
  t.after(server.close)
  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  const handle = await backend.openSession('s1')
  assert.equal(handle.snapshot().events.length, 100_000)
  handle.dispose()
  assert.equal(backend.handleCount, 0)
  await backend.disconnect()
})

test('FakeBackend raises and settles pending questions', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const handle = await backend.openSession('s1')
  const views = []
  const off = handle.subscribe((view) => views.push(view))
  backend.askQuestion('s1', 'q1', [{ id: 'a', question: 'pick one', options: [{ label: 'One' }] }])
  assert.equal(views.at(-1)?.pendingAsk?.callId, 'q1')
  assert.equal(views.at(-1)?.pendingAsk?.timed, true)
  await handle.answerQuestion('q1', [{ id: 'a', selected: ['One'] }])
  assert.equal(views.at(-1)?.pendingAsk, undefined)
  assert.deepEqual(backend.answeredQuestions, [
    { sessionId: 's1', callId: 'q1', answers: [{ id: 'a', selected: ['One'] }] },
  ])
  assert.equal(
    views.some((view) => view.events.some((event) => event.type === 'tool/result' && event.data.message.toolCallId === 'q1')),
    true,
  )
  off()
  handle.dispose()
  await backend.disconnect()
})

test('SocketBackend maps list, attach, prompt, and stream over a Unix socket', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt', 'event', 'stream', 'status', 'workspaces', 'history', 'cancel', 'steer', 'approval'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'session/list' || message.type === 'list') {
      write(socket, { type: 'sessions', sessions: [{ sessionId: 's1', live: true, cwd: '/work' }] })
    } else if (message.type === 'workspaces') {
      write(socket, { type: 'workspaces', workspaces: [{ id: 'workspace:/work', path: '/work', title: 'work' }] })
    } else if (message.type === 'session/create') {
      write(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this host cannot create sessions',
      })
    } else if (message.type === 'attach') {
      write(socket, {
        type: 'attached',
        sessionId: message.sessionId,
        header: { id: message.sessionId, cwd: '/work' },
        cursor: 0,
        events: [{ type: 'user/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'old' }] } } }],
      })
    } else if (message.type === 'prompt') {
      write(socket, {
        type: 'accepted',
        sessionId: message.sessionId,
        requestId: 'r1',
        mode: 'queue',
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: { type: 'turn/start', seq: 1, data: { turn: 1 } },
      })
      write(socket, {
        type: 'stream',
        sessionId: message.sessionId,
        frame: { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: {
          type: 'assistant/message',
          seq: 2,
          data: { message: { content: [{ type: 'text', text: 'hi' }] } },
        },
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: {
          type: 'llm/retry',
          seq: 3,
          data: { retry: 2, maxRetries: 5, delayMs: 4_000, failure: { code: 'RATE_LIMIT' } },
        },
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
      })
    }
  })
  t.after(server.close)

  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  assert.equal(backend.capabilities().createSession, false)
  assert.equal((await backend.listSessions())[0].sessionId, 's1')
  assert.equal((await backend.listWorkspaces())[0].path, '/work')

  const handle = await backend.openSession('s1')
  const seen = []
  // A failed assertion below must not leak the connection: server.close()
  // waits for open sockets, so an undisposed handle hangs the whole file.
  try {
    const off = handle.subscribe((view) => seen.push(view))
    const receipt = await handle.send('hello')
    assert.equal(receipt.requestId, 'r1')
    const last = seen.at(-1)
    assert.equal(last.events.at(-1).type, 'turn/end')
    assert.equal(last.events.find((event) => event.type === 'assistant/message').seq, 2)
    assert.equal(seen.some((view) => view.streamText === 'hi'), true)
    // A scheduled retry drops the failed attempt's stream preview: the spinner
    // must report the backoff, not keep claiming the model is writing. Views
    // share one append-only events array, so assert on the cursor the snapshot
    // carried (llm/retry is seq 3), not on `events.at(-1)` of an older view.
    assert.equal(seen.some((view) => view.cursor === 3 && view.streamText === ''), true)
    off()
  } finally {
    handle.dispose()
    await backend.disconnect()
  }
})


test('SocketBackend supports history paging, steer, cancel, and approvals', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt', 'event', 'stream', 'status', 'workspaces', 'create-session', 'history', 'cancel', 'steer', 'approval'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'attach') {
      write(socket, {
        type: 'attached',
        sessionId: message.sessionId,
        header: { id: message.sessionId, cwd: '/work' },
        cursor: 6,
        events: [
          { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'newer' }] } } },
          { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
        ],
      })
    } else if (message.type === 'session/create') {
      write(socket, {
        type: 'session-created',
        sessionId: 'created-1',
        header: { id: 'created-1', cwd: message.cwd ?? '/work' },
        workspaceId: 'workspace:/work',
      })
    } else if (message.type === 'session/history') {
      write(socket, {
        type: 'history',
        sessionId: message.sessionId,
        events: [{ type: 'user/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'older' }] } } }],
        cursor: 4,
        hasMore: false,
      })
    } else if (message.type === 'prompt') {
      write(socket, {
        type: 'accepted',
        sessionId: message.sessionId,
        requestId: 'steer-1',
        mode: message.mode ?? 'queue',
      })
      write(socket, {
        type: 'approval-request',
        sessionId: message.sessionId,
        requestId: 'approval-1',
        toolName: 'bash',
        reason: 'test approval',
      })
    } else if (message.type === 'approval/answer') {
      write(socket, {
        type: 'approval-resolved',
        sessionId: 's1',
        requestId: message.requestId,
        outcome: message.outcome,
        source: 'cli',
      })
    } else if (message.type === 'session/cancel') {
      write(socket, { type: 'cancelled', sessionId: message.sessionId })
    }
  })
  t.after(server.close)

  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  assert.equal(backend.capabilities().paging, true)
  assert.equal(backend.capabilities().approvals, true)

  const created = await backend.createSession({ cwd: '/work/new' })
  assert.equal(created.id, 'created-1')
  assert.equal(created.header.id, 'created-1')
  created.dispose()

  const handle = await backend.openSession('s1')
  assert.equal(await handle.loadOlder(), false)
  assert.equal(handle.snapshot().events[0].seq, 4)

  const receipt = await handle.send('steer me', { mode: 'steer' })
  assert.equal(receipt.mode, 'steer')
  for (let index = 0; index < 50 && handle.snapshot().pendingApproval === undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const pending = handle.snapshot().pendingApproval
  assert.equal(pending?.requestId, 'approval-1')
  await handle.answerApproval('approval-1', 'allowed-once')
  for (let index = 0; index < 50 && handle.snapshot().pendingApproval !== undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(handle.snapshot().pendingApproval, undefined)

  await handle.cancel()
  handle.dispose()
  await backend.disconnect()
})

test('SocketBackend reports unsupported capabilities clearly', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'session/create') {
      write(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this host cannot create sessions',
      })
    }
  })
  t.after(server.close)
  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  await assert.rejects(
    backend.createSession(),
    (error) => error instanceof BackendError && error.code === 'UNSUPPORTED_CAPABILITY',
  )
  await backend.disconnect()
})

test('queue-preserving cancellation refuses an old Host and surfaces cancellation errors', async t => {
  for (const supported of [false, true]) await t.test(supported ? 'Host rejects stop' : 'old Host lacks support', async t => {
    const commands = []
    const server = await socketServer((message, socket) => {
      if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test',
        socketPath: 'test.sock', sessions: [], capabilities: ['attach', 'cancel', ...(supported ? ['cancel-continue'] : [])] })
      else if (message.type === 'attach') write(socket, { type: 'attached', sessionId: 's1', header: { id: 's1' }, cursor: -1, events: [] })
      else if (message.type === 'session/cancel') {
        commands.push(message)
        write(socket, { type: 'error', code: 'BAD_REQUEST', message: 'the active turn has changed' })
      }
    })
    const backend = new SocketBackend(server.socketPath)
    t.after(async () => { await backend.disconnect(); await server.close() })
    await backend.connect()
    const handle = await backend.openSession('s1')
    await assert.rejects(handle.cancel(false, undefined, { continueQueued: true }),
      supported ? /active turn has changed/ : /cannot stop a turn and continue/)
    assert.equal(commands.length, supported ? 1 : 0, 'old Hosts must never receive a destructive fallback cancel')
    if (supported) assert.equal(commands[0].continueQueued, true)
  })
})

test('SocketBackend reads the model catalog and forwards selections', async (t) => {
  const catalog = {
    default: { provider: 'relay', model: 'relay-flash' },
    routableProviders: ['relay'],
    groups: [{ id: 'relay', name: 'Relay', models: [{ id: 'relay-flash', name: 'Relay Flash' }] }],
    failures: [],
  }
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'models'],
        socketPath: server.socketPath,
        sessions: [],
        workspaces: [],
      })
    } else if (message.type === 'model/catalog') {
      write(socket, { type: 'model-catalog', catalog })
    } else if (message.type === 'model/select') {
      write(socket, {
        type: 'model-selected',
        sessionId: message.sessionId,
        selected: { provider: message.provider, model: message.model },
        savedAsDefault: true,
      })
    } else if (message.type === 'model/default') {
      write(socket, {
        type: 'model-selected',
        selected: { provider: message.provider, model: message.model },
        savedAsDefault: true,
      })
    }
  })
  t.after(server.close)

  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  assert.equal(backend.capabilities().models, true)
  assert.equal((await backend.modelCatalog()).default.model, 'relay-flash')
  assert.deepEqual(
    await backend.selectModel('s1', { provider: 'relay', model: 'relay-flash' }),
    { provider: 'relay', model: 'relay-flash' },
  )
  assert.deepEqual(
    await backend.saveDefaultModel({ provider: 'relay', model: 'relay-flash' }),
    { provider: 'relay', model: 'relay-flash' },
  )
  await backend.disconnect()
})

test('audit: session actions on old Hosts consistently report an unsupported capability', async t => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test',
      socketPath: 'test.sock', sessions: [], capabilities: [] })
    else write(socket, { type: 'error', code: 'BAD_REQUEST', message: `unknown message type: ${message.type}` })
  })
  const backend = new SocketBackend(server.socketPath)
  t.after(async () => { await backend.disconnect(); await server.close() })
  await backend.connect()
  for (const action of ['rename', 'archive', 'restore', 'pin', 'fork', 'compact']) {
    await assert.rejects(backend.sessionAction(action, 's1', 'title'),
      error => error instanceof BackendError && error.code === 'UNSUPPORTED_CAPABILITY' && /restart/i.test(error.action))
  }
})

test('audit: prompt admission flags survive the socket adapter and fake prompts retain request correlation', async t => {
  let sessionSocket
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') write(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test',
      socketPath: 'test.sock', sessions: [], capabilities: ['prompt', 'attach'] })
    else if (message.type === 'attach') { sessionSocket = socket; write(socket, { type: 'attached', sessionId: 's1', header: { id: 's1' }, cursor: -1, events: [] }) }
    else if (message.type === 'prompt') write(socket, { type: 'accepted', sessionId: 's1', requestId: message.requestId, mode: 'queue', deferred: true })
  })
  const backend = new SocketBackend(server.socketPath)
  t.after(async () => { await backend.disconnect(); await server.close() })
  await backend.connect()
  const handle = await backend.openSession('s1')
  assert.deepEqual(await handle.send('queued', { requestId: 'explicit' }), { requestId: 'explicit', mode: 'queue', deferred: true })
  const promoted = new Promise(resolve => {
    const off = handle.subscribe(view => {
      if (view.promptAdmission?.promoted) { off(); resolve(view.promptAdmission) }
    })
  })
  write(sessionSocket, { type: 'accepted', sessionId: 's1', requestId: 'explicit', mode: 'queue', promoted: true })
  assert.deepEqual(await promoted, { requestId: 'explicit', mode: 'queue', promoted: true })
  const fake = new FakeBackend([{ sessionId: 's1' }])
  await fake.connect()
  t.after(() => fake.disconnect())
  const fakeHandle = await fake.openSession('s1')
  t.after(() => fakeHandle.dispose())
  const receipt = await fakeHandle.send('first', { requestId: 'explicit' })
  const message = fakeHandle.snapshot().events.find(event => event.type === 'user/message').data.message
  assert.equal(receipt.requestId, 'explicit')
  assert.equal(message.id, receipt.requestId)
  assert.equal(message.source.rpcId, receipt.requestId)
  fake.emit('s1', { type: 'turn/start', seq: 10, data: {} })
  fake.askApproval('s1', { requestId: 'approval', sessionId: 's1' })
  await fakeHandle.answerApproval('approval', 'allowed-once')
  assert.equal(fakeHandle.snapshot().status, 'running')
})
