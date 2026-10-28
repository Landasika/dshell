import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizePaste, pastePlaceholder, shouldFoldPaste } = await import('../dist/tui/paste.js')

test('normalizePaste strips trailing whitespace from every pasted line', () => {
  assert.equal(normalizePaste('ab   \ncd\t\r\n\r\n'), 'ab\ncd\n\n')
  assert.equal(normalizePaste('no trailing blanks'), 'no trailing blanks')
})

test('pastes fold only past the line or size threshold', () => {
  assert.equal(shouldFoldPaste('short text'), false)
  assert.equal(shouldFoldPaste('a\nb\nc'), false)
  assert.equal(shouldFoldPaste(['x', 'x', 'x', 'x', 'x'].join('\n')), true)
  assert.equal(shouldFoldPaste('x'.repeat(200)), false)
  assert.equal(shouldFoldPaste('x'.repeat(201)), true)
})

test('placeholders describe the folded size', () => {
  assert.equal(pastePlaceholder('a\nb\nc', 2), '[Pasted text #2 +3 lines]')
  assert.equal(pastePlaceholder('x'.repeat(300), 1), '[Pasted text #1 +300 chars]')
})
