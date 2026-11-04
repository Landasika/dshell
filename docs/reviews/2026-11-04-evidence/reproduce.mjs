// Audit probe: assertions describe defects present at the audited commit.
// Run pnpm build first; all configuration and sockets use temporary directories.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createFakeCtx, makeSession } from './support.mjs'
import { apply } from '../../../dist/plugin/index.js'
import { SocketBackend, SocketSessionHandle } from '../../../dist/backend/socket.js'
import { HostConnection } from '../../../dist/client/socket-client.js'
import { readProviders, setProviderField, syncProviderModels } from '../../../dist/plugin/profile.js'
import { pendingQuestions } from '../../../dist/tui/events.js'
import { editKey } from '../../../dist/tui/editor.js'
import { columnSlice, displayWidth } from '../../../dist/tui/width.js'

const pause = ms => new Promise(r => setTimeout(r, ms))
const report = (id, facts) => console.log(JSON.stringify({ id, ...facts }))
const root = await mkdtemp(join(tmpdir(), 'dshell-audit-'))
process.env.DSH_HOME = root
const file = join(root, 'cordis.patch.yml')
const patch = `- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      a-b:\n        baseURL: https://example.invalid/v1\n        apiKeyEnv: A_B_API_KEY\n        models:\n          - id: old\n      a.b:\n        baseURL: https://example.invalid/v1\n        models:\n          - id: other\n`
await writeFile(file, patch)
const stored = new Map()
const harness = createFakeCtx({
  dshHomePath: root,
  credentials: { async set(ref, value) { stored.set(ref, value) } },
})
const socketPath = join(root, 'host.sock')
await apply(harness.ctx, { socketPath })
const backend = new SocketBackend(socketPath)
const cleanup = async () => {
  await backend.disconnect()
  for (const dispose of harness.disposers) await dispose()
  await rm(root, { recursive: true, force: true })
}
try {
  await backend.connect()
  let syncError
  try { await backend.applyProviderSync('a-b', ['new'], []) } catch (e) { syncError = e.message }
  assert.match(syncError, /refusing to write/)
  assert.equal(await readFile(file, 'utf8'), patch)
  report('provider-sync-add', { error: syncError, fileUnchanged: true })

  const unrelated = `- id: unrelated\n  name: 'unrelated-plugin'\n  config:\n    providers:\n      a-b:\n        baseURL: https://wrong.invalid\n        models:\n          - id: wrong\n${patch}`
  assert.equal(readProviders(unrelated)[0].baseURL, 'https://wrong.invalid')
  report('provider-wrong-block', { firstProvider: readProviders(unrelated)[0], editedWrongPlugin: setProviderField(unrelated, 'a-b', 'baseURL', 'https://changed.invalid').includes('baseURL: https://changed.invalid\n') })

  await backend.storeProviderKey('a-b', 'FAKE_SECRET_1')
  await backend.storeProviderKey('a.b', 'FAKE_SECRET_2')
  assert.equal(stored.size, 1)
  report('credential-collision', { refs: [...stored.keys()], bothProvidersShareRef: readProviders(await readFile(file, 'utf8')).every(p => p.apiKeyEnv === 'A_B_API_KEY'), secondOverwritesFirst: stored.get('A_B_API_KEY') === 'FAKE_SECRET_2' })

  makeSession(harness, 's1', [{ type: 'turn/start', seq: 0, data: {} }])
  makeSession(harness, 's2', [])
  const one = await backend.openSession('s1')
  const agent = { id: 's1', session: { id: 's1' } }
  let webCalled = 0
  const question = harness.emit('user-questions/request', {
    agent, wait: { callId: 'q1', timed: true },
    questions: [{ id: 'q', question: 'Approve the plan?', detail: 'FULL_PLAN_DETAIL', intent: { kind: 'plan-review', approve: 'Yes' }, options: [{ label: 'Yes' }, { label: 'No' }] }],
  }, async () => { webCalled++; return { answers: [{ id: 'q', selected: ['No'] }] } })
  await pause(30)
  assert(one.snapshot().pendingAsk)
  assert.equal(one.snapshot().pendingAsk.questions[0].detail, undefined)
  const second = await backend.openSession('s1')
  assert.equal(second.snapshot().pendingAsk, undefined)
  report('question-detail-and-replay', { detailForwarded: false, nextWebCalled: webCalled, secondViewerHasPendingAsk: Boolean(second.snapshot().pendingAsk) })
  const wrong = await backend.openSession('s2')
  await wrong.answerQuestion('q1', [{ id: 'not-the-question', selected: ['not-an-option'] }])
  const result = await question
  assert.equal(result[0].answers[0].id, 'not-the-question')
  report('question-cross-session-answer', { actualQuestionSession: 's1', answeringSession: 's2', acceptedResult: result })

  const approval = harness.emit('approval/request', { agent, toolName: 'bash' }, async () => new Promise(() => {}))
  await pause(30)
  assert(one.snapshot().pendingApproval)
  const late = await backend.openSession('s1')
  assert.equal(late.snapshot().pendingApproval, undefined)
  report('approval-late-attach', { originalHasApproval: true, newViewerHasApproval: false })
  await one.answerApproval(one.snapshot().pendingApproval.requestId, 'rejected')
  await approval

  const e = editKey({ text: 'x\n🐳', cursor: 1 }, 'down').state
  report('unicode-copy-editor', { text: '🐳a', columns1to2: columnSlice('🐳a', 1, 2), column3: columnSlice('🐳a', 3, 3), familyWidth: displayWidth('👨‍👩‍👧‍👦'), movedCursor: e.cursor, breaksSurrogate: e.cursor === 3 })
  const qevents = [
    { type: 'tool/call', seq: 0, data: { name: 'ask_user_question', callId: 'older', arguments: { questions: [{ id: 'q1', question: 'older' }] } } },
    { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', callId: 'newer', arguments: { questions: [{ id: 'q2', question: 'newer' }] } } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'newer', content: [{ type: 'text', text: '{}' }] } } },
  ]
  assert.equal(pendingQuestions(qevents), undefined)
  report('older-pending-question-hidden', { olderStillOpen: true, visiblePending: pendingQuestions(qevents) ?? null })

  let receive
  const mock = { onMessage(fn) { receive = fn; return () => {} }, send() { receive({ type: 'attached', sessionId: 'big', header: { id: 'big' }, cursor: 149999, events: Array.from({ length: 150000 }, (_, seq) => ({ type: 'x', seq })) }) }, setBroadcastOnly() {}, close() {} }
  const big = new SocketSessionHandle('big', mock)
  let bigError
  try { await big.start() } catch (e) { bigError = e.message }
  assert.match(bigError, /call stack/)
  report('long-history-attach', { events: 150000, error: bigError })
} finally { await cleanup() }

async function withServer(callback, run) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-audit-wire-'))
  const path = join(directory, 'host.sock')
  const sockets = new Set()
  const send = (socket, message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n') }
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.setEncoding('utf8'); let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const at = buffer.indexOf('\n'); if (at < 0) return
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        const message = JSON.parse(line)
        if (message.type === 'hello') send(socket, { type: 'welcome', protocol: 2, pluginVersion: 'test', dshVersion: 'test', socketPath: path, capabilities: ['list', 'attach', 'prompt'], sessions: [], workspaces: [] })
        else callback(socket, message, send, sockets)
      }
    })
  })
  await new Promise(r => server.listen(path, r))
  try { return await run(path) }
  finally { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }) }
}
const runCli = (path, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../dist/bin/dshell.js', import.meta.url)), '-p', '--socket', path, '--json', '--timeout', '300', ...args], { cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x)
  child.once('error', reject); child.once('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
})
let ping = 0
await withServer((s, m, send) => {
  if (m.type === 'ping') { const n = ++ping; setTimeout(() => send(s, { type: 'pong', time: n }), n === 1 ? 70 : 140) }
}, async path => {
  const c = await HostConnection.connect(path)
  try {
    await assert.rejects(c.request({ type: 'ping' }, m => m.type === 'pong', 15))
    const reply = await c.request({ type: 'ping' }, m => m.type === 'pong', 250)
    assert.equal(reply.time, 1)
    report('late-rpc-reply', { secondRequestReceivedFirstReply: true, reply })
  } finally { c.close() }
})

for (const mode of ['cwd', 'running', 'disconnect']) {
  let createMessage
  await withServer((s, m, send, sockets) => {
    if (m.type === 'session/create') {
      createMessage = m
      send(s, { type: 'session-created', sessionId: 'created', header: { id: 'created', cwd: m.cwd ?? '/host-project' } })
    } else if (m.type === 'attach') send(s, { type: 'attached', sessionId: m.sessionId, header: { id: m.sessionId, cwd: '/host-project' }, cursor: mode === 'running' ? 0 : -1, events: mode === 'running' ? [{ type: 'turn/start', seq: 0, data: { turn: 1 } }] : [] })
    else if (m.type === 'prompt') {
      send(s, { type: 'accepted', sessionId: m.sessionId, requestId: 'new-prompt', mode: 'queue' })
      if (mode === 'disconnect') { setTimeout(() => { for (const c of sockets) c.destroy() }, 15); return }
      send(s, { type: 'event', sessionId: m.sessionId, event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: mode === 'running' ? 'ANSWER_TO_PREVIOUS_PROMPT' : 'ok' }] } } } })
      send(s, { type: 'event', sessionId: m.sessionId, event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } } })
    }
  }, async path => {
    const result = await runCli(path, [...(mode === 'cwd' ? ['--new'] : ['--session', 's1']), 'NEW_PROMPT'])
    if (mode === 'cwd') { assert.equal(createMessage.cwd, undefined); report('print-create-cwd', { clientCwd: '/tmp', sentCwd: createMessage.cwd ?? null, actualFallback: '/host-project', ...result }) }
    if (mode === 'running') { assert.equal(JSON.parse(result.stdout).text, 'ANSWER_TO_PREVIOUS_PROMPT'); report('print-wrong-turn', result) }
    if (mode === 'disconnect') { assert.equal(result.code, 4); report('print-disconnect-reported-as-timeout', result) }
  })
}
