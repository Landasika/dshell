// Headless runTui rendering probe; not a real terminal screenshot.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { FakeBackend } from '../../../dist/backend/fake.js'
import { runTui } from '../../../dist/tui/app.js'
import { TerminalScreen } from '../../../dist/tui/screen.js'
import { stripAnsi } from '../../../dist/tui/width.js'
const pause = ms => new Promise(r => setTimeout(r, ms))
class Input extends EventEmitter { isTTY = true; setRawMode() {}; setEncoding() {}; resume() {}; pause() {}; push(text) { this.emit('data', text) } }
class Output extends EventEmitter { isTTY = true; columns = 80; rows = 24; write() { return true } }
let last
const draw = TerminalScreen.prototype.draw
TerminalScreen.prototype.draw = function(lines, cursor) { last = { lines: lines.map(stripAnsi), cursor }; return draw.call(this, lines, cursor) }
async function session(run, rows = 24) {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }]); await backend.connect()
  const input = new Input(), output = new Output(); output.rows = rows
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  await pause(100)
  try { await run({ backend, input, output }) }
  finally { input.emit('end'); await app; await backend.disconnect() }
}
await session(async ({ backend, input }) => {
  backend.askQuestion('s1', 'bigq', [{ id: 'q', question: '这是需要完整阅读的问题内容。'.repeat(28), options: Array.from({ length: 8 }, (_, i) => ({ label: `CHOICE_${i + 1}` })) }])
  await pause(100)
  await writeFile(new URL('./ui-80x24.txt', import.meta.url), last.lines.join('\n'))
  console.log(JSON.stringify({ id: 'long-question-80x24', visibleRows: last.lines.length, visibleChoices: last.lines.filter(line => line.includes('CHOICE_')), submitVisible: last.lines.some(line => line.includes('Submit')) }))
})
await session(async ({ input }) => {
  input.push('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight')
  await pause(100)
  console.log(JSON.stringify({ id: 'composer-80x12', visibleRows: last.lines.length, cursor: last.cursor, cursorVisible: last.cursor.row <= 12, visible: last.lines }))
}, 12)

const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work' }]); await backend.connect()
const originalList = backend.listSessions.bind(backend)
let version = 0
backend.listSessions = async () => {
  const rows = await originalList()
  return rows.map(row => ({ ...row, title: version === 0 ? 'ORIGINAL_TITLE' : 'CHANGED_TITLE' }))
}
const input = new Input(), output = new Output()
const app = runTui(backend, { cwd: '/work', color: false, input, output })
await pause(100)
assert(last.lines.some(line => line.includes('ORIGINAL_TITLE')))
version = 1
input.push('\u001b[I')
await pause(100)
console.log(JSON.stringify({ id: 'startup-focus-refresh', staleTitle: last.lines.some(line => line.includes('ORIGINAL_TITLE')), refreshedTitleVisible: last.lines.some(line => line.includes('CHANGED_TITLE')) }))
input.emit('end'); await app; await backend.disconnect()
TerminalScreen.prototype.draw = draw
