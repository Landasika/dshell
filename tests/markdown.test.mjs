import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../dist/tui/markdown.js')
const { displayWidth } = await import('../dist/tui/width.js')

const theme = { enabled: false, reset: '' }

test('markdown tables render as a box-drawn grid with aligned columns', () => {
  const source = [
    '| name | value |',
    '| :--- | ----: |',
    '| alpha | 1 |',
    '| beta | 22 |',
  ].join('\n')
  const lines = renderMarkdown(source, 40, theme)
  assert.equal(lines[0]?.startsWith('┌'), true)
  assert.equal(lines.at(-1)?.startsWith('└'), true)
  // Every row has the same display width, so the borders line up.
  const widths = new Set(lines.map((line) => displayWidth(line)))
  assert.equal(widths.size, 1, `ragged table: ${JSON.stringify(lines)}`)
  // Every row is separated: one rule under the header, one between the two
  // body rows.
  assert.equal(lines.filter((line) => line.startsWith('├')).length, 2)
  // The header separator sits between the header and the body.
  const separator = lines.findIndex((line) => line.startsWith('├'))
  assert.equal(lines[separator - 1]?.includes('name'), true)
  assert.equal(lines[separator + 1]?.includes('alpha'), true)
  // Right-aligned numbers are padded on the left, not the right.
  const one = lines.find((line) => line.includes('alpha')) ?? ''
  const two = lines.find((line) => line.includes('beta')) ?? ''
  assert.match(one, /│ +1 │$/)
  assert.match(two, /│ +22 │$/)
})

test('a wide table shrinks and wraps cells to fit the terminal', () => {
  const source = [
    '| 名称 | 说明 |',
    '| --- | --- |',
    '| alpha | 一个很长的说明文字，用来测试自动换行是否生效 |',
  ].join('\n')
  const lines = renderMarkdown(source, 30, theme)
  for (const line of lines) {
    assert.equal(displayWidth(line) <= 30, true, `line too wide: ${JSON.stringify(line)}`)
  }
  // The long cell wraps onto continuation rows instead of being cut off.
  assert.equal(lines.filter((line) => line.startsWith('│')).length >= 4, true)
  assert.equal(lines.join('').includes('自动换行'), true)
})

test('inline markers and escaped pipes stay inside their cells', () => {
  const lines = renderMarkdown([
    '| key | note |',
    '| --- | --- |',
    '| **bold** | a \\| b |',
  ].join('\n'), 40, theme)
  const row = lines.find((line) => line.includes('bold'))
  assert.match(row, /bold/)
  assert.equal(row.includes('**'), false)
  assert.equal(lines.find((line) => line.includes('a | b')) !== undefined, true)
})

test('code fences print verbatim with no label row or gutter', () => {
  const lines = renderMarkdown(['```bash', '# comment', 'echo hi', '```'].join('\n'), 40, theme)
  assert.deepEqual(lines, ['# comment', 'echo hi'])
})

test('pipes inside code fences are not treated as tables', () => {
  const lines = renderMarkdown(['```', '| not | a | table |', '| --- | --- | --- |', '```'].join('\n'), 40, theme)
  assert.equal(lines.some((line) => line.startsWith('┌')), false)
  assert.equal(lines.some((line) => line.includes('| not | a | table |')), true)
})

test('a pipe row without a separator stays plain text', () => {
  const lines = renderMarkdown('a | b | c', 40, theme)
  assert.equal(lines.some((line) => line.startsWith('┌')), false)
  assert.equal(lines.join('\n').includes('a | b | c'), true)
})
