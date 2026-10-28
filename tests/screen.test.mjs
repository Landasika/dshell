import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TerminalScreen } from '../dist/tui/screen.js'

function fakeStreams() {
  const writes = []
  const input = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    on() {},
    off() {},
    setEncoding() {},
  }
  const output = {
    isTTY: true,
    columns: 40,
    rows: 6,
    on() {},
    off() {},
    write(chunk) {
      writes.push(chunk)
      return true
    },
  }
  return { input, output, writes }
}

test('draw only rewrites the rows that changed', () => {
  const { input, output, writes } = fakeStreams()
  const screen = new TerminalScreen(input, output)
  screen.start()
  screen.draw(['header', 'body', 'footer'])
  const first = writes.join('')
  assert.match(first, /header/)
  assert.match(first, /footer/)

  writes.length = 0
  screen.draw(['header', 'body', 'footer'])
  const idle = writes.join('')
  // Nothing changed, so only the cursor visibility escape is sent.
  assert.equal(idle.includes('header'), false)
  assert.equal(idle.length < 16, true)

  writes.length = 0
  screen.draw(['header', 'body changed', 'footer'])
  const delta = writes.join('')
  assert.match(delta, /body changed/)
  assert.equal(delta.includes('header'), false)
  assert.equal(delta.includes('footer'), false)
})

test('a resize repaints every row once', () => {
  const { input, output, writes } = fakeStreams()
  const screen = new TerminalScreen(input, output)
  screen.start()
  screen.draw(['header', 'body'])
  output.rows = 8
  writes.length = 0
  screen.draw(['header', 'body'])
  const repaint = writes.join('')
  assert.match(repaint, /header/)
  assert.match(repaint, /body/)
})
