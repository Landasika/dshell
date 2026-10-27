import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTheme } from '../dist/tui/theme.js'
import { displayWidth, pad, sanitizeText, stripAnsi, truncate, wrapText } from '../dist/tui/width.js'
import { renderMarkdown, renderDiff } from '../dist/tui/markdown.js'
import { buildBlocks, renderBlocks, renderTranscript, summarizeTool, turnFailureMessage } from '../dist/tui/events.js'
import { composerLines, createEditor, editKey, insertText, lineCol } from '../dist/tui/editor.js'
import { KeyParser } from '../dist/tui/keys.js'
import { fileCandidates, latestSessionTitle } from '../dist/tui/app.js'
import { readGitInfo } from '../dist/tui/git.js'
import { completionContext, completionFor } from '../dist/tui/completion.js'

const theme = createTheme(false)

test('display width handles ANSI, CJK, and truncation without leaking escapes', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('中文'), 4)
  assert.equal(displayWidth('\u001b[31mred\u001b[0m'), 3)
  const clipped = truncate('\u001b[31mabcdef\u001b[0m', 4)
  assert.equal(displayWidth(clipped), 4)
  assert.match(clipped, /\u001b\[31m/)
  assert.match(clipped, /\u001b\[0m/)
  assert.equal(stripAnsi('\u001b[1mhi\u001b[0m'), 'hi')
  assert.equal(pad('中', 4).length, 3) // one UTF-16 unit + two spaces
  assert.equal(sanitizeText('a\u0000b\r\nc'), 'ab\nc')
})

test('wrapText hard-breaks long tokens and keeps CJK within the width', () => {
  const lines = wrapText('one two three four', 8)
  assert.deepEqual(lines, ['one two', 'three', 'four'])
  const long = wrapText('x'.repeat(20), 6)
  assert.equal(long.join('').length, 20)
  assert.equal(long.every((line) => displayWidth(line) <= 6), true)
  const cjk = wrapText('中文中文中文', 5)
  assert.equal(cjk.every((line) => displayWidth(line) <= 5), true)
})

test('markdown renderer handles headings, bullets, fences, and diffs', () => {
  const lines = renderMarkdown('# Title\n\n- one\n- two\n\n```ts\nconst x = 1\n```', 40, theme)
  assert.equal(lines.some((line) => line.includes('Title')), true)
  assert.equal(lines.some((line) => line.includes('• one')), true)
  assert.equal(lines.some((line) => line.includes('const x = 1')), true)

  const diff = renderDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new', 40, theme)
  assert.equal(diff.length, 6)
  assert.equal(diff.some((line) => line.includes('-old')), true)
  assert.equal(diff.some((line) => line.includes('+new')), true)
})

test('durable events become stable blocks and pair tool results by callId', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1', arguments: '{"command":"echo hi","description":"Echo"}' } },
    { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'todo/write', seq: 4, data: { todos: [{ content: 'write tests', status: 'completed' }] } },
    { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } },
  ]
  const blocks = buildBlocks(events, true)
  assert.equal(blocks[0].kind, 'user')
  assert.equal(blocks[1].kind, 'tool')
  assert.equal(blocks[1].failed, false)
  assert.equal(blocks[1].detail, 'hi')
  assert.equal(blocks[2].kind, 'todo')
  const rendered = renderBlocks(blocks, 50, theme)
  assert.equal(rendered.some((line) => line.includes('hello')), true)
  assert.equal(rendered.some((line) => line.includes('write tests')), true)

  // Re-rendering the same history is deterministic (a reconnect does not duplicate).
  assert.deepEqual(renderTranscript(events, 50, theme, true), rendered)
})

test('tool output is truncated and summarizeTool uses common arguments', () => {
  const blocks = buildBlocks([
    { type: 'tool/call', seq: 1, data: { name: 'bash', callId: 'c', arguments: '{"command":"seq 1 100"}' } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'c', content: [{ type: 'text', text: 'x\n'.repeat(100) }] } } },
  ])
  const lines = renderBlocks(blocks, 40, theme, { maxToolLines: 3 })
  assert.equal(lines.length <= 8, true)
  assert.match(summarizeTool('bash', '{"command":"echo hi","description":"Echo"}'), /Echo/)
})

test('editor supports unicode boundaries, history, and multiline composers', () => {
  let editor = createEditor('😀a')
  editor = { ...editor, cursor: 0 }
  const right = editKey(editor, 'right')
  assert.equal(right.state.cursor, 2)
  const inserted = insertText(right.state, 'X')
  assert.equal(inserted.text, '😀Xa')

  const history = ['first', 'second']
  const up = editKey(createEditor('draft'), 'up', history, -1)
  assert.equal(up.state.text, 'second')
  assert.equal(up.historyIndex, 0)
  const upAgain = editKey(up.state, 'up', history, up.historyIndex)
  assert.equal(upAgain.state.text, 'first')
  const down = editKey(upAgain.state, 'down', history, upAgain.historyIndex)
  assert.equal(down.state.text, 'second')

  const lines = composerLines('one two three', 6)
  assert.equal(lines.every((line) => displayWidth(line) <= 6), true)
  assert.deepEqual(lineCol('ab\ncd', 5), { line: 1, column: 2 })
})

test('key parser handles arrows, control keys, and bracketed paste across chunks', () => {
  const parser = new KeyParser()
  assert.deepEqual(parser.feed('\u001b[A'), [{ type: 'up' }])
  assert.deepEqual(parser.feed('\u001bOB'), [{ type: 'down' }])
  assert.deepEqual(parser.feed('\u001bOA'), [{ type: 'up' }])
  assert.deepEqual(parser.feed('\u001b[200~hello\nworld\u001b[201~'), [{ type: 'paste', text: 'hello\nworld' }])
  assert.deepEqual(parser.feed('\u0003'), [{ type: 'ctrl-c' }])
  assert.deepEqual(parser.feed('\u0010'), [{ type: 'ctrl-p' }])
  assert.deepEqual(parser.feed('\u000e'), [{ type: 'ctrl-n' }])
  assert.deepEqual(parser.feed('中'), [{ type: 'text', text: '中' }])
  const split = new KeyParser()
  assert.deepEqual(split.feed('\u001b['), [])
  assert.deepEqual(split.feed('B'), [{ type: 'down' }])
})

test('completion finds slash commands and @ files', () => {
  assert.equal(completionContext('/')?.kind, 'command')
  assert.equal(completionContext('/se')?.query, 'se')
  assert.equal(completionContext('/attach '), null)
  assert.deepEqual(
    completionFor('/', []).items.map((item) => item.label).slice(0, 3),
    ['/help', '/sessions', '/workspaces'],
  )
  const sessions = completionFor('/se', []).items
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].label, '/sessions')
  const file = completionContext('look at @src/ma')
  assert.deepEqual(file, { kind: 'file', query: 'src/ma', start: 8, end: 15 })
  assert.equal(completionFor('look at @src/ma', ['src/main.ts']).items[0].label, '@src/main.ts')
})

test('session titles come from the latest session/title event', () => {
  assert.equal(
    latestSessionTitle([
      { type: 'session/title', seq: 1, data: { title: 'Old title' } },
      { type: 'turn/end', seq: 2, data: {} },
      { type: 'session/title', seq: 3, data: { title: 'New title' } },
    ]),
    'New title',
  )
  assert.equal(latestSessionTitle([{ type: 'turn/end', seq: 1, data: {} }]), undefined)
})

test('file completion is bounded and skips hidden/ignored directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-tui-'))
  try {
    await writeFile(join(directory, 'alpha.txt'), 'a')
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'src', 'beta.ts'), 'b')
    await mkdir(join(directory, '.git'))
    await writeFile(join(directory, '.git', 'secret'), 's')
    const candidates = fileCandidates(directory, '')
    assert.equal(candidates.includes('alpha.txt'), true)
    assert.equal(candidates.includes('src/beta.ts'), true)
    assert.equal(candidates.some((candidate) => candidate.includes('.git')), false)
    assert.equal(fileCandidates(directory, 'src/').includes('src/beta.ts'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('TUI smoke: starts, renders a turn, and quits without a PTY', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    encoding = 'utf8'
    raw = false
    setRawMode(value) { this.raw = value }
    setEncoding(value) { this.encoding = value }
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', color: false, input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-500))}`)
  }

  await waitFor(() => output.text.includes('dshell'))
  await waitFor(() => output.text.includes('choose session'))
  // The picker paints while the Host is still listing; wait for the loaded row.
  await waitFor(() => output.text.includes('untitled session'))
  input.push('\r')
  await waitFor(() => output.text.includes('idle'))
  input.push('hello')
  input.push('\r')
  await waitFor(() => output.text.includes('echo: hello'))
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI smoke: renders and answers an approval overlay', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for TUI approval output')
  }

  await waitFor(() => output.text.includes('dshell'))
  backend.askApproval('s1', { requestId: 'a1', sessionId: 's1', toolName: 'bash', reason: 'test' })
  await waitFor(() => output.text.includes('approval required'))
  input.push('a')
  await waitFor(() => output.text.includes('allowed once'))
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI startup asks before creating a missing workspace', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend()
  await backend.connect()
  const app = runTui(backend, { cwd: '/brand-new', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-500))}`)
  }

  await waitFor(() => output.text.includes('workspace not created'))
  input.push('c')
  await waitFor(() => output.text.includes('created fake-1'))
  input.push('')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI startup supports arrow selection and Enter attach', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([
    { sessionId: 's1', cwd: '/work', title: 'First session', createdAt: 2 },
    { sessionId: 's2', cwd: '/work', title: 'Second session', createdAt: 1 },
  ])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for selection output; got ${JSON.stringify(output.text.slice(-800))}`)
  }

  await waitFor(() => output.text.includes('choose session'))
  await waitFor(() => output.text.includes('First session'))
  assert.equal(output.text.includes('First session'), true)
  assert.equal(output.text.includes('Second session'), true)
  input.push('\u001b[B') // down: s1 -> s2 (CSI mode)
  input.push('\r')
  await waitFor(() => output.text.includes('idle'))
  input.push('select me')
  input.push('\r')
  await waitFor(() => output.text.includes('echo: select me'))
  assert.equal(backend.requireSession('s2').events.some((event) => event.type === 'user/message'), true)
  assert.equal(backend.requireSession('s1').events.some((event) => event.type === 'user/message'), false)
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI slash completion menu filters and executes a command', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', title: 'Demo session' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for slash menu; got ${JSON.stringify(output.text.slice(-800))}`)
  }

  await waitFor(() => output.text.includes('dshell'))
  input.push('/')
  await waitFor(() => output.text.includes('commands') && output.text.includes('/help'))
  input.push('q')
  await waitFor(() => output.text.includes('/quit'))
  input.push('\r')
  assert.equal(await app, 0)
  await backend.disconnect()
})

// ---------------------------------------------------------------------------
// New TUI design layer: metrics, context bar, activity, brand art, chrome.
// ---------------------------------------------------------------------------

import {
  collectAgents,
  collectMetrics,
  estimateTokens,
  formatDuration,
  formatTokens,
  nextSpeedSample,
  normalizeUsage,
  todoCounts,
} from '../dist/tui/metrics.js'
import { allocateColumns, contextBarLayout, renderContextBar } from '../dist/tui/contextbar.js'
import { renderActivityLine, renderTodoStrip, renderTpsGauge, renderUsageRail, shortCwd } from '../dist/tui/activity.js'
import { renderSplash } from '../dist/tui/splash.js'
import { renderComposer, renderJumpToBottom } from '../dist/tui/chrome.js'
import { renderStatusStrip } from '../dist/tui/activity.js'
import { streamChunkParts } from '../dist/backend/stream.js'
import { estimateSessionCost, formatCostCny, isPeakHour, parseUsage, priceForModel } from '../dist/tui/cost.js'

const metricsEvents = [
  { type: 'request/context', seq: 1, time: 1_700_000_000_000 - 21_000, data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64_000 } },
  { type: 'user/message', seq: 2, time: 1_700_000_000_000 - 20_000, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Refactor the socket client and add retries' }] } } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1_700_000_000_000 - 15_000,
    data: {
      usage: { inputTokens: 12_400, outputTokens: 840, cacheReadTokens: 3_000, totalTokens: 16_240 },
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Inspect the retry path.' }, { type: 'text', text: 'I will split the reconnect logic into a helper.' }] },
    },
  },
  { type: 'tool/call', seq: 4, time: 1_700_000_000_000 - 14_000, data: { name: 'bash', callId: 'c1', arguments: '{"command":"rg reconnect src"}' } },
  { type: 'tool/result', seq: 5, time: 1_700_000_000_000 - 13_000, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'src/client/socket-client.ts:120' }] } } },
  { type: 'todo/write', seq: 6, data: { todos: [{ content: 'Inspect reconnect path', status: 'completed' }, { content: 'Add bounded backoff', status: 'in_progress', activeForm: 'Adding bounded backoff' }, { content: 'Add tests', status: 'pending' }] } },
  { type: 'turn/start', seq: 7, time: 1_700_000_000_000 - 21_000 },
  { type: 'turn/end', seq: 8, time: 1_700_000_000_000 - 12_000, data: { reason: { kind: 'completed' } } },
]

test('metrics project usage, context composition, todos, timing, and activity', () => {
  const view = { sessionId: 's1', header: { id: 's1' }, events: metricsEvents, cursor: 8, status: 'idle', streamText: '' }
  const metrics = collectMetrics(view, 1_700_000_000_000)
  assert.equal(metrics.model, 'deepseek-chat')
  assert.equal(metrics.provider, 'deepseek')
  assert.equal(metrics.contextWindow, 64_000)
  assert.equal(metrics.usedTokens, 16_240)
  assert.equal(metrics.lastUsage.input, 12_400)
  assert.equal(metrics.lastUsage.output, 840)
  assert.equal(metrics.lastUsage.cacheRead, 3_000)
  assert.equal(metrics.lastUsage.total, 16_240)
  assert.equal(metrics.outputTokens, 840)
  assert.equal(metrics.lastTurnMs, 9_000)
  assert.equal(metrics.todos.length, 3)
  assert.equal(metrics.todos[1].activeForm, 'Adding bounded backoff')
  assert.equal(metrics.activity.phase, 'done')
  assert.deepEqual(todoCounts(metrics.todos), { total: 3, completed: 1, active: metrics.todos[1] })
  const segmentTotal = Object.values(metrics.segments).reduce((sum, value) => sum + value, 0)
  assert.equal(segmentTotal, 16_240)
  assert.ok(Math.abs(metrics.contextPct - 25.375) < 0.01)
})

test('metrics handle running tool calls, live streams, and normalized usage keys', () => {
  const running = {
    sessionId: 's2',
    header: { id: 's2' },
    cursor: 3,
    status: 'running',
    streamText: 'partial answer',
    events: [
      { type: 'turn/start', seq: 1, time: 1_000 },
      { type: 'tool/call', seq: 2, data: { name: 'read', callId: 'x', arguments: '{"file_path":"a.ts"}' } },
    ],
  }
  const metrics = collectMetrics(running, 5_000)
  assert.equal(metrics.activity.phase, 'tool')
  assert.equal(metrics.activity.toolName, 'read')
  assert.match(metrics.activity.verb, /Reading/)
  assert.match(metrics.activity.detail, /a\.ts/)
  assert.ok(metrics.liveTokens > 0)
  assert.equal(metrics.turnStartedAt, 1_000)

  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 })
  assert.equal(normalizeUsage({}), undefined)
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('中文中文') >= 2)
})

test('formatting and TPS sampling are compact and bounded', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(16_240), '16.2k')
  assert.equal(formatTokens(1_200_000), '1.2M')
  assert.equal(formatDuration(9_000), '9s')
  assert.equal(formatDuration(64_000), '1m 04s')
  const first = nextSpeedSample([], undefined, 1_000, 10)
  assert.deepEqual(first.samples, [])
  assert.deepEqual(first.previous, { at: 1_000, tokens: 10 })
  const second = nextSpeedSample(first.samples, first.previous, 2_000, 60)
  assert.equal(second.samples.length, 1)
  assert.equal(second.samples[0].tps, 50)
  const reset = nextSpeedSample(second.samples, second.previous, 3_000, 5)
  assert.deepEqual(reset.samples, second.samples)
  assert.deepEqual(reset.previous, { at: 3_000, tokens: 5 })
})

test('context bar allocation always fills the requested width', () => {
  const allocated = allocateColumns([3, 0, 5, 2, 1], 20)
  assert.equal(allocated.reduce((sum, value) => sum + value, 0), 20)
  assert.equal(allocated[1], 0)
  assert.ok(allocated.filter((value) => value > 0).length >= 4)

  const segments = { system: 100, prompt: 200, assistant: 300, thinking: 150, tools: 250 }
  const layout = contextBarLayout(segments, 5_000, 10_000, 40)
  assert.equal(layout.free, 20)
  assert.equal(layout.used.reduce((sum, value) => sum + value, 0) + layout.unclassified, 20)
  for (const themeValue of [createTheme(false), createTheme(true)]) {
    const line = renderContextBar(themeValue, segments, 5_000, 10_000, 50)
    assert.equal(displayWidth(line), 50)
    assert.match(stripAnsi(line), /5k\/10k 50%/)
  }
})

test('activity line, TPS gauge, and todo strip stay on one row', () => {
  const line = renderActivityLine(theme, { phase: 'tool', verb: 'Running command', detail: 'rg reconnect src' }, { now: 0, elapsedMs: 12_000, contextPct: 84, width: 90 })
  assert.match(stripAnsi(line), /Running command/)
  assert.match(stripAnsi(line), /12s/)
  assert.match(stripAnsi(line), /ctx 84%/)
  assert.equal(displayWidth(renderTpsGauge(theme, 42, 100)), 10)
  const todos = [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
    { content: 'three', status: 'pending' },
  ]
  const strip = renderTodoStrip(theme, todos, { width: 60, now: 0, folded: false })
  assert.match(stripAnsi(strip), /1\/3/)
  assert.match(stripAnsi(strip), /Doing two/)
  assert.equal(displayWidth(strip) <= 60, true)
})

test('session cost folds durable usage, peak/idle rates, and unpriced models', () => {
  assert.equal(isPeakHour(Date.UTC(2026, 9, 27, 2, 0)), true)
  assert.equal(isPeakHour(Date.UTC(2026, 9, 27, 4, 0)), false)
  assert.equal(isPeakHour(Date.UTC(2026, 9, 24, 2, 0)), false)
  assert.ok(priceForModel('deepseek-v4.1-flash'))
  assert.equal(priceForModel('unknown-model'), undefined)
  assert.deepEqual(parseUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }), { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, total: 18 })
  assert.equal(formatCostCny(0.0042), '¥0.0042')
  assert.equal(formatCostCny(1.2), '¥1.20')

  const peak = Date.UTC(2026, 9, 27, 2, 0)
  const idle = Date.UTC(2026, 9, 27, 5, 0)
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, totalTokens: 3_000_000 }
  const events = [
    { type: 'request/context', seq: 1, time: peak, data: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    { type: 'assistant/message', seq: 2, time: peak, data: { usage } },
    { type: 'assistant/message', seq: 3, time: idle, data: { usage } },
  ]
  const cost = estimateSessionCost(events)
  assert.equal(cost.tokens.input, 2_000_000)
  assert.equal(cost.tokens.cacheRead, 2_000_000)
  assert.equal(cost.tokens.output, 2_000_000)
  assert.equal(cost.tokens.total, 6_000_000)
  assert.equal(cost.pricedTokens, 6_000_000)
  assert.equal(cost.unpricedTokens, 0)
  assert.ok(Math.abs((cost.cost ?? 0) - 15.06) < 1e-9)
  assert.ok(Math.abs(cost.peak - 10.04) < 1e-9)
  assert.ok(Math.abs(cost.idle - 5.02) < 1e-9)

  const unpriced = estimateSessionCost([{ type: 'assistant/message', seq: 1, time: idle, data: { usage } }])
  assert.equal(unpriced.cost, undefined)
  assert.equal(unpriced.unpricedTokens, 3_000_000)

  // A replayed snapshot repeats the same settlement; count it once.
  const replayed = estimateSessionCost([
    { type: 'request/context', seq: 1, time: idle, data: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    { type: 'assistant/message', seq: 2, time: idle, data: { turn: 3, step: 1, usage } },
    { type: 'assistant/message', seq: 2, time: idle, data: { turn: 3, step: 1, usage } },
  ])
  assert.equal(replayed.tokens.total, 3_000_000)
  assert.equal(replayed.pricedTokens, 3_000_000)
})

test('usage rail carries model route, cwd, git, agents and cache', () => {
  const tokens = { input: 12_400, cacheRead: 3_000, cacheWrite: 0, output: 840 }
  const git = { branch: 'main', ahead: 10, behind: 0, dirty: false }
  const wide = renderUsageRail(theme, {
    tokens, cost: 0.42, model: 'deepseek-v4.1-flash', provider: 'deepseek-relay',
    cwd: '/home/landasika/dshell', git, agents: { done: 1, total: 1, running: 0 }, width: 150,
  })
  assert.equal(displayWidth(wide), 150)
  const text = stripAnsi(wide)
  assert.match(text, /deepseek-relay\/deepseek-v4\.1-flash/)
  assert.match(text, /~\/dshell/)
  assert.match(text, /main \[↑10\]/)
  assert.match(text, /✓ agents 1\/1/)
  assert.match(text, /cache ▰+▱* 19%/)
  assert.match(text, /↑12\.4k ↓840/)
  assert.match(text, /~¥0\.42/)
  assert.doesNotMatch(text, /ctx|tps/)

  const narrow = renderUsageRail(theme, {
    tokens, model: 'deepseek-v4.1-flash', provider: 'deepseek-relay',
    cwd: '/home/landasika/dshell', git, agents: { done: 1, total: 1, running: 0 }, width: 60,
  })
  assert.equal(displayWidth(narrow), 60)
  assert.match(stripAnsi(narrow), /deepseek-relay\/deepseek-v4\.1-flash/)
  assert.match(stripAnsi(narrow), /cache/)

  const bare = renderUsageRail(theme, { tokens, cost: 0.42, width: 70 })
  assert.equal(displayWidth(bare), 70)
  assert.match(stripAnsi(bare), /↑12\.4k/)

  assert.equal(shortCwd(`${process.env.HOME}/dshell`), '~/dshell')
  assert.ok(displayWidth(shortCwd('/a/very/long/path/that/keeps/going/dshell', 16)) <= 16)
})

test('git breadcrumb reads branch and dirtiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-git-'))
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    await writeFile(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['-C', dir, 'add', '.'])
    execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const clean = await readGitInfo(dir)
    assert.equal(clean?.branch, 'main')
    assert.equal(clean?.dirty, false)
    await writeFile(join(dir, 'a.txt'), 'two\n')
    const dirty = await readGitInfo(dir)
    assert.equal(dirty?.dirty, true)
    assert.equal(await readGitInfo(join(dir, 'missing')), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('splash is a list-only picker at every terminal size', () => {
  const sessions = [
    { label: 'Socket client hardening', live: true, cwd: '/work', age: '2m ago' },
    { label: 'Release checklist', live: false, cwd: '/work', age: '1h ago' },
  ]
  const wide = renderSplash(theme, { columns: 100, rows: 30, now: 0, cwd: '/work', kind: 'sessions', workspaceTitle: 'work', workspacePath: '/work', sessions, index: 0 })
  const wideText = stripAnsi(wide.join('\n'))
  assert.equal(wide.length, 30)
  assert.match(wideText, /choose session/)
  assert.match(wideText, /dshell/)
  assert.match(wideText, /Socket client hardening/)
  // List-only launch: no pixel art or block wordmark above the picker.
  assert.doesNotMatch(wideText, /[▀▄]/)
  assert.doesNotMatch(wideText, /████/)

  const narrow = renderSplash(theme, { columns: 80, rows: 24, now: 0, cwd: '/work', kind: 'sessions', sessions, index: 0 })
  const narrowText = stripAnsi(narrow.join('\n'))
  assert.equal(narrow.length, 24)
  assert.match(narrowText, /choose session/)
  assert.match(narrowText, /dshell/)
})

test('composer frame grows with content and keeps the caret inside', () => {
  const empty = renderComposer(theme, createEditor(''), 60, 7)
  assert.equal(empty.height, 3)
  assert.equal(empty.cursorRow, 1)
  assert.equal(empty.cursorColumn, 5)
  const multiline = renderComposer(theme, createEditor('one\ntwo\nthree'), 60, 7)
  assert.equal(multiline.height, 5)
  const long = renderComposer(theme, createEditor(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')), 60, 7)
  assert.equal(long.height, 9)
  assert.ok(long.cursorRow >= 1 && long.cursorRow <= 7)
  for (const line of long.lines) assert.equal(displayWidth(line), 60)
  const hinted = renderComposer(theme, createEditor(''), 60, 7, 'enter send · ? help')
  assert.equal(hinted.height, 3)
  assert.match(stripAnsi(hinted.lines[2]), /enter send · \? help/)
  assert.equal(displayWidth(hinted.lines[2]), 60)

  const gauged = renderComposer(theme, createEditor(''), 100, 7, undefined, { contextPct: 46.2, tps: 42 })
  assert.match(stripAnsi(gauged.lines[0]), /ctx ▰+▱* 46% · 42 tps/)
  assert.equal(displayWidth(gauged.lines[0]), 100)
  const compact = renderComposer(theme, createEditor(''), 30, 7, undefined, { contextPct: 46.2, tps: 42 })
  assert.match(stripAnsi(compact.lines[0]), /ctx 46%/)
  assert.doesNotMatch(stripAnsi(compact.lines[0]), /tps|▰/)
  assert.equal(displayWidth(compact.lines[0]), 30)
  const bareGauge = renderComposer(theme, createEditor(''), 20, 7, undefined, { contextPct: 46.2, tps: 42 })
  assert.doesNotMatch(stripAnsi(bareGauge.lines[0]), /ctx|tps/)
  for (const line of bareGauge.lines) assert.equal(displayWidth(line), 20)
  const speedOnly = renderComposer(theme, createEditor(''), 40, 7, undefined, { tps: 42 })
  assert.match(stripAnsi(speedOnly.lines[0]), /42 tps/)
})

test('TUI exposes history search, double-Esc rewind, and the session panel', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 32
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', title: 'Design session' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI state; got ${JSON.stringify(output.text.slice(-800))}`)
  }

  await waitFor(() => output.text.includes('idle'))
  assert.equal(output.text.includes('Ready · last turn'), false)
  input.push('first prompt')
  input.push('\r')
  await waitFor(() => output.text.includes('echo: first prompt'))

  // Grow the transcript past one viewport so there is something to scroll.
  for (let index = 0; index < 6; index += 1) {
    input.push(`filler ${index}`)
    input.push('\r')
    await waitFor(() => output.text.includes(`echo: filler ${index}`))
  }

  // Wheel scrolls the transcript and surfaces the jump-to-bottom pill; End
  // returns to the live tail without touching the composer.
  for (let index = 0; index < 5; index += 1) input.push('\u001b[<64;10;5M')
  await waitFor(() => output.text.includes('Jump to bottom'))
  const scrolledAt = output.text.length
  input.push('\u001b[F')
  await waitFor(() => output.text.length > scrolledAt && !output.text.slice(scrolledAt).includes('Jump to bottom'))
  assert.equal(output.text.includes('first prompt'), true)

  // Ctrl+R: filter the sent prompts, then restore the match into the composer.
  input.push('\u0012')
  await waitFor(() => output.text.includes('history search'))
  input.push('first')
  input.push('\r')
  await waitFor(() => !output.text.slice(-1200).includes('history search'))
  const firstPrompts = backend.requireSession('s1').events.filter((event) => event.type === 'user/message' && JSON.stringify(event).includes('first prompt'))
  assert.equal(firstPrompts.length, 1)

  // Ctrl+C clears the restored draft; double-Esc opens rewind on the empty idle composer.
  input.push('\u0003')
  input.push('\u001b')
  await new Promise((resolve) => setTimeout(resolve, 45))
  input.push('\u001b')
  await waitFor(() => output.text.includes('rewind'))
  input.push('\r')
  await waitFor(() => !output.text.slice(-1200).includes('rewind'))

  // Ctrl+B opens the session panel with the usage ledger, context and todos.
  input.push('\u0002')
  await waitFor(() => output.text.includes('session panel') && output.text.includes('context'))
  assert.ok(output.text.includes('session usage'))
  assert.ok(output.text.includes('cache read') || output.text.includes('unpriced'))
  input.push('\u001b')
  await waitFor(() => output.text.includes('idle'))

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('wheel and click sequences parse without leaking into the composer', () => {
  const parser = new KeyParser()
  assert.deepEqual(parser.feed('\u001b[<64;10;5M'), [{ type: 'wheel', delta: -1 }])
  assert.deepEqual(parser.feed('\u001b[<65;10;5M'), [{ type: 'wheel', delta: 1 }])
  assert.deepEqual(parser.feed('\u001b[<0;7;12M'), [{ type: 'click', row: 12, column: 7 }])
  // Releases carry coordinates for selection; other buttons are swallowed.
  assert.deepEqual(parser.feed('\u001b[<0;7;12m'), [{ type: 'release', row: 12, column: 7 }])
  assert.deepEqual(parser.feed('\u001b[<66;1;1M'), [{ type: 'text', text: '' }])
  assert.deepEqual(parser.feed('\u001b[<32;8;6M'), [{ type: 'drag', row: 6, column: 8 }])
  assert.deepEqual(parser.feed('\u001b[<0;8;6m'), [{ type: 'release', row: 6, column: 8 }])
  assert.deepEqual(parser.feed('\u001b[1;3A'), [{ type: 'alt-up' }])
  assert.deepEqual(parser.feed('\u001b[1;3B'), [{ type: 'alt-down' }])
})

test('assistant stream splits reasoning deltas from visible text', () => {
  const reasoning = streamChunkParts({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'think' } })
  assert.deepEqual(reasoning, { text: '', reasoning: 'think' })
  const text = streamChunkParts({ type: 'chunk', chunk: { type: 'text-delta', text: 'hello' } })
  assert.deepEqual(text, { text: 'hello', reasoning: '' })
  assert.deepEqual(streamChunkParts({ type: 'start' }), { text: '', reasoning: '' })
})

test('thinking folds to one header per turn and expands under verbose', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'first line\nsecond line' }, { type: 'text', text: 'one' }] } } },
    { type: 'tool/call', seq: 3, data: { name: 'bash', callId: 'c1', arguments: '{}' } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'third line' }, { type: 'text', text: 'two' }] } } },
  ]
  const blocks = buildBlocks(events)
  const reasoning = blocks.filter((block) => block.kind === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.equal(reasoning[0].steps, 2)
  assert.match(reasoning[0].full, /first line[\s\S]*third line/)

  const folded = renderBlocks(blocks, 60, theme).map(stripAnsi)
  const header = folded.find((line) => line.includes('thinking'))
  assert.ok(header)
  assert.match(header, /2 steps/)
  assert.match(header, /ctrl\+o expand/)
  assert.equal(folded.some((line) => line.includes('first line')), false)
  assert.equal(folded.some((line) => line.includes('third line')), false)

  const full = renderBlocks(buildBlocks(events, true), 60, theme).map(stripAnsi)
  assert.ok(full.some((line) => line.includes('first line')))
  assert.ok(full.some((line) => line.includes('third line')))
  assert.ok(full.some((line) => line.includes('ctrl+o fold')))
})

test('user prompts render as quoted > lines, not a you label', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  ]
  const lines = renderBlocks(buildBlocks(events), 60, theme).map(stripAnsi)
  assert.ok(lines.includes('> hello there'))
  assert.equal(lines.some((line) => line === 'you'), false)
})

test('a failed turn is always visible in the transcript', () => {
  const failed = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', error: { message: 'Insufficient Balance (request_id: abc)', code: 'QUOTA', status: 402 } } } },
  ]
  const lines = renderBlocks(buildBlocks(failed), 80, theme).map(stripAnsi)
  const error = lines.find((line) => line.includes('turn failed'))
  assert.ok(error)
  assert.match(error, /Insufficient Balance/)
  assert.ok(renderBlocks(buildBlocks(failed, true), 80, theme).some((line) => stripAnsi(line).includes('Insufficient Balance')))
  assert.equal(turnFailureMessage(failed), 'Insufficient Balance (request_id: abc)')

  const completed = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(renderBlocks(buildBlocks(completed), 80, theme).some((line) => stripAnsi(line).includes('turn failed')), false)
  assert.equal(turnFailureMessage(completed), undefined)
})

test('subagent roster follows catalog and settlement events', () => {
  const child = '18b9d1cc-8488-44de-a495-3cc8babff2d5'
  const events = [
    { type: 'subagent/catalog', seq: 1, time: 1_000, data: { childId: child, childCreatedAt: 900, mode: 'continuable', label: 'OctoPrint harness' } },
    { type: 'agent/inbox/spliced', seq: 2, data: { inserted: [{ content: [{ type: 'text', text: 'Background subagent finished.' }], source: { kind: 'subagent-settled', senderSessionId: child } }] } },
  ]
  const agents = collectAgents(events)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].label, 'OctoPrint harness')
  assert.equal(agents[0].status, 'done')
  assert.equal(agents[0].startedAt, 900)

  const metrics = collectMetrics({ sessionId: 's', header: { id: 's' }, events, cursor: 2, status: 'idle', streamText: '', streamReasoning: '' })
  assert.equal(metrics.agents.length, 1)
  const failed = collectAgents([
    events[0],
    { type: 'agent/inbox/spliced', seq: 2, data: { inserted: [{ content: [{ type: 'text', text: 'subagent failed before it finished' }], source: { kind: 'subagent-settled', senderSessionId: child } }] } },
  ])
  assert.equal(failed[0].status, 'failed')
})

test('jump-to-bottom pill fits the row and switches label with unread output', () => {
  const idle = renderJumpToBottom(theme, 0, 40)
  assert.equal(displayWidth(idle), 40)
  assert.match(stripAnsi(idle), /Jump to bottom/)
  const unread = renderJumpToBottom(theme, 12, 40)
  assert.equal(displayWidth(unread), 40)
  assert.match(stripAnsi(unread), /12 new/)
  assert.match(stripAnsi(unread), /End/)
})

test('footer status strip folds agents, jobs and todo progress', () => {
  const allDone = renderStatusStrip(theme, {
    agentsDone: 1, agentsTotal: 1, agentsRunning: 0,
    jobsRunning: 0, jobsFailed: 0, jobsTotal: 0,
    todosDone: 0, todosTotal: 6, width: 80,
  })
  assert.equal(stripAnsi(allDone), '✓ agents 1/1  ● todo 0/6')
  const running = renderStatusStrip(theme, {
    agentsDone: 1, agentsTotal: 2, agentsRunning: 1,
    jobsRunning: 1, jobsFailed: 0, jobsTotal: 2,
    todosDone: 1, todosTotal: 6, width: 80,
  })
  assert.equal(stripAnsi(running), '● agents 1/2  ● jobs 1  ● todo 1/6')
  const failed = renderStatusStrip(theme, {
    agentsDone: 0, agentsTotal: 0, agentsRunning: 0,
    jobsRunning: 0, jobsFailed: 1, jobsTotal: 1,
    todosDone: 0, todosTotal: 0, width: 80,
  })
  assert.equal(stripAnsi(failed), '✗ jobs 0 · ✗ 1')
  assert.equal(renderStatusStrip(theme, {
    agentsDone: 0, agentsTotal: 0, agentsRunning: 0,
    jobsRunning: 0, jobsFailed: 0, jobsTotal: 0,
    todosDone: 0, todosTotal: 0, width: 80,
  }), '')
  assert.ok(displayWidth(renderStatusStrip(theme, {
    agentsDone: 1, agentsTotal: 2, agentsRunning: 1,
    jobsRunning: 3, jobsFailed: 0, jobsTotal: 3,
    todosDone: 4, todosTotal: 9, width: 18,
  })) <= 18)
})

test('job events fold into running and failed counts', () => {
  const events = [
    { type: 'job/registered', seq: 1, data: { jobId: 'a', kind: 'bash' } },
    { type: 'job/registered', seq: 2, data: { jobId: 'b', kind: 'bash' } },
    { type: 'job/settled', seq: 3, data: { jobId: 'b', status: 'failed' } },
    { type: 'job/settled', seq: 4, data: { jobId: 'b', status: 'failed' } },
  ]
  const metrics = collectMetrics({ sessionId: 's', header: { id: 's' }, events, cursor: 4, status: 'running', streamText: '', streamReasoning: '' })
  assert.deepEqual(metrics.jobs, { running: 1, total: 2, failed: 1 })
})

test('TUI opens on the picker with real titles instead of flashing the chat shell', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 90
    rows = 26
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/w', title: 'Design session' }])
  await backend.connect()
  const list = backend.listSessions.bind(backend)
  backend.listSessions = async (workspaceId) => {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return list(workspaceId)
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/w', color: false, input, output })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const early = stripAnsi(output.text)
  assert.match(early, /choose session/)
  assert.match(early, /reading sessions|waiting for the Host/)
  assert.equal(early.includes('prompt'), false)

  for (let index = 0; index < 100; index += 1) {
    if (stripAnsi(output.text).includes('Design session')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const loaded = stripAnsi(output.text)
  assert.match(loaded, /Design session/)
  input.push('q')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('wheel and Alt+arrows scroll the transcript while plain arrows recall history', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 32
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const events = []
  for (let index = 0; index < 30; index += 1) {
    events.push({ type: 'user/message', seq: index * 2 + 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `prompt number ${index}` }] } } })
    events.push({ type: 'assistant/message', seq: index * 2 + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `answer number ${index}` }] } } })
  }
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', title: 'Long session', events }])
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for arrow scroll')
  }

  await waitFor(() => output.text.includes('idle'))

  // History is seeded from the durable transcript, so Up recalls a prompt sent
  // before this TUI attached.
  input.push('\u001b[A')
  await waitFor(() => stripAnsi(output.text.slice(-1200)).includes('❯ prompt number 29'))
  input.push('\u001b')
  await new Promise((resolve) => setTimeout(resolve, 60))

  // The wheel scrolls the transcript; End returns to the tail.
  input.push('\u001b[<64;10;10M')
  await waitFor(() => output.text.slice(-2000).includes('Jump to bottom'))
  let at = output.text.length
  input.push('\u001b[F')
  await waitFor(() => output.text.length > at && !output.text.slice(at).includes('Jump to bottom'))

  // Alt+Up scrolls as well.
  at = output.text.length
  input.push('\u001b[1;3A')
  await waitFor(() => output.text.slice(at).includes('Jump to bottom'))
  input.push('\u001b[F')
  await new Promise((resolve) => setTimeout(resolve, 40))

  // A prompt sent in this run is recalled too.
  input.push('recall-me')
  input.push('\r')
  await waitFor(() => output.text.includes('echo: recall-me'))
  input.push('\u001b[A')
  await waitFor(() => stripAnsi(output.text.slice(-1200)).includes('❯ recall-me'))
  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('drag selects text and copies it through OSC 52', async () => {
  const { EventEmitter } = await import('node:events')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  class FakeInput extends EventEmitter {
    isTTY = true
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    push(chunk) { this.emit('data', chunk) }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true
    columns = 100
    rows = 24
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const backend = new FakeBackend([{
    sessionId: 's1',
    cwd: '/work',
    events: [
      { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'HELLO-TARGET' }] } } },
      { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } } },
    ],
  }])
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for selection')
  }

  await waitFor(() => output.text.includes('HELLO-TARGET'))
  input.push('\u001b[<0;1;3M')
  input.push('\u001b[<32;20;3M')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(output.text, /\u001b\[7m/)
  input.push('\u001b[<0;20;3m')
  await waitFor(() => output.text.includes('copied'))
  const match = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(output.text)
  assert.ok(match)
  assert.match(Buffer.from(match[1], 'base64').toString('utf8'), /HELLO-TARGET/)
  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})
