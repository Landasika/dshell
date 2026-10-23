import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTheme } from '../dist/tui/theme.js'
import { displayWidth, pad, sanitizeText, stripAnsi, truncate, wrapText } from '../dist/tui/width.js'
import { renderMarkdown, renderDiff } from '../dist/tui/markdown.js'
import { buildBlocks, renderBlocks, renderTranscript, summarizeTool } from '../dist/tui/events.js'
import { composerLines, createEditor, editKey, insertText, lineCol } from '../dist/tui/editor.js'
import { KeyParser } from '../dist/tui/keys.js'
import { fileCandidates } from '../dist/tui/app.js'

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
  assert.deepEqual(parser.feed('\u001b[200~hello\nworld\u001b[201~'), [{ type: 'paste', text: 'hello\nworld' }])
  assert.deepEqual(parser.feed('\u0003'), [{ type: 'ctrl-c' }])
  assert.deepEqual(parser.feed('中'), [{ type: 'text', text: '中' }])
  const split = new KeyParser()
  assert.deepEqual(split.feed('\u001b['), [])
  assert.deepEqual(split.feed('B'), [{ type: 'down' }])
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
    throw new Error('timed out waiting for TUI output')
  }

  await waitFor(() => output.text.includes('dshell'))
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
  const app = runTui(backend, { cwd: '/work', color: false, input, output })
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
