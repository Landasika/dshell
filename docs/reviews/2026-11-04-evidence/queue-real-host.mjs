// Run from the repository root:
// node docs/reviews/2026-11-04-evidence/queue-real-host.mjs /absolute/path/to/dsh/lib/bin.js
// The runtime is read-only; all profile, sessions and credentials live in a temporary home.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { SocketBackend } from '../../../dist/backend/index.js'
import { runTui } from '../../../dist/tui/app.js'
import { foldInbox } from '../../../dist/tui/inbox.js'

const runtime = process.argv[2]
if (!runtime) throw new Error('Pass the absolute DSH runtime bin.js path; build dshell first.')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (predicate()) return; await pause(20) }
  throw new Error(`Timed out: ${label}`)
}
class Input extends EventEmitter {
  isTTY = true
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
}
class Output extends EventEmitter {
  isTTY = true
  columns = 110
  rows = 30
  text = ''
  write(text) { this.text += text; return true }
}

const directory = await mkdtemp(join(tmpdir(), 'dshell-queue-real-'))
const requests = []
const modelServer = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  const messages = request.messages.filter(message => message.role === 'user')
  const texts = messages.flatMap(message => typeof message.content === 'string'
    ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
  // The Host can add runtime-context user messages and request session titles.
  // Identify the last test prompt itself, rather than the last user-role entry.
  const prompt = texts.findLast(text => /^(hold-active|next-question-|last-question-)/.test(text))
  const requestRecord = { prompt: prompt ?? 'auxiliary', closed: false }
  requests.push(requestRecord)
  res.on('close', () => { requestRecord.closed = true })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
    id: `mock-${requests.length}`, object: 'chat.completion.chunk', created: 1,
    model: 'queue-model', choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n')
  chunk({ role: 'assistant', content: '' })
  // An actual open streaming request holds the active turn until Esc cancels it.
  if (prompt === 'hold-active') return
  chunk({ content: 'local mock reply' })
  chunk({}, 'stop')
  res.end('data: [DONE]\n\n')
})
let host
const backend = new SocketBackend(join(directory, 'run/dshell.sock'))
let input
let app
let hostStopped
try {
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, DSH_HOME: directory, DSHELL_QUEUE_MOCK_KEY: 'local-mock-only' }
  await promisify(execFile)(process.execPath, [runtime, 'queue-test', '--from-default-profile', 'web', '--dump-config'], { env })
  const profile = join(directory, 'profiles/queue-test')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: dshell-host
      name: ${JSON.stringify(resolve('dist/plugin/index.js'))}
- id: llm-pi-ai
  config:
    providers:
      queue-mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${modelServer.address().port}/v1
        apiKeyEnv: DSHELL_QUEUE_MOCK_KEY
        models:
          - id: queue-model
- id: agent-default-model
  config:
    provider: queue-mock
    model: queue-model
`)
  host = spawn(process.execPath, [runtime, 'queue-test', '--no-open', '--port', '0'], { env, stdio: 'ignore' })
  hostStopped = new Promise(resolve => host.once('exit', resolve))
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { await backend.connect(); break } catch { await pause(100) }
  }
  assert.equal(backend.connected, true, 'isolated Host starts')
  assert.equal(backend.capabilities().continueQueued, true)
  const results = []
  for (const gesture of ['escape', '/cancel']) {
    const handle = await backend.createSession({ cwd: directory })
    await backend.selectModel(handle.id, { provider: 'queue-mock', model: 'queue-model' })
    const before = requests.length
    await handle.send('hold-active', { mode: 'queue' })
    await until(() => requests.slice(before).some(request => request.prompt === 'hold-active'), 'first model stream opened')
    assert.equal(handle.snapshot().status, 'running')
    input = new Input()
    const output = new Output()
    app = runTui(backend, { cwd: directory, resume: handle.id, input, output, color: false, statePath: null })
    await until(() => backend.handleCount === 2, 'TUI attached')
    await pause(50)
    const first = await handle.send(`next-question-${gesture}`, { mode: 'queue' })
    const second = await handle.send(`last-question-${gesture}`, { mode: 'queue' })
    await until(() => output.text.includes(`last-question-${gesture}`), 'TUI sees queued messages')
    const pending = foldInbox(handle.snapshot().events).nextTurn
    assert.equal(pending.length, 2, 'both messages are pending before cancellation')
    input.emit('data', gesture === 'escape' ? '\u001b' : '/cancel\r')
    await until(() => handle.snapshot().events.filter(event => event.type === 'turn/end').length === 3, 'two queued turns complete')
    const view = handle.snapshot()
    const messages = view.events.filter(event => event.type === 'user/message').map(event => event.data.message ?? event.data)
    const ids = messages.map(message => message.source?.rpcId ?? message.id)
    assert.equal(ids.filter(id => id === first.requestId).length, 1, JSON.stringify({ first, messages }))
    assert.equal(ids.filter(id => id === second.requestId).length, 1)
    assert.ok(ids.indexOf(first.requestId) < ids.indexOf(second.requestId))
    assert.deepEqual(messages.slice(-2).map(message => message.id), pending.map(message => message.id), 'the original Host message IDs survive cancellation')
    const turns = requests.slice(before).filter(request => request.prompt !== 'auxiliary')
    assert.deepEqual(turns.map(request => request.prompt), ['hold-active', `next-question-${gesture}`, `last-question-${gesture}`])
    await until(() => turns[0].closed, 'canceled model stream closed')
    const endReasons = view.events.filter(event => event.type === 'turn/end').map(event => event.data.reason)
    assert.equal(endReasons[0].kind, 'aborted', 'Esc must cancel an active request, not just observe its natural completion')
    assert.deepEqual(foldInbox(view.events), { nextTurn: [], nextStep: [] })
    results.push({ gesture, modelTurns: turns.length, eachQueuedMessageOnce: true, fifo: true, endReasons, status: view.status })
    input.emit('end')
    assert.equal(await app, 0)
    app = undefined
    handle.dispose()
  }
  console.log(JSON.stringify({ isolatedRealHost: true, localMockModel: true, results }))
} finally {
  input?.emit('end')
  if (app) await app.catch(() => {})
  await backend.disconnect()
  modelServer.closeAllConnections()
  await new Promise(resolve => modelServer.close(resolve))
  if (host && host.exitCode === null) { host.kill('SIGINT'); await hostStopped }
  await rm(directory, { recursive: true, force: true })
}
