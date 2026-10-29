import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TerminalScreen, Viewport } from '../dist/tui/screen.js'

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

test('a reader scrolled up stays on the same line while the transcript grows', () => {
  const viewport = new Viewport()
  const height = 10
  let lines = Array.from({ length: 100 }, (_, index) => `line ${String(index)}`)

  // At the tail, new lines scroll into view.
  assert.equal(viewport.visible(lines, height).start, 90)
  lines = [...lines, 'line 100']
  assert.equal(viewport.visible(lines, height).start, 91)

  // Scroll up 20 rows: the window starts at line 71.
  viewport.scroll(20, lines.length, height)
  assert.equal(viewport.visible(lines, height).start, 71)

  // A streaming turn appends rows below the window: the top line must not move.
  lines = [...lines, 'stream a', 'stream b', 'stream c']
  const view = viewport.visible(lines, height)
  assert.equal(view.start, 71)
  assert.equal(view.lines[0], 'line 71')
  assert.equal(viewport.scrollOffset, 23)

  // Dropping the live tail again keeps the window on the same line too.
  lines = lines.slice(0, 101)
  assert.equal(viewport.visible(lines, height).start, 71)

  // Jumping back to the tail resumes following the newest row.
  viewport.reset()
  assert.equal(viewport.visible(lines, height).start, 91)
})

test('a shrinking live tail keeps a reader anchored, and an over-shrink clamps', () => {
  const viewport = new Viewport()
  let lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`)
  viewport.visible(lines, 10)
  viewport.scroll(5, lines.length, 10)
  assert.equal(viewport.visible(lines, 10).start, 25)

  // The live tail below the window disappears: the same line stays on top.
  lines = lines.slice(0, 36)
  assert.equal(viewport.visible(lines, 10).start, 25)

  // Losing rows above the window too leaves nothing to anchor to: clamp.
  lines = lines.slice(0, 12)
  assert.equal(viewport.visible(lines, 10).start, 2)
})

test('a reader keeps the top line when the composer takes rows', () => {
  const viewport = new Viewport()
  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`)
  viewport.visible(lines, 10)
  viewport.scroll(5, lines.length, 10)
  assert.equal(viewport.visible(lines, 10).start, 25)

  // The composer grows by three rows: the window loses rows but not its place.
  assert.equal(viewport.visible(lines, 7).start, 25)
  // And it gives them back.
  assert.equal(viewport.visible(lines, 10).start, 25)
})
