import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTheme } from '../dist/tui/theme.js'
import { displayWidth, pad, sanitizeText, stripAnsi, truncate, wrapText } from '../dist/tui/width.js'
import { renderMarkdown, renderDiff } from '../dist/tui/markdown.js'
import { buildBlocks, pendingQuestions, renderBlocks, renderTranscript, summarizeTool, turnFailureMessage } from '../dist/tui/events.js'
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

test('pendingQuestions tracks open, timed, answered, and aborted asks', () => {
  const call = (seq) => ({
    type: 'tool/call',
    seq,
    data: {
      name: 'ask_user_question',
      callId: 'q1',
      arguments: JSON.stringify({
        questions: [
          { id: 'pkg', question: 'which name?', multi_select: false, options: [{ label: 'A', description: 'first' }, { label: 'B' }] },
          { id: 'note', question: 'anything else?', multiSelect: true },
        ],
      }),
    },
  })
  const result = (seq, payload, isError = false) => ({
    type: 'tool/result',
    seq,
    data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: payload }], isError } },
  })
  const reply = (seq) => ({
    type: 'user/message',
    seq,
    data: {
      message: {
        content: [{ type: 'text', text: '{"answers":[]}' }],
        source: { kind: 'user-question-reply', callId: 'q1', outcome: 'answered' },
      },
    },
  })

  const open = pendingQuestions([call(1)])
  assert.equal(open?.callId, 'q1')
  assert.equal(open?.questions[0]?.question, 'which name?')
  assert.equal(open?.questions[0]?.options?.[0]?.label, 'A')
  assert.equal(open?.questions[0]?.multiSelect, undefined)
  assert.equal(open?.questions[1]?.multiSelect, true)
  assert.equal(open?.questions[1]?.options, undefined)

  assert.equal(pendingQuestions([call(1), result(2, JSON.stringify({ answers: [{ id: 'pkg', selected: ['A'] }] }))]), undefined)
  assert.equal(pendingQuestions([call(1), result(2, 'Error: ask_user_question was aborted before the user answered', true)]), undefined)
  assert.equal(pendingQuestions([call(1), reply(3)]), undefined)
  // A timed wait that expired keeps the question open for a late answer.
  assert.equal(pendingQuestions([call(1), result(2, JSON.stringify({ pending: true, callId: 'q1' }))])?.callId, 'q1')

  // The folded tool row names the question instead of raw JSON.
  const lines = renderBlocks(buildBlocks([call(1)], false), 64, theme)
  assert.equal(lines.some((line) => line.includes('which name?')), true)
})

test('the model can ask questions and the TUI answers from an overlay', async () => {
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
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-500))}`)
  }

  await waitFor(() => output.text.includes('dshell'))
  backend.askQuestion('s1', 'q1', [
    { id: 'pkg', question: '包名用哪个？', header: '包名', options: [{ label: 'A', description: 'first choice' }, { label: 'B' }] },
  ])
  await waitFor(() => output.text.includes('the model asks'))
  await waitFor(() => output.text.includes('包名用哪个？'))

  // Space selects the option under the cursor (single-select radio).
  const beforeSelection = output.text.length
  input.push(' ')
  await waitFor(() => output.text.slice(beforeSelection).includes('● A'))

  // Enter submits the batch; the overlay closes and the answer is recorded.
  input.push('\r')
  await waitFor(() => output.text.includes('answers sent'))
  assert.deepEqual(backend.answeredQuestions, [
    { sessionId: 's1', callId: 'q1', answers: [{ id: 'pkg', selected: ['A'] }] },
  ])

  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('escape hides the ask overlay until that call settles', async () => {
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
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-500))}`)
  }

  await waitFor(() => output.text.includes('dshell'))
  backend.askQuestion('s1', 'q1', [{ id: 'pkg', question: 'which?', options: [{ label: 'A' }] }])
  await waitFor(() => output.text.includes('the model asks'))

  const beforeEscape = output.text.length
  input.push('\u001b')
  await waitFor(() => !output.text.slice(beforeEscape).includes('the model asks'))
  // A view change must not bring the dismissed ask back.
  const beforeRefresh = output.text.length
  backend.emit('s1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
  backend.stream('s1', 'still typing')
  await waitFor(() => output.text.slice(beforeRefresh).includes('still typing'))
  assert.equal(output.text.slice(beforeEscape).includes('the model asks'), false)

  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
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

test('composer wrap keeps typed spaces so the cursor moves after a space', () => {
  // The cursor column is the display width of the last wrapped line before
  // the cursor; a trailing space must survive the wrap (bug: cursor froze).
  assert.deepEqual(composerLines('abc ', 20), ['abc '])
  assert.deepEqual(composerLines('ab   cd', 20), ['ab   cd'])
  // Spaces beyond the width budget are clamped, never dropped silently.
  assert.deepEqual(composerLines('ab      ', 4), ['ab  '])
  const wrapped = composerLines('ab      cd', 4)
  assert.equal(wrapped.every((line) => displayWidth(line) <= 4), true)
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

test('focus reports and unknown CSI never leak into the composer as text', () => {
  const parser = new KeyParser()
  assert.deepEqual(parser.feed('\u001b[I'), [{ type: 'focus', focused: true }])
  assert.deepEqual(parser.feed('\u001b[O'), [{ type: 'focus', focused: false }])
  const split = new KeyParser()
  assert.deepEqual(split.feed('\u001b['), [])
  assert.deepEqual(split.feed('I'), [{ type: 'focus', focused: true }])
  // Anything else the terminal reports is swallowed whole, never typed.
  for (const report of ['\u001b[99X', '\u001b[?1;2c', '\u001bOq', '\u001b[>0;1;0M', '\u001b[2J']) {
    const keys = new KeyParser().feed(report)
    assert.equal(keys.every((key) => key.type !== 'text' || key.text === ''), true, report)
  }
  // A lone Escape still arrives as Escape.
  parser.feed('\u001b')
  assert.deepEqual(parser.flushEscape(), { type: 'escape' })
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
  assert.deepEqual(completionFor('/res', []).items.map((item) => item.label), ['/resume'])
  assert.deepEqual(completionFor('/mod', []).items.map((item) => item.label), ['/model'])
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

  const retrying = {
    sessionId: 's3',
    header: { id: 's3' },
    cursor: 5,
    status: 'running',
    streamText: '',
    events: [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/attempt', seq: 3, data: { turn: 1, step: 1 } },
      { type: 'llm/retry', seq: 4, data: { retry: 3, maxRetries: 5, failure: { code: 'TRANSPORT' } } },
    ],
  }
  const retryMetrics = collectMetrics(retrying, 5_000)
  assert.equal(retryMetrics.activity.phase, 'thinking')
  assert.equal(retryMetrics.activity.verb, 'Retrying')
  assert.match(retryMetrics.activity.detail ?? '', /attempt 3\/5 · TRANSPORT/)

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
  // Derive the home-scoped path from the actual HOME so the ~/ shortening
  // assertion holds on any machine and CI, not just one developer's box.
  const homeCwd = join(homedir(), 'dshell')
  const wide = renderUsageRail(theme, {
    tokens, cost: 0.42, model: 'deepseek-v4.1-flash', provider: 'deepseek-relay',
    cwd: homeCwd, git, agents: { done: 1, total: 1, running: 0 }, width: 150,
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
    cwd: homeCwd, git, agents: { done: 1, total: 1, running: 0 }, width: 60,
  })
  assert.equal(displayWidth(narrow), 60)
  assert.match(stripAnsi(narrow), /deepseek-relay\/deepseek-v4\.1-flash/)
  assert.match(stripAnsi(narrow), /cache/)

  const bare = renderUsageRail(theme, { tokens, cost: 0.42, width: 70 })
  assert.equal(displayWidth(bare), 70)
  assert.match(stripAnsi(bare), /↑12\.4k/)

  assert.equal(shortCwd(homeCwd), '~/dshell')
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
  assert.equal(empty.cursorColumn, 3)
  const multiline = renderComposer(theme, createEditor('one\ntwo\nthree'), 60, 7)
  assert.equal(multiline.height, 5)
  const long = renderComposer(theme, createEditor(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')), 60, 7)
  assert.equal(long.height, 9)
  assert.ok(long.cursorRow >= 1 && long.cursorRow <= 7)
  for (const line of long.lines) assert.equal(displayWidth(line), 60)
  const hinted = renderComposer(theme, createEditor(''), 60, 7, 'enter send · ? help')
  assert.equal(hinted.height, 4)
  assert.match(stripAnsi(hinted.lines[3]), /enter send · \? help/)
  assert.equal(displayWidth(hinted.lines[3]), 60)

  const gauged = renderComposer(theme, createEditor(''), 100, 7, undefined, { contextPct: 46.2, tps: 42 })
  assert.match(stripAnsi(gauged.lines[0]), /ctx ▰+▱* 46% · 42 tps/)
  assert.equal(displayWidth(gauged.lines[0]), 100)
  const compact = renderComposer(theme, createEditor(''), 20, 7, undefined, { contextPct: 46.2, tps: 42 })
  assert.match(stripAnsi(compact.lines[0]), /ctx 46%/)
  assert.doesNotMatch(stripAnsi(compact.lines[0]), /▰/)
  assert.equal(displayWidth(compact.lines[0]), 20)
  const bareGauge = renderComposer(theme, createEditor(''), 20, 7)
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
  assert.ok(lines.some((line) => line.trimEnd() === '> hello there'))
  // The prompt sits on a full-width band, so every row is padded to the width.
  assert.equal(lines.some((line) => line === '> hello there'), false, 'the band spans the transcript width')
  assert.equal(lines.some((line) => line.trimEnd() === '> hello there' && line.length === 60), true)
  assert.equal(lines.some((line) => line === 'you'), false)
})

test('the dshell header appears once per turn, not before every assistant block', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } } },
    { type: 'tool/call', seq: 3, data: { name: 'bash', callId: 'c1', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } } },
    { type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } } },
    { type: 'user/message', seq: 6, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] } } },
    { type: 'assistant/message', seq: 7, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'three' }] } } },
  ]
  const lines = renderBlocks(buildBlocks(events), 80, theme).map(stripAnsi).map((line) => line.trimEnd())
  assert.equal(lines.filter((line) => line === '🐳 dshell').length, 2, 'one header per turn')
  // The second turn's header sits right before its first answer, not the tools.
  const headerIndex = lines.lastIndexOf('🐳 dshell')
  assert.equal(lines[headerIndex + 1], 'three')
})

test('Ctrl+Enter is newline under the kitty keyboard protocol', async () => {
  const { KeyParser } = await import('../dist/tui/keys.js')
  const parser = new KeyParser()
  const parse = (chunk) => parser.feed(chunk)
  assert.deepEqual(parse('\u001b[13;5u'), [{ type: 'newline' }])
  assert.deepEqual(parse('\u001b[13;2u'), [{ type: 'newline' }])
  assert.deepEqual(parse('\u001b[13u'), [{ type: 'enter' }])
  assert.deepEqual(parse('\u001b[27u'), [{ type: 'escape' }])
  assert.deepEqual(parse('\u001b[99;5u'), [{ type: 'ctrl-c' }])
  assert.deepEqual(parse('\u001b[9;2u'), [{ type: 'shift-tab' }])
  assert.deepEqual(parse('\u001b[113;3u'), [{ type: 'alt-q' }])
  assert.deepEqual(parse('\u001b[127;5u'), [{ type: 'ctrl-w' }])
  assert.deepEqual(parse('\u001b[27;5;13~'), [{ type: 'newline' }])
  // Unmodified text still arrives as text.
  assert.deepEqual(parse('ok'), [{ type: 'text', text: 'o' }, { type: 'text', text: 'k' }])
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

test('wheel scrolls and Alt+arrows select blocks while plain arrows recall history', async () => {
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

  // Alt+Up walks a selection instead of scrolling: the notice line names the
  // focused block, Enter opens it, Esc clears it.
  at = output.text.length
  input.push('\u001b[1;3A')
  await waitFor(() => stripAnsi(output.text.slice(at)).includes('▸'))
  assert.match(stripAnsi(output.text.slice(at)), /enter open · esc clear/)
  input.push('\u001b')
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

test('TUI model picker switches the session model and saves a default', async () => {
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
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 150; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }

  await waitFor(() => output.text.includes('idle'))
  input.push('/model')
  input.push('\r')
  await waitFor(() => output.text.includes('Fake Provider') && output.text.includes('Relay Flash'))
  // Default is fake/fake-flash; move past fake-pro to relay/relay-flash.
  input.push('\u001b[B')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\u001b[B')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\r')
  // Relay Flash declares reasoning levels, so the model pick steps into the
  // level list first; the second enter commits model + level together.
  await waitFor(() => output.text.includes('reasoning level') && output.text.includes('Low'))
  input.push('\r')
  await waitFor(() => output.text.includes('model → relay/relay-flash · low'))

  input.push('/model')
  input.push('\r')
  await new Promise((resolve) => setTimeout(resolve, 100))
  input.push('d')
  await waitFor(() => output.text.includes('default model → relay/relay-flash · low'))
  input.push('\u001b')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI effort picker shows levels and remembers the choice in the rail', async () => {
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
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }

  await waitFor(() => output.text.includes('idle'))
  input.push('/model')
  input.push('\r')
  await waitFor(() => output.text.includes('Relay Flash'))
  // Walk from the fake default down to Relay Flash, then step into its levels.
  input.push('\u001b[B')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\u001b[B')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\r')
  await waitFor(() => output.text.includes('reasoning level'))
  assert.equal(output.text.includes('Reserve for the hardest quality-first tasks.') || output.text.includes('low'), true)
  input.push('\r')
  await waitFor(() => output.text.includes('model → relay/relay-flash · low'))
  // The rail keeps showing the chosen level after the picker closes.
  assert.match(output.text.slice(-4000), /relay\/relay-flash · low/)

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('a rejected model switch surfaces the Host error instead of hanging', async () => {
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
  backend.selectModel = async () => {
    throw new Error('provider "x" model "y" does not support reasoning effort "off"')
  }
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }
  const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

  await waitFor(() => output.text.includes('idle'))
  input.push('/model')
  input.push('\r')
  await waitFor(() => output.text.includes('Relay Flash'))
  input.push('\u001b[B')
  await pause()
  input.push('\u001b[B')
  await pause()
  input.push('\r')
  await waitFor(() => output.text.includes('reasoning level'))
  input.push('\r')
  await waitFor(() => output.text.includes('model switch failed'))
  assert.equal(output.text.includes('does not support reasoning effort'), true)

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
})

test('TUI level picker also accepts Shift+Enter and 1-9', async () => {
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
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }
  const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

  await waitFor(() => output.text.includes('idle'))
  input.push('/model')
  input.push('\r')
  await waitFor(() => output.text.includes('Relay Flash'))
  input.push('\u001b[B')
  await pause()
  input.push('\u001b[B')
  await pause()
  // LF stands in for a terminal that sends \n on Enter / Shift+Enter.
  input.push('\n')
  await waitFor(() => output.text.includes('reasoning level'))
  // '3' commits the third level without arrowing there first.
  input.push('3')
  await waitFor(() => output.text.includes('model → relay/relay-flash'))

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
})

test('TUI provider screen edits a field and asks before restarting the Host', async () => {
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
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }

  await waitFor(() => output.text.includes('idle'))
  input.push('/provider')
  input.push('\r')
  await waitFor(() => output.text.includes('/fake/cordis.patch.yml'))
  assert.equal(output.text.includes('FAKE_API_KEY'), true)
  assert.equal(output.text.includes('api.example/v1'), true)

  // Relay is the second row; open its editor and replace baseURL.
  input.push('\u001b[B')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\r')
  await waitFor(() => output.text.includes('provider · relay'))
  input.push('\r')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('\u0015')
  input.push('http://new.example:9000')
  input.push('\r')
  await new Promise((resolve) => setTimeout(resolve, 20))
  input.push('s')
  await waitFor(() => output.text.includes('Restart it now to load this change?'))
  assert.equal(output.text.includes('restart now'), true)

  // Decline: the Host keeps running and the draft survives on disk.
  input.push('n')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await backend.providerList()).providers.find((row) => row.id === 'relay').baseURL, 'http://new.example:9000')

  // Say yes next time and the fake Host re-exec is requested.
  input.push('/provider')
  input.push('\r')
  await waitFor(() => output.text.includes('/fake/cordis.patch.yml'))
  input.push('r')
  await waitFor(() => output.text.includes('restart host'))
  input.push('y')
  await waitFor(() => output.text.includes('host restarting'))

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('TUI adds and removes providers like the Web UI models page', async () => {
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
    rows = 34
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for TUI output; got ${JSON.stringify(output.text.slice(-700))}`)
  }
  const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  await waitFor(() => output.text.includes('idle'))
  // Let the first attach settle before typing, otherwise startup keys swallow
  // the command (the same reason a real user sees the composer first).
  await pause(80)
  input.push('/provider')
  input.push('\r')
  await waitFor(() => output.text.includes('/fake/cordis.patch.yml'))

  // Add: id, then baseURL, then the model list.
  input.push('a')
  await waitFor(() => output.text.includes('add provider'))
  input.push('\r')
  input.push('test-relay')
  input.push('\r')
  await pause()
  input.push('\u001b[B')
  input.push('\u001b[B')
  await pause()
  input.push('\r')
  input.push('\u0015')
  input.push('https://t.example/v1')
  input.push('\r')
  await pause()
  input.push('\u001b[B')
  input.push('\u001b[B')
  await pause()
  input.push('\r')
  input.push('\u0015')
  input.push('m1, m2')
  input.push('\r')
  await pause()
  input.push('s')
  await waitFor(() => output.text.includes('Restart it now to load this provider?'))
  input.push('n')
  await pause()
  const added = (await backend.providerList()).providers.find((row) => row.id === 'test-relay')
  assert.deepEqual(added, { id: 'test-relay', baseURL: 'https://t.example/v1', models: 2 })

  // Remove: last row, confirm, then decline the restart.
  input.push('/provider')
  input.push('\r')
  await waitFor(() => output.text.includes('test-relay'))
  input.push('\u001b[B')
  input.push('\u001b[B')
  await pause()
  input.push('x')
  await waitFor(() => output.text.includes('Remove it?'))
  input.push('y')
  await waitFor(() => output.text.includes('Restart it now to drop it?'))
  input.push('n')
  await pause()
  assert.equal((await backend.providerList()).providers.some((row) => row.id === 'test-relay'), false)

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  await backend.disconnect()
})

test('a dropped Host connection reattaches instead of failing every command', async () => {
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
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(output.text.slice(-900))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  backend.simulateDisconnect()
  await waitFor(() => output.text.includes('host connection lost'), 'the reconnect toast')
  await waitFor(() => output.text.includes('host back · reattached'), 'the reattach toast')
  // The catalogue works again without the user running /reconnect.
  input.push('/model')
  input.push('\r')
  await waitFor(() => output.text.includes('Relay Flash'), 'the model picker after reconnect')

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
})

test('enter steers into the running turn and alt+q queues behind it', async () => {
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
  const app = runTui(backend, { cwd: '/work', color: false, resume: 's1', input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(output.text.slice(-900))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  backend.emit('s1', { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await waitFor(() => output.text.includes('running'), 'the running status')

  // Enter joins the running turn instead of waiting for it to finish.
  output.text = ''
  input.push('go faster')
  input.push('\r')
  await waitFor(() => output.text.includes('◷ steering'), 'the steering marker')
  assert.equal(output.text.includes('go faster'), true)

  output.text = ''
  assert.equal(backend.deliverSteer('s1'), true)
  await waitFor(() => output.text.includes('go faster'), 'the steered prompt in the transcript')
  assert.equal(output.text.includes('◷ steering'), false)

  // Alt+Q asks the Host to hold the prompt for the next turn (Alt+Enter is
  // reserved by some terminals for fullscreen, so it is only an alias).
  output.text = ''
  input.push('after this')
  input.push('\u001bq')
  await waitFor(() => output.text.includes('◷ queued'), 'the queued marker')
  assert.equal(backend.queuedPrompts.some((entry) => entry.text === 'after this' && entry.mode === 'queue'), true)

  // Ctrl-C aborts the running turn but hands the queued prompt back, so it
  // starts instead of disappearing with the aborted turn.
  output.text = ''
  input.push('\u0003')
  await waitFor(
    () => output.text.includes('after this') && !output.text.includes('◷ queued'),
    'the queued prompt restarted after cancel',
  )
  assert.equal(output.text.includes('cancelled this turn'), true)

  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
})

test('alt+arrows walk blocks and enter opens tools and subagents', async () => {
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

  const events = [
    { type: 'user/message', seq: 1, data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'list the files' }] } } },
    { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1', arguments: '{"command":"ls","description":"List files"}' } },
    { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt\nb.txt' }] } } },
    { type: 'subagent/catalog', seq: 4, data: { childId: 'agent-1234567890', label: 'scanner' } },
    { type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
  ]
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events }])
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-600))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  try {
  // Alt+Down starts at the first block; each press moves one block down.
  output.text = ''
  input.push('\u001b[1;3B')
  await waitFor(() => stripAnsi(output.text).includes('enter open'), 'the focus hint')
  assert.match(stripAnsi(output.text), /▸ 1\//)
  assert.match(stripAnsi(output.text), /you · list the files/)

  // Enter on the tool block opens its details.
  output.text = ''
  input.push('\u001b[1;3B')
  input.push('\r')
  await waitFor(() => stripAnsi(output.text).includes('pgup/pgdn'), 'the tool detail panel')
  assert.match(stripAnsi(output.text), /List files · ls/)
  assert.match(stripAnsi(output.text), /a\.txt/)
  output.text = ''
  input.push('\u001b')
  await waitFor(() => !stripAnsi(output.text).includes('pgup/pgdn'), 'the detail panel to close')

  // Enter on the subagent row opens the /agents list.
  output.text = ''
  input.push('\u001b[1;3B')
  input.push('\r')
  await waitFor(() => /subagents? in this session/.test(stripAnsi(output.text)), 'the agents panel')

  input.push('\u001b')
  input.push('\u001b')
  input.push('\u0003')
  input.push('\u0004')
  assert.equal(await app, 0)
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('a queued prompt can be edited or deleted from the block cursor', async () => {
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
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-700))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  try {
    backend.emit('s1', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    await waitFor(() => output.text.includes('running'), 'the running status')

    output.text = ''
    input.push('draft this')
    input.push('\u001b\r')
    await waitFor(() => stripAnsi(output.text).includes('◷ queued'), 'the queued marker')

    // Alt+Up lands on the queued row (it is the last item).
    output.text = ''
    input.push('\u001b[1;3A')
    await waitFor(() => stripAnsi(output.text).includes('▸') && stripAnsi(output.text).includes('queued'), 'the queue focus hint')

    // Enter pulls it back into the composer and out of the queue line.
    output.text = ''
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('editing a queued prompt'), 'the edit toast')
    assert.equal(stripAnsi(output.text).includes('◷ queued'), false)

    // Esc puts it back untouched.
    output.text = ''
    input.push('\u001b')
    await waitFor(() => stripAnsi(output.text).includes('◷ queued · draft this'), 'the restored queue row')

    // Enter again, append a word, Enter saves in place.
    output.text = ''
    input.push('\u001b[1;3A')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('editing a queued prompt'), 'the second edit')
    input.push(' please')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('queued prompt updated'), 'the edit receipt')
    await waitFor(() => stripAnsi(output.text).includes('◷ queued · draft this please'), 'the edited queue row')

    // Alt+Backspace deletes it from the queue.
    output.text = ''
    input.push('\u001b[1;3A')
    input.push('\u001b\u007f')
    await waitFor(() => stripAnsi(output.text).includes('queued prompt deleted'), 'the delete toast')
    assert.equal(stripAnsi(output.text).includes('◷ queued'), false)
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('the session picker shows the last edit time and orders by it', async () => {
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

  const now = Date.now()
  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([
    { sessionId: 'old', cwd: '/work', title: 'created long ago', createdAt: now - 5 * 86_400_000, updatedAt: now - 30 * 60_000 },
    { sessionId: 'new', cwd: '/work', title: 'touched now', createdAt: now - 3 * 60_000, updatedAt: now - 5_000 },
  ])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', input, output, color: false })
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-600))}`)
  }

  try {
    await waitFor(() => stripAnsi(output.text).includes('touched now'), 'the session list')
    const text = stripAnsi(output.text)
    // The picker shows activity ("just now"), not the creation time ("3m ago").
    assert.match(text, /just now/)
    assert.match(text, /30m ago/)
    assert.equal(text.includes('5d ago'), false)
    assert.equal(
      text.indexOf('touched now') < text.indexOf('created long ago'),
      true,
      'the most recently edited session is first',
    )
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('tool calls are folded to one line until ctrl+o or the detail panel asks', async () => {
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

  const events = [
    { type: 'user/message', seq: 1, data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'list' }] } } },
    { type: 'tool/call', seq: 2, data: { name: 'bash', callId: 'c1', arguments: '{"command":"ls","description":"List files"}' } },
    { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'alpha.txt\nbeta.txt' }] } } },
    { type: 'tool/call', seq: 4, data: { name: 'bash', callId: 'c2', arguments: '{"command":"false","description":"Fail on purpose"}' } },
    { type: 'tool/result', seq: 5, data: { message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom: exit 1' }] } } },
    { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
  ]
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events }])
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-700))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  try {
    const text = stripAnsi(output.text)
    assert.match(text, /✓ Bash\(ls\)/)
    assert.equal(text.includes('alpha.txt'), false, 'successful output stays folded')
    // A failure keeps a two-line excerpt so the reason is visible.
    assert.match(text, /✗ Bash\(false\)/)
    assert.match(text, /boom: exit 1/)

    // Ctrl-O expands the output inline.
    output.text = ''
    input.push('\u000f')
    await waitFor(() => stripAnsi(output.text).includes('alpha.txt'), 'the expanded output')
    assert.match(stripAnsi(output.text), /tool output expanded/)

    input.push('\u000f')
    await new Promise((resolve) => setTimeout(resolve, 80))
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('attaching mid-turn reports running, so Enter steers instead of queueing', async () => {
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

  // A turn already started (and is still open) when this client attaches.
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier' }] } } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } } },
  ]
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events }])
  await backend.connect()
  backend.emit('s1', { type: 'turn/start', seq: 4, data: { turn: 1 } })
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-500))}`)
  }

  try {
    await waitFor(() => stripAnsi(output.text).includes('working'), 'the transcript')
    assert.match(stripAnsi(output.text), /running/)
    output.text = ''
    input.push('keep going')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('◷ steering'), 'steering into the shared turn')
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('prompts queued by another client are visible and editable', async () => {
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

  // The transcript knows a turn is running and the inbox holds a prompt that
  // this client never sent: another terminal (or the Web UI) queued it.
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier prompt' }] } } },
    { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, inserted: [{ id: 'other-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'queued elsewhere' }] }] } },
  ]
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events }])
  backend.queuePrompt('s1', 'other-1', 'queued elsewhere', 'queue')
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-700))}`)
  }

  try {
    await waitFor(() => stripAnsi(output.text).includes('◷ queued · queued elsewhere'), 'the foreign queue row')

    // Enter on the row edits it through the shared inbox.
    output.text = ''
    input.push('\u001b[1;3A')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('editing a queued prompt'), 'the edit toast')
    input.push(' edited')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('◷ queued · queued elsewhere edited'), 'the edited row')

    // Alt+Backspace removes it for everyone.
    output.text = ''
    input.push('\u001b[1;3A')
    input.push('\u001b\u007f')
    await waitFor(() => stripAnsi(output.text).includes('queued prompt deleted'), 'the delete toast')
    assert.equal(stripAnsi(output.text).includes('◷ queued'), false)
  } finally {
    input.push('\u0003')
    input.push('\u0004')
    await Promise.race([app, new Promise((resolve) => setTimeout(resolve, 1500))])
  }
})

test('enter opens the focused block even after scrolling up', async () => {
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
    rows = 20
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  // Enough blocks that the transcript cannot fit in 20 rows.
  const events = []
  let seq = 0
  for (let turn = 0; turn < 8; turn += 1) {
    events.push({ type: 'user/message', seq: seq++, data: { message: { id: `u${String(turn)}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `request ${String(turn)}` }] } } })
    events.push({ type: 'tool/call', seq: seq++, data: { name: 'bash', callId: `c${String(turn)}`, arguments: JSON.stringify({ command: `echo ${String(turn)}`, description: `Step ${String(turn)}` }) } })
    events.push({ type: 'tool/result', seq: seq++, data: { message: { toolCallId: `c${String(turn)}`, isError: false, content: [{ type: 'text', text: `output ${String(turn)}` }] } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { message: { role: 'assistant', content: [{ type: 'text', text: `done ${String(turn)}` }] } } })
  }
  events.push({ type: 'turn/end', seq: seq, data: { reason: { kind: 'completed' } } })

  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', title: 't', events }])
  await backend.connect()
  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-600))}`)
  }

  await waitFor(() => output.text.includes('idle'), 'the first attach')
  try {
    // Scroll up (wheel), then focus the last block: Enter must open it rather
    // than silently jumping back to the live tail.
    for (let index = 0; index < 10; index += 1) input.push('\u001b[<64;10;5M')
    await waitFor(() => stripAnsi(output.text).includes('Jump to bottom'), 'the scroll pill')
    output.text = ''
    input.push('\u001b[1;3A')
    input.push('\u001b[1;3A')
    await waitFor(() => stripAnsi(output.text).includes('tool · bash'), 'the focus hint')
    output.text = ''
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('pgup/pgdn'), 'the tool detail panel')
    output.text = ''
    input.push('\u001b')
    await waitFor(() => !stripAnsi(output.text).includes('pgup/pgdn'), 'the detail panel to close')
  } finally {
    input.push('\u0004')
    await app
  }
})

test('git polling survives the activity tick stopping (DS-008)', async (t) => {
  const { EventEmitter } = await import('node:events')
  const { execFileSync } = await import('node:child_process')
  const { runTui } = await import('../dist/tui/app.js')
  const { FakeBackend } = await import('../dist/backend/index.js')

  const repo = await mkdtemp(join(tmpdir(), 'dshell-git-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
  })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])

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
  const backend = new FakeBackend([{ sessionId: 's1', cwd: repo }])
  await backend.connect()
  const app = runTui(backend, { cwd: repo, resume: 's1', color: false, input, output })
  const waitFor = async (predicate) => {
    for (let index = 0; index < 300; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out; tail=${JSON.stringify(output.text.slice(-300))}`)
  }

  try {
  // The boot refresh shows the initial branch.
  await waitFor(() => output.text.includes('main'))

  // Change the branch, then run one running→idle tick cycle: the buggy
  // stop branch killed the Git interval here, freezing the footer.
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature-x'])
  backend.emit('s1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
  await waitFor(() => output.text.includes('running'))
  backend.emit('s1', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  await waitFor(() => !output.text.slice(output.text.length - 4000).includes('running') || output.text.includes('idle'))

  // The 4s poll must still fire and pick the new branch up.
  await waitFor(() => output.text.includes('feature-x'))
  assert.equal(output.text.includes('feature-x'), true)
  } finally {
    input.push('\u0004')
    await app
    await backend.disconnect()
  }
})

test('a finished turn reports how long it ran and when', () => {
  const start = new Date(2026, 9, 29, 11, 18, 0).getTime()
  const events = [
    { type: 'user/message', seq: 1, time: start - 1200, data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'turn/start', seq: 2, time: start, data: { turn: 1 } },
    { type: 'assistant/message', seq: 3, time: start + 4000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 4, time: start + 76_000, data: { reason: { kind: 'completed' } } },
  ]
  const lines = renderTranscript(events, 80, theme)
  const footer = lines.find((line) => stripAnsi(line).includes('Worked for'))
  assert.ok(footer !== undefined, 'expected a turn footer')
  assert.match(stripAnsi(footer), /✻ Worked for 1m 16s · done 11:19/)

  // A cancelled turn says so instead of claiming work.
  const cancelled = renderTranscript(
    [
      { type: 'turn/start', seq: 1, time: start, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: start + 5000, data: { reason: { kind: 'cancelled' } } },
    ],
    80,
    theme,
  )
  assert.match(stripAnsi(cancelled.join('\n')), /✻ Stopped after 5s · done 11:18/)
})

test('turn footers are not focusable blocks', async () => {
  const { buildBlocks: blocks } = await import('../dist/tui/events.js')
  const events = [
    { type: 'turn/start', seq: 1, time: 1_790_000_000_000, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 1_790_000_060_000, data: { reason: { kind: 'completed' } } },
  ]
  const kinds = blocks(events).map((block) => block.kind)
  assert.deepEqual(kinds, ['turnend'])
})

test('TUI smoke: /skills lists the catalog and opens a skill', async () => {
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
    columns = 110
    rows = 32
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }])
  await backend.connect()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-600))}`)
  }

  await waitFor(() => stripAnsi(output.text).includes('idle'), 'the session to attach')
  try {
    input.push('/skills')
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('release-checklist'), 'the skill list')
    assert.ok(stripAnsi(output.text).includes('triage-issues'), 'lists every source')
    assert.ok(stripAnsi(output.text).includes('/fake/dshell-skills'), 'shows the hub root')

    output.text = ''
    input.push('\r')
    await waitFor(() => stripAnsi(output.text).includes('Release checklist'), 'the skill body')

    output.text = ''
    input.push('\u001b')
    await waitFor(() => !stripAnsi(output.text).includes('skill · release-checklist'), 'the skill panel to close')
  } finally {
    input.push('\u0004')
    await app
    await backend.disconnect()
  }
})

test('session picker only labels a resident agent, never "cold"', async () => {
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
    columns = 110
    rows = 30
    text = ''
    write(chunk) { this.text += chunk; return true }
  }

  const input = new FakeInput()
  const output = new FakeOutput()
  const backend = new FakeBackend([
    { sessionId: 's1', cwd: '/work', title: 'Busy session' },
    { sessionId: 's2', cwd: '/work', title: 'Dormant session' },
  ])
  await backend.connect()
  backend.markLive('s1')
  const app = runTui(backend, { cwd: '/work', color: false, input, output })

  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(stripAnsi(output.text).slice(-500))}`)
  }

  try {
    await waitFor(() => stripAnsi(output.text).includes('Dormant session'), 'the picker rows')
    const picker = stripAnsi(output.text)
    assert.ok(picker.includes('● live'), 'a resident agent is labelled live')
    assert.ok(!picker.includes('cold'), 'an unloaded session is not called cold')
  } finally {
    input.push('\u0004')
    await app
    await backend.disconnect()
  }
})
