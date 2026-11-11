import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTheme } from '../dist/tui/theme.js'
import { stripAnsi } from '../dist/tui/width.js'
import { renderMarkdown, renderMarkdownStream } from '../dist/tui/markdown.js'
import {
  buildBlocks,
  foldBlocks,
  createBlockRenderCache,
  renderBlocksWithRanges,
} from '../dist/tui/events.js'
import {
  estimateSegments,
  foldSegments,
  MetricsProjector,
} from '../dist/tui/metrics.js'

const theme = createTheme(false)

const cjk = (n) => {
  const unit = '这是一段用于增量渲染测试的中文文本，混排少量 english tokens 与标点。'
  let out = ''
  while (out.length < n) out += unit
  return out.slice(0, n)
}

/** A scripted session: prompts, tool calls whose results land later. */
function scriptedEvents() {
  const events = []
  let seq = 1
  let time = 1_700_000_000_000
  const push = (type, data) => events.push({ seq: seq++, time: time += 500, type, data })
  for (let turn = 1; turn <= 3; turn += 1) {
    push('turn/start', { turn })
    push('user/message', { message: { id: `u${turn}`, content: [{ type: 'text', text: cjk(120) }] } })
    for (let step = 0; step < 3; step += 1) {
      push('tool/call', { name: 'bash', callId: `c${turn}-${step}`, arguments: { command: `echo ${turn}-${step}` } })
    }
    push('assistant/message', {
      message: { content: [{ type: 'reasoning', text: cjk(300) }, { type: 'text', text: cjk(400) }] },
      usage: { inputTokens: 2_000, outputTokens: 90, cacheReadTokens: 5_000, totalTokens: 7_090 },
      turn,
      step: 1,
    })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // Tool results arrive at the very end, long after their calls: the fold must
  // mutate the earlier tool blocks in place (identity-stable).
  for (let turn = 1; turn <= 3; turn += 1) {
    for (let step = 0; step < 3; step += 1) {
      push('tool/result', { message: { toolCallId: `c${turn}-${step}`, content: [{ type: 'text', text: cjk(200) }] } })
    }
  }
  return events
}

test('foldSegments folds an append-only prefix incrementally and matches a full fold', () => {
  const events = scriptedEvents()
  const half = Math.floor(events.length / 2)
  let fold = foldSegments(events.slice(0, half))
  assert.equal(fold.count, half)
  fold = foldSegments(events, fold)
  assert.equal(fold.count, events.length)
  const full = foldSegments(events)
  assert.deepEqual(fold.segments, full.segments)
})

test('foldSegments recomputes from scratch when the prefix no longer matches (history merge)', () => {
  const events = scriptedEvents()
  let fold = foldSegments(events)
  // loadOlder merges older pages into the same array in place: every index
  // shifts, so the cached prefix must be discarded, not trusted.
  const older = events.splice(0, 4)
  events.unshift(...older.map((event) => ({ ...event, seq: event.seq - 1000 })))
  fold = foldSegments(events, fold)
  assert.equal(fold.count, events.length)
  assert.deepEqual(fold.segments, foldSegments(events).segments)
})

test('estimateSegments stays correct when the same array grows in place', () => {
  const events = scriptedEvents()
  estimateSegments(events)
  const tail = events.splice(Math.floor(events.length / 2))
  const grown = [...events, ...tail.map((event) => ({ ...event, seq: event.seq + 500 }))]
  estimateSegments(events)
  assert.deepEqual(estimateSegments(events), estimateSegments([...events]))
  assert.deepEqual(estimateSegments(grown), estimateSegments([...grown]))
})

const asView = (events, streamText, status = 'running') => ({
  sessionId: 'perf',
  header: { id: 'perf' },
  events,
  cursor: events.at(-1)?.seq ?? -1,
  status,
  streamText,
  streamReasoning: '',
})

test('MetricsProjector keeps durable metrics across stream frames but live tokens fresh', () => {
  const projector = new MetricsProjector()
  const events = scriptedEvents()
  const empty = projector.project(asView(events, ''))
  const short = projector.project(asView(events, cjk(100)))
  assert.ok(short.liveTokens > empty.liveTokens, 'live tokens must follow the stream text')
  assert.equal(short.usedTokens, empty.usedTokens, 'durable usage must not change with the stream')
  const long = projector.project(asView(events, cjk(5_000)))
  assert.ok(long.liveTokens > short.liveTokens)
  assert.equal(long.usedTokens, empty.usedTokens)
  assert.equal(long.cost?.tokens.total, empty.cost?.tokens.total)
})

test('MetricsProjector flips the activity when the stream starts without a cursor move', () => {
  const projector = new MetricsProjector()
  const events = scriptedEvents()
  const before = projector.project(asView(events, ''))
  const streaming = projector.project(asView(events, '正在写流式回答'))
  assert.notEqual(before.activity.verb, 'Writing')
  assert.equal(streaming.activity.verb, 'Writing')
  const drained = projector.project(asView(events, '', 'idle'))
  assert.notEqual(drained.activity.verb, 'Writing')
})

test('foldBlocks keeps earlier block identity while appending events', () => {
  const events = scriptedEvents()
  const cut = events.findIndex((event) => event.type === 'tool/result')
  let fold = foldBlocks(events.slice(0, cut))
  const openTool = fold.blocks.find((block) => block.kind === 'tool' && block.callId === 'c1-0')
  assert.ok(openTool !== undefined)
  fold = foldBlocks(events, fold)
  assert.equal(fold.count, events.length)
  const settled = fold.blocks.find((block) => block.kind === 'tool' && block.callId === 'c1-0')
  assert.ok(settled === openTool, 'appending events must not rebuild earlier blocks')
  assert.equal(settled.failed, false)
  assert.ok(String(settled.detail ?? '').length > 0)
  assert.deepEqual(
    fold.blocks.map((block) => block.kind),
    buildBlocks(events).map((block) => block.kind),
    'incremental fold must produce the same block sequence as a full rebuild',
  )
})

test('foldBlocks discards its cache when the prefix shifts or verbose flips', () => {
  const events = scriptedEvents()
  const fold = foldBlocks(events)
  const shifted = [...events]
  shifted.unshift({ seq: 0, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'earlier' }] } } })
  const refolded = foldBlocks(shifted, fold)
  assert.equal(refolded.count, shifted.length)
  assert.deepEqual(
    refolded.blocks.map((block) => block.kind),
    buildBlocks(shifted).map((block) => block.kind),
  )
  const verboseFold = foldBlocks(events, fold, true)
  assert.deepEqual(
    verboseFold.blocks.map((block) => block.kind),
    buildBlocks(events, true).map((block) => block.kind),
  )
})

test('block render cache reuses lines for unchanged blocks and re-renders mutated ones', () => {
  const events = scriptedEvents()
  const cut = events.findIndex((event) => event.type === 'tool/result')
  const baseFold = foldBlocks(events.slice(0, cut))
  const baseBlocks = baseFold.visible
  const cache = createBlockRenderCache()
  const first = renderBlocksWithRanges(baseBlocks, 80, theme, {}, cache)
  assert.equal(cache.misses, baseBlocks.length)
  assert.equal(cache.hits, 0)

  const again = renderBlocksWithRanges(baseBlocks, 80, theme, {}, cache)
  assert.deepEqual(again.lines, first.lines)
  assert.equal(cache.hits, baseBlocks.length)

  // Resuming the fold keeps earlier block identity; only the new tool-result
  // events (and the blocks they mutate) may miss the cache.
  const missesBefore = cache.misses
  const grownFold = foldBlocks(events, baseFold)
  const grown = grownFold.visible
  const third = renderBlocksWithRanges(grown, 80, theme, {}, cache)
  assert.deepEqual(third.lines, renderBlocksWithRanges(buildBlocks(events), 80, theme).lines)
  const newBlocks = grown.length - baseBlocks.length
  const mutatedBlocks = events.slice(cut).length
  assert.ok(
    cache.misses - missesBefore <= newBlocks + mutatedBlocks,
    `incremental growth must re-render at most new+mutated blocks (missed ${cache.misses - missesBefore}, new ${newBlocks}, mutated ${mutatedBlocks})`,
  )
})

test('block render cache respects width and expandTools options', () => {
  const events = scriptedEvents()
  const blocks = buildBlocks(events)
  const cache = createBlockRenderCache()
  const narrow = renderBlocksWithRanges(blocks, 40, theme, {}, cache)
  const wide = renderBlocksWithRanges(blocks, 120, theme, {}, cache)
  assert.notEqual(narrow.lines.length, wide.lines.length)
  assert.deepEqual(wide.lines, renderBlocksWithRanges(blocks, 120, theme).lines)
  const expanded = renderBlocksWithRanges(blocks, 120, theme, { expandTools: true }, cache)
  assert.deepEqual(expanded.lines, renderBlocksWithRanges(blocks, 120, theme, { expandTools: true }).lines)
})

/** A realistic streamed answer: prose, markup, fences, a table, a late diff. */
function streamedAnswerChunks() {
  return [
    '这是一段中文回答的开头，混排 **加粗**、`代码` 与 [链接](https://example.com) 标记。',
    '\n\n## 标题二\n\n',
    '- 第一条列表项，内容比较长需要折行，',
    '继续补充说明文字使其超过一行宽度。\n- 第二项\n',
    '1. 有序列表第一项\n2. 有序列表第二项\n\n',
    '> 引用块的一行\n> 引用块的第二行\n\n',
    '```ts\nconst x = 1 // 管道符 | 在围栏里必须保持字面\n',
    'const y = "第二行代码"\n```\n\n',
    '表格之前的引导文字：\n\n',
    '| 名称 | 数值 | 说明 |\n',
    '| --- | ---: | --- |\n',
    '| alpha | 1 | 第一行 |\n',
    '| beta | 22 | 第二行 |\n',
    '| gamma | 333 | 第三行 |\n\n',
    '表格之后的总结段落，',
    '继续流式追加的中文字符',
    '，直到回答结束。',
  ]
}

test('markdown stream renderer matches a full render at every checkpoint', () => {
  const width = 100
  let state
  let text = ''
  for (const chunk of streamedAnswerChunks()) {
    text += chunk
    const streamed = renderMarkdownStream(text, width, theme, state)
    state = streamed.state
    const full = renderMarkdown(text, width, theme)
    assert.deepEqual(
      streamed.lines,
      full,
      `stream render must match the full render at checkpoint ${JSON.stringify(chunk.slice(0, 12))} (text length ${text.length})`,
    )
  }
})

test('markdown stream renderer keeps matching when a table streams row by row', () => {
  const width = 80
  const rows = ['| a | b |', '| --- | --- |', '| 1 | 一 |', '| 22 | 二二 |', '| 333 | 三三三 |']
  let state
  let text = '前置段落\n\n'
  for (const row of rows) {
    text += `${row}\n`
    const streamed = renderMarkdownStream(text, width, theme, state)
    state = streamed.state
    assert.deepEqual(streamed.lines, renderMarkdown(text, width, theme), `after row ${row}`)
  }
  text += '表格结束后的文字\n'
  const closed = renderMarkdownStream(text, width, theme, state)
  assert.deepEqual(closed.lines, renderMarkdown(text, width, theme))
})

test('markdown stream renderer handles a table whose separator has no pipes', () => {
  const width = 80
  // `---` alone is a valid pipe-less separator: the hazard rule must treat it
  // as unstable too, or a header-only table freezes and the row below it then
  // renders as a stray paragraph instead of joining the table.
  const rows = ['名称 | 数值', '---', '甲 | 1', '乙乙 | 22', '丙丙丙 | 333']
  let state
  let text = '引导文字\n\n'
  for (const row of rows) {
    text += `${row}\n`
    const streamed = renderMarkdownStream(text, width, theme, state)
    state = streamed.state
    assert.deepEqual(streamed.lines, renderMarkdown(text, width, theme), `after row ${row}`)
  }
  text += '收尾文字\n'
  const closed = renderMarkdownStream(text, width, theme, state)
  assert.deepEqual(closed.lines, renderMarkdown(text, width, theme))
})

test('markdown stream renderer recomputes when earlier text is edited', () => {
  const width = 100
  const base = '第一段文字，用于占位。\n\n第二段文字。\n'
  const first = renderMarkdownStream(base, width, theme)
  const edited = `${base}新的一段尾巴。`
  const second = renderMarkdownStream(edited, width, theme, first.state)
  assert.deepEqual(second.lines, renderMarkdown(edited, width, theme))
  const rewritten = `改写后的第一段文字，用于占位。\n\n第二段文字。\n新的一段尾巴。`
  const third = renderMarkdownStream(rewritten, width, theme, second.state)
  assert.deepEqual(third.lines, renderMarkdown(rewritten, width, theme))
})

test('markdown stream renderer follows a width change', () => {
  const text = streamedAnswerChunks().join('')
  const narrow = renderMarkdownStream(text, 40, theme)
  const stillNarrow = renderMarkdownStream(text, 40, theme, narrow.state)
  assert.deepEqual(stillNarrow.lines, narrow.lines)
  const widened = renderMarkdownStream(text, 120, theme, narrow.state)
  assert.deepEqual(widened.lines, renderMarkdown(text, 120, theme))
})

test('unchanged stream results survive callers modifying their returned rows', () => {
  for (const text of [
    '连续中文回答，尚未换行。'.repeat(100),
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new',
  ]) {
    const expected = renderMarkdown(text, 80, theme)
    const first = renderMarkdownStream(text, 80, theme)
    first.lines[0] = 'caller decoration'
    first.lines.push('caller footer')
    const second = renderMarkdownStream(text, 80, theme, first.state)
    assert.deepEqual(second.lines, expected)
    second.lines.length = 0
    assert.deepEqual(renderMarkdownStream(text, 80, theme, second.state).lines, expected)
    const grown = `${text}继续追加中文`
    assert.deepEqual(renderMarkdownStream(grown, 80, theme, second.state).lines, renderMarkdown(grown, 80, theme))
  }
})

test('long CJK paragraphs without spaces or newlines stay responsive while streaming', () => {
  const sentence = '这是没有英文空格的连续中文段落，用来复现逐字输出越来越卡的问题。'
  let text = sentence.repeat(Math.ceil(40_000 / sentence.length))
  let state = renderMarkdownStream(text, 100, theme).state
  const start = performance.now()
  for (let i = 0; i < 25; i += 1) {
    text += '追加的中文文本。'
    const rendered = renderMarkdownStream(text, 100, theme, state)
    state = rendered.state
    // The animation tick also paints while text is unchanged.
    renderMarkdownStream(text, 100, theme, state)
  }
  const elapsed = performance.now() - start
  assert.ok(elapsed < 500, `25 appends and animation ticks on a 40k CJK paragraph took ${elapsed.toFixed(0)}ms`)
  assert.deepEqual(renderMarkdownStream(text, 100, theme, state).lines, renderMarkdown(text, 100, theme))
})

test('markdown stream renderer stays cheap while a long answer keeps appending', () => {
  const width = 120
  // Real model output breaks lines (paragraphs, code, lists); only the
  // growing tail re-renders, so cost tracks the delta, not the answer size.
  // (A zero-newline 8k+ line degrades to O(line) re-wrapping per frame —
  // bounded by that line, never by session history.)
  const sentence = '这是一段用于流式渲染基准测试的中文文本，混排少量 english words 与标点。'
  const paragraphs = (n) => {
    let out = ''
    while (out.length < n) out += `${sentence}\n`
    return out.slice(0, n)
  }
  const base = paragraphs(40_000)
  let state = renderMarkdownStream(base, width, theme).state
  const t0 = performance.now()
  let text = base
  for (let i = 0; i < 100; i += 1) {
    text += `${sentence}\n`
    state = renderMarkdownStream(text, width, theme, state).state
  }
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 250, `100 appends on a 40k multi-line answer must stay cheap (took ${elapsed.toFixed(0)}ms)`)
})

test('MetricsProjector streams live tokens without rescanning the whole text', () => {
  const projector = new MetricsProjector()
  const events = scriptedEvents()
  const reference = new MetricsProjector()
  let text = cjk(40_000)
  const t0 = performance.now()
  for (let i = 0; i < 100; i += 1) {
    text += '流式追加的增量中文文本。'
    const got = projector.project(asView(events, text)).liveTokens
    const want = reference.project(asView(events, text)).liveTokens
    assert.ok(Math.abs(got - want) <= 2, `checkpoint ${i}: incremental ${got} vs fresh ${want}`)
  }
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 250, `100 incremental projections must stay cheap (took ${elapsed.toFixed(0)}ms)`)
})

test('MetricsProjector recomputes live tokens when the stream restarts', () => {
  const projector = new MetricsProjector()
  const events = scriptedEvents()
  const long = projector.project(asView(events, cjk(5_000))).liveTokens
  const restarted = projector.project(asView(events, '新的回答刚刚开始')).liveTokens
  assert.ok(restarted < long, 'a restarted stream must drop back to its own length')
  const fresh = new MetricsProjector().project(asView(events, '新的回答刚刚开始')).liveTokens
  assert.equal(restarted, fresh)
})
