import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FakeBackend, SocketBackend } from '../dist/backend/index.js'
import { runTui } from '../dist/tui/app.js'

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await pause(10)
  }
  throw new Error(`timed out: ${label}`)
}

class Input extends EventEmitter {
  isTTY = true
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  push(text) { this.emit('data', text) }
}
class Output extends EventEmitter {
  isTTY = true
  columns = 110
  rows = 30
  text = ''
  lines = []
  cursor
  write(text) {
    this.text += text
    if (text.includes('\u001b[2J')) this.lines = []
    for (const match of text.matchAll(/\u001b\[(\d+);1H\u001b\[2K([^\u001b]*)/g)) this.lines[Number(match[1]) - 1] = match[2]
    for (const match of text.matchAll(/\u001b\[(\d+);(\d+)H\u001b\[\?25h|\u001b\[\?25l/g)) {
      this.cursor = match[1] ? { row: Number(match[1]), column: Number(match[2]) } : undefined
    }
    return true
  }
}

// Exercise the real socket backend and TUI, including separate control/view
// sockets. Faults happen after the durable commit, where a fake method return
// cannot represent a missing acknowledgement or a frontend reload.
async function journey(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-journey-'))
  const socketPath = join(directory, 'dshell.sock')
  const sockets = new Set()
  const watches = new Map()
  const events = new Map(['s1', 's2'].map(id => [id, []]))
  if (options.events) events.set('s1', options.events)
  const calls = []
  const pending = []
  let attaches = 0
  let connections = 0
  let defaultSelection = { provider: 'journey', model: 'model-a' }
  const write = (socket, message) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n')
  }
  const emit = (sessionId, type, data) => {
    const log = events.get(sessionId)
    const event = { type, seq: log.length, data }
    log.push(event)
    for (const [socket, watched] of watches) if (watched === sessionId) write(socket, { type: 'event', sessionId, event })
  }
  const reply = (socket, request, message) => write(socket, { ...message, rpcId: request.rpcId })
  const server = createServer(socket => {
    connections += 1
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); watches.delete(socket) })
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (request.type === 'hello') {
          reply(socket, request, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test', socketPath,
            capabilities: ['rpc-id', 'models', 'attach', 'list', 'workspaces', 'prompt', 'history', 'cancel'], sessions: [] })
        } else if (request.type === 'workspaces') reply(socket, request, { type: 'workspaces', workspaces: [] })
        else if (request.type === 'session/list') reply(socket, request, { type: 'sessions', sessions: [...events.keys()].map(sessionId => ({ sessionId, cwd: directory })) })
        else if (request.type === 'attach') {
          attaches += 1
          watches.set(socket, request.sessionId)
          const log = events.get(request.sessionId)
          reply(socket, request, { type: 'attached', sessionId: request.sessionId, header: { id: request.sessionId, cwd: directory },
            events: options.tail ? log.slice(-options.tail) : log, cursor: log.length - 1, hasMore: Boolean(options.tail && log.length > options.tail),
            ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
            ...(options.modelSelectionLastUsed ? { modelSelectionLastUsed: options.modelSelectionLastUsed } : {}), status: options.running ? 'running' : 'idle' })
          write(socket, { type: 'status', sessionId: request.sessionId, status: options.running ? 'running' : 'idle' })
        } else if (request.type === 'model/catalog') {
          reply(socket, request, { type: 'model-catalog', catalog: { default: defaultSelection, routableProviders: ['journey'], failures: [],
            groups: [{ id: 'journey', name: 'Journey', models: ['a', 'b', 'c'].map(id => ({ id: `model-${id}`, name: `Model ${id.toUpperCase()}` })) }] } })
        } else if (request.type === 'model/select') {
          calls.push(request)
          const acknowledge = () => {
            if (options.loseAck && calls.length === 1) socket.destroy()
            else reply(socket, request, { type: 'model-selected', sessionId: request.sessionId,
              selected: { provider: request.provider, model: request.model } })
          }
          const finish = () => {
            if (options.reject) { reply(socket, request, { type: 'error', code: 'BAD_REQUEST', message: 'model unavailable' }); return }
            defaultSelection = { provider: request.provider, model: request.model }
            emit(request.sessionId, 'model/selection', defaultSelection)
            if (options.holdReceipt) pending.push(acknowledge)
            else acknowledge()
          }
          if (options.hold) pending.push(finish)
          else finish()
        }
      }
    })
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  const backend = new SocketBackend(socketPath)
  await backend.connect()
  const input = new Input()
  const output = new Output()
  const app = runTui(backend, { cwd: directory, resume: 's1', color: false, input, output })
  t.after(async () => {
    input.emit('end')
    await app
    await backend.disconnect()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await until(() => attaches > 0 && /idle|running/.test(output.text), 'initial session')
  const pickB = async () => {
    output.text = ''
    input.push('/model\r')
    await until(() => output.text.includes('Model B'), 'model picker')
    input.push('\u001b[B\r')
  }
  return { backend, input, output, pickB, calls, pending, emit, app,
    dropViews() { for (const socket of watches.keys()) socket.destroy() },
    dropAll() { for (const socket of sockets) socket.destroy() },
    get connections() { return connections }, get attaches() { return attaches } }
}

test('one model confirmation survives a lost receipt and restores the committed model', async t => {
  const ui = await journey(t, { loseAck: true })
  await ui.pickB()
  await until(() => ui.attaches >= 2, 'automatic reattach')
  await pause(150)
  assert.equal(ui.calls.length, 1, 'a committed switch must not require resubmitting')
  ui.output.text = ''
  ui.output.columns -= 1
  ui.output.emit('resize')
  await pause(80)
  assert.match(ui.output.lines[ui.output.rows - 1] ?? '', /journey\/model-b/, 'reattach must recover the durable model selection in the usage rail')
})

test('holding Enter during a slow model switch submits only once', async t => {
  const ui = await journey(t, { hold: true })
  await ui.pickB()
  await until(() => ui.calls.length === 1, 'first model switch')
  ui.input.push('\r\r\r\r\r')
  await pause(50)
  ui.pending[0]()
  await pause(100)
  assert.equal(ui.calls.length, 1, 'repeated keys must not enqueue default writes or extra switches')
})

test('a model reply for an old session cannot change the newly attached session', async t => {
  const ui = await journey(t, { hold: true })
  await ui.pickB()
  await until(() => ui.calls.length === 1, 'pending model switch')
  ui.input.push('\u001b')
  await pause(50)
  ui.input.push('/attach s2\r')
  await until(() => ui.attaches >= 2, 'second session')
  ui.output.text = ''
  ui.pending[0]()
  await pause(100)
  assert.doesNotMatch(ui.output.text, /model → journey\/model-b|journey\/model-b/, 'old completion must not repaint session two')
})

test('a model selection from another frontend refreshes the usage rail immediately', async t => {
  const ui = await journey(t)
  await ui.pickB()
  await until(() => ui.output.text.includes('model → journey/model-b'), 'model switch')
  ui.output.text = ''
  ui.emit('s1', 'model/selection', { provider: 'journey', model: 'model-c' })
  await pause(100)
  assert.match(ui.output.text, /journey\/model-c/)
})

test('a rejected model switch keeps the connection usable and can succeed on the next action', async t => {
  const faults = { reject: true }
  const ui = await journey(t, faults)
  await ui.pickB()
  await until(() => ui.output.text.includes('model switch failed'), 'visible model error')
  assert.equal(ui.backend.connected, true)
  assert.equal(ui.attaches, 1)
  assert.equal((await ui.backend.modelCatalog()).default.model, 'model-a')
  ui.input.push('\u001b')
  faults.reject = false
  await pause(30)
  await ui.pickB()
  await until(() => ui.calls.length === 2, 'retry reaches Host')
  await until(() => ui.output.lines.at(-1)?.includes('model-b'), 'retry succeeds')
  assert.equal(ui.attaches, 1)
})

test('an old in-flight request cannot consume a model chosen for the next request', async t => {
  const ui = await journey(t, { running: true })
  await ui.pickB()
  await until(() => ui.output.lines.at(-1)?.includes('model-b'), 'pending model')
  ui.emit('s1', 'request/header', { header: { config: { provider: 'journey', model: 'model-a' } } })
  await pause(60)
  assert.match(ui.output.lines[ui.output.rows - 1], /model-b/)
  ui.emit('s1', 'request/header', { header: { config: { provider: 'journey', model: 'model-b' } } })
  await pause(60)
  assert.match(ui.output.lines[ui.output.rows - 1], /model-b/)
  ui.emit('s1', 'request/header', { header: { config: { provider: 'journey', model: 'model-c' } } })
  await until(() => ui.output.lines.at(-1)?.includes('model-c'), 'matched choice consumed; latest request visible')
})

test('a late model receipt cannot overwrite a newer durable choice from another frontend', async t => {
  const ui = await journey(t, { holdReceipt: true })
  await ui.pickB()
  await until(() => ui.pending.length === 1, 'committed choice awaiting receipt')
  ui.emit('s1', 'model/selection', { provider: 'journey', model: 'model-c' })
  ui.input.push('\u001b')
  await until(() => ui.output.lines.at(-1)?.includes('model-c'), 'newer choice')
  ui.pending[0]()
  await pause(80)
  assert.match(ui.output.lines[ui.output.rows - 1], /model-c/)
})

test('long-session attach restores the owner model selection outside the visible history page', async t => {
  const ui = await journey(t, { tail: 80, modelSelection: { provider: 'journey', model: 'model-c' },
    events: Array.from({ length: 600 }, (_, seq) => seq === 0
      ? { type: 'model/selection', seq, data: { provider: 'journey', model: 'model-c' } }
      : { type: 'custom/entry', seq, data: {} }) })
  await until(() => ui.output.lines.at(-1)?.includes('model-c'), 'owner projection visible')
})

test('reattaching an inherited model does not pin it over later request headers', async t => {
  const model = { provider: 'journey', model: 'model-a' }
  const ui = await journey(t, { modelSelection: model, modelSelectionLastUsed: model })
  ui.emit('s1', 'request/header', { header: { config: { provider: 'journey', model: 'model-c' } } })
  await until(() => ui.output.lines.at(-1)?.includes('model-c'), 'latest request replaces inherited model')
})

test('a view-only socket failure reattaches and repeated failures leave one live handle', async t => {
  const ui = await journey(t)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = ui.attaches
    ui.dropViews()
    await until(() => ui.attaches > before, 'view reconnect')
    await until(() => ui.backend.handleCount === 1, 'one recovered handle')
  }
  assert.equal(ui.backend.connected, true)
  assert.equal(ui.backend.handleCount, 1)
})

test('quitting during reconnect prevents any later background connection', async t => {
  const ui = await journey(t)
  ui.dropAll()
  await until(() => ui.output.text.includes('host connection lost'), 'reconnect announced')
  ui.input.emit('end')
  assert.equal(await ui.app, 0)
  const before = ui.connections
  await pause(1100)
  assert.equal(ui.connections, before)
  assert.equal(ui.backend.handleCount, 0)
})

test('switching sessions during reconnect cannot take the user back to the disconnected session', async t => {
  const ui = await journey(t)
  ui.dropViews()
  await until(() => ui.output.text.includes('host connection lost'), 'view disconnected')
  ui.input.push('/attach s2\r')
  await until(() => ui.output.lines[0]?.includes('s2'), 'user attaches session two')
  await pause(1300)
  assert.match(ui.output.lines[0], /s2/, 'reconnect must preserve the latest session choice')
  assert.equal(ui.backend.handleCount, 1)
})

test('an explicit reconnect reopens the control connection as well as the session view', async t => {
  const ui = await journey(t)
  ui.dropAll()
  await until(() => !ui.backend.connected, 'control disconnected')
  ui.input.push('/reconnect\r')
  await pause(250)
  assert.equal(ui.backend.connected, true, 'manual reconnect must work without waiting for the automatic backoff')
  assert.equal(ui.attaches, 2)
  assert.equal(ui.backend.handleCount, 1)
})

test('a slow model receipt preserves a different panel opened while waiting', async t => {
  const ui = await journey(t, { hold: true })
  await ui.pickB()
  await until(() => ui.pending.length === 1, 'pending switch')
  ui.input.push('\u001b')
  await pause(30)
  ui.input.push('/help\r')
  await until(() => ui.output.lines.some(line => line?.includes('help & shortcuts')), 'help opened')
  ui.pending[0]()
  await pause(80)
  assert.ok(ui.output.lines.some(line => line?.includes('help & shortcuts')), 'late completion must preserve the active panel')
})

async function fakeJourney(t, { events = [], columns = 100, rows = 30 } = {}) {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/tmp', events }])
  await backend.connect()
  const input = new Input()
  const output = new Output()
  Object.assign(output, { columns, rows })
  const app = runTui(backend, { cwd: '/tmp', resume: 's1', input, output, color: false })
  t.after(async () => { input.emit('end'); await app; await backend.disconnect() })
  await until(() => backend.openHandleCount === 1, 'fake attach')
  await pause(40)
  return { backend, input, output }
}

test('history search scrolls the selected prompt into view beyond the first page', async t => {
  const ui = await fakeJourney(t, { events: Array.from({ length: 25 }, (_, seq) => ({ type: 'user/message', seq,
    data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt-${String(seq).padStart(2, '0')}` }] } } })) })
  ui.input.push('\u0012')
  await until(() => ui.output.lines.some(line => line?.includes('history search')), 'history panel')
  ui.input.push('\u001b[B'.repeat(15))
  await pause(80)
  assert.ok(ui.output.lines.some(line => line?.includes('▸ prompt-09')), '16th selected row must be visible')
  ui.input.push('\r')
  await until(() => ui.output.lines.some(line => line?.includes('prompt-09')), 'prompt inserted')
})

test('long question text can be read completely with PageDown', async t => {
  const ui = await fakeJourney(t)
  ui.backend.askQuestion('s1', 'q-long', [{ id: 'q', question: Array.from({ length: 18 }, (_, i) => `question-line-${i}`).join('\n'),
    detail: 'detail-last-line', options: [{ label: 'Approve' }] }])
  await until(() => ui.output.text.includes('question-line-0'), 'question opened')
  for (let page = 0; page < 12; page += 1) { ui.input.push('\u001b[6~'); await pause(25) }
  assert.match(ui.output.text, /question-line-17/, 'question tail must be reachable')
  assert.match(ui.output.text, /detail-last-line/)
})

test('a 20 by 6 terminal keeps the composer and custom question answer cursor visible', async t => {
  const ui = await fakeJourney(t, { columns: 20, rows: 6 })
  ui.input.push('visible-input')
  await pause(80)
  assert.ok(ui.output.cursor, 'composer cursor must remain on screen')
  assert.ok(ui.output.lines.some(line => line?.includes('visible-input')))
  ui.backend.askQuestion('s1', 'q-tiny', [{ id: 'q', question: ['choose', ...Array.from({ length: 9 }, (_, i) => `tiny-line-${i}`)].join('\n'), options: [{ label: 'A' }] }])
  await until(() => ui.output.text.includes('choose'), 'tiny question')
  for (let page = 0; page < 9; page += 1) {
    ui.input.push('\u001b[6~')
    await until(() => ui.output.lines.some(line => line?.includes(`tiny-line-${page}`)), 'short viewport reads every line between pages')
  }
  ui.input.push('c')
  ui.input.push('tiny-answer')
  await pause(80)
  assert.ok(ui.output.cursor, 'custom answer cursor must remain on screen')
  assert.ok(ui.output.lines.some(line => line?.includes('tiny-answer')), 'typed answer must be visible')
  ui.input.push('\r')
  await until(() => ui.backend.answeredQuestions.length === 1, 'tiny answer submitted')
  assert.equal(ui.backend.answeredQuestions[0].answers[0].custom, 'tiny-answer')
})

test('quitting while the first attach is pending disposes its late handle', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/tmp' }])
  backend.openSessionDelayMs = 150
  await backend.connect()
  const input = new Input()
  const output = new Output()
  const app = runTui(backend, { cwd: '/tmp', resume: 's1', input, output, color: false })
  await pause(30)
  input.emit('end')
  assert.equal(await app, 0)
  assert.equal(backend.openHandleCount, 0, 'late attach must not create a live orphan handle')
  await backend.disconnect()
})

test('lost model receipt, another frontend selection, simultaneous socket failures and resize preserve the current model and draft', async t => {
  const ui = await journey(t, { holdReceipt: true, loseAck: true })
  await ui.pickB()
  await until(() => ui.pending.length === 1, 'committed model awaiting receipt')
  ui.input.push('\u001b')
  await pause(30)
  ui.input.push('恢复草稿 👩🏽‍💻')
  ui.emit('s1', 'model/selection', { provider: 'journey', model: 'model-c' })
  ui.output.columns = 20
  ui.output.rows = 6
  ui.output.emit('resize')
  ui.pending[0]()
  ui.dropViews()
  await until(() => ui.attaches >= 2, 'recovered after both sockets failed')
  ui.output.columns = 110
  ui.output.rows = 30
  ui.output.emit('resize')
  await until(() => ui.output.lines.at(-1)?.includes('model-c'), 'newest committed model restored')
  assert.equal(ui.calls.length, 1, 'reconnect must not overwrite the other frontend with an automatic retry')
  assert.ok(ui.output.lines.some(line => line?.includes('恢复草稿 👩🏽‍💻')), 'unsent draft must survive reconnect and resize')
  assert.ok(ui.output.cursor)
  assert.equal(ui.backend.handleCount, 1)
})
