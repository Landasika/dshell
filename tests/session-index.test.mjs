/**
 * 会话轻索引的单元测试。
 *
 * 这层的价值全在"边界情况不出错"上：索引是派生数据，必须能容忍坏行、
 * 支持覆盖写、可压实、可重建。竞品（Claude Code 的 history.jsonl、Codex 的
 * threads 表）都证明了"索引只存列表需要的字段"是对的，所以这里重点测索引
 * 自身的正确性，而不是它省了多少时间。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const {
  SessionIndexFile,
  parseIndexText,
  serializeRow,
  previewOfText,
  rowsFromHeaders,
  isSubagentRow,
  normalizeCleanupDays,
  isExpired,
  MIN_CLEANUP_DAYS,
} = await import('../dist/plugin/session-index.js')

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-index-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('parseIndexText: 后写的行覆盖先写的', () => {
  const rows = parseIndexText([
    serializeRow({ sessionId: 'a', title: '旧' }),
    serializeRow({ sessionId: 'b', title: '另一个' }),
    serializeRow({ sessionId: 'a', title: '新' }),
  ].join(''))
  assert.equal(rows.size, 2)
  assert.equal(rows.get('a').title, '新')
  assert.equal(rows.get('b').title, '另一个')
})

test('parseIndexText: 坏行与空行被跳过，不牵连其他行', () => {
  const rows = parseIndexText([
    serializeRow({ sessionId: 'good-1' }),
    '{ 这不是 JSON',
    '',
    'null',
    '[1,2,3]',
    serializeRow({ sessionId: '' }),
    serializeRow({ sessionId: 'good-2' }),
  ].join('\n'))
  assert.deepEqual([...rows.keys()].sort(), ['good-1', 'good-2'])
})

test('parseIndexText: 缺 sessionId 的行不算数', () => {
  const rows = parseIndexText('{"title":"没有 id"}\n{"sessionId":"ok"}\n')
  assert.deepEqual([...rows.keys()], ['ok'])
})

test('rowsFromHeaders: 子会话带上父子边', () => {
  const rows = rowsFromHeaders([
    { id: 'parent', cwd: '/w', createdAt: 1, title: '父' },
    { id: 'child', cwd: '/w', createdAt: 2, origin: 'subagent', parentSession: 'parent', delegationDepth: 1 },
  ])
  const child = rows.find(row => row.sessionId === 'child')
  assert.equal(child.parentSessionId, 'parent')
  assert.equal(child.delegationDepth, 1)
  assert.equal(isSubagentRow(child), true)
  assert.equal(isSubagentRow(rows.find(row => row.sessionId === 'parent')), false)
})

test('rowsFromHeaders: extras 里的 preview 优先于 header 标题', () => {
  const extras = new Map([['s1', { preview: '最近一句', firstUserMessage: '第一句' }]])
  const rows = rowsFromHeaders([{ id: 's1', title: '标题' }], extras)
  assert.equal(rows[0].title, '标题')
  assert.equal(rows[0].preview, '最近一句')
  assert.equal(rows[0].firstUserMessage, '第一句')
})

test('previewOfText: 折叠空白并截断', () => {
  assert.equal(previewOfText('  多  个\n空白\t字符  '), '多 个 空白 字符')
  assert.equal(previewOfText('   '), undefined)
  const long = 'x'.repeat(300)
  const clipped = previewOfText(long, 20)
  assert.equal(clipped.length, 20)
  assert.ok(clipped.endsWith('…'))
})

test('SessionIndexFile: 文件不存在时读成空索引且不抛错', async () => {
  await withTempDir(async (dir) => {
    const file = new SessionIndexFile(join(dir, 'nope.jsonl'))
    const snapshot = await file.read()
    assert.equal(snapshot.empty, true)
    assert.equal(snapshot.rows.size, 0)
    assert.equal(snapshot.mtimeMs, undefined)
  })
})

test('SessionIndexFile: 追加后可读回，同 id 覆盖', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    assert.equal(await file.append({ sessionId: 's1', title: '第一版' }), true)
    assert.equal(await file.append({ sessionId: 's1', title: '第二版' }), true)
    assert.equal(await file.append({ sessionId: 's2', title: '别的' }), true)

    const rows = await file.rowsOf(true)
    assert.equal(rows.size, 2)
    assert.equal(rows.get('s1').title, '第二版')

    // 追加式写入：磁盘上是三行，语义上是两行。
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 3)
  })
})

test('SessionIndexFile: appendMany 合并成一次写', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    await file.appendMany([
      { sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' },
    ])
    const rows = await file.rowsOf(true)
    assert.deepEqual([...rows.keys()].sort(), ['a', 'b', 'c'])
  })
})

test('SessionIndexFile: 空数组不产生文件', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    assert.equal(await file.appendMany([]), true)
    const snapshot = await file.read()
    assert.equal(snapshot.empty, true)
  })
})

test('SessionIndexFile: 坏行不影响好行', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    await writeFile(path, `${serializeRow({ sessionId: 'ok', title: 't' })}\n坏行\n`, 'utf8')
    const file = new SessionIndexFile(path)
    const rows = await file.rowsOf(true)
    assert.deepEqual([...rows.keys()], ['ok'])
  })
})

test('SessionIndexFile: compact 未超阈值时不动作', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    await file.append({ sessionId: 'a' })
    assert.equal(await file.compact(4000), false)
  })
})

test('SessionIndexFile: compact 超阈值后压实成一份干净文件', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    for (let i = 0; i < 40; i += 1) await file.append({ sessionId: 'same', title: `第${i}版` })
    const before = (await readFile(path, 'utf8')).trim().split('\n').length
    assert.equal(before, 40)

    assert.equal(await file.compact(10), true)
    const after = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(after.length, 1)
    assert.equal(JSON.parse(after[0]).title, '第39版')

    const rows = await file.rowsOf(true)
    assert.equal(rows.get('same').title, '第39版')
  })
})

test('SessionIndexFile: 并发 append 不会写出半行', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'index.jsonl')
    const file = new SessionIndexFile(path)
    await Promise.all(Array.from({ length: 50 }, (_, i) => file.append({ sessionId: `s${i}`, title: `t${i}` })))
    const rows = await file.rowsOf(true)
    assert.equal(rows.size, 50)
    const text = await readFile(path, 'utf8')
    assert.ok(text.endsWith('\n'))
    for (const line of text.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line))
  })
})

test('SessionIndexFile: isStale 在未加载时为真', async () => {
  await withTempDir(async (dir) => {
    const file = new SessionIndexFile(join(dir, 'missing.jsonl'))
    await file.read()
    assert.equal(file.isStale(1000), true)
  })
})

test('normalizeCleanupDays: 最小值 1 天，0 被抬到 1（抄 Claude Code）', () => {
  assert.equal(MIN_CLEANUP_DAYS, 1)
  assert.equal(normalizeCleanupDays(undefined), undefined)
  assert.equal(normalizeCleanupDays(0), 1)
  assert.equal(normalizeCleanupDays(-5), 1)
  assert.equal(normalizeCleanupDays(0.4), 1)
  assert.equal(normalizeCleanupDays(30), 30)
  assert.equal(normalizeCleanupDays(30.9), 30)
  assert.equal(normalizeCleanupDays(Number.NaN), undefined)
  assert.equal(normalizeCleanupDays(Number.POSITIVE_INFINITY), undefined)
})

test('isExpired: 按 updatedAt 判断，缺时间戳时不算过期', () => {
  const now = 1_800_000_000_000
  const day = 86_400_000
  assert.equal(isExpired({ sessionId: 'a', updatedAt: now - 40 * day }, 30, now), true)
  assert.equal(isExpired({ sessionId: 'a', updatedAt: now - 10 * day }, 30, now), false)
  assert.equal(isExpired({ sessionId: 'a' }, 30, now), false)
  // 没有 updatedAt 时退回 createdAt。
  assert.equal(isExpired({ sessionId: 'a', createdAt: now - 40 * day }, 30, now), true)
  // 保留期未设置 = 永不清理。
  assert.equal(isExpired({ sessionId: 'a', updatedAt: now - 9999 * day }, undefined, now), false)
  // 0 被抬到 1 天，所以 2 天前的会话算过期。
  assert.equal(isExpired({ sessionId: 'a', updatedAt: now - 2 * day }, 0, now), true)
})

test('索引体积远小于正文（结构前提）', () => {
  // 这条测的是"字段确实只有列表需要的那些"：一行序列化后应在数百字节级，
  // 而不是把正文塞进来。
  const line = serializeRow({
    sessionId: 'session-0123456789abcdef-0123456789abcdef',
    title: '一个典型长度的会话标题，用来估算索引行的体积',
    preview: '最近一条用户提问的首行内容，同样按典型长度估算体积',
    firstUserMessage: '第一条用户提问',
    cwd: '/home/landasika/dshell',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    sizeBytes: 1_234_567,
    origin: 'subagent',
    parentSessionId: 'session-parent',
    delegationDepth: 1,
    indexedAt: 1_800_000_000_000,
  })
  assert.ok(line.length < 600, `索引行 ${line.length} 字节，超过预期`)
})

test('SessionIndexFile: 追加后缓存增量合并，不需要重读磁盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-idx-'))
  const path = join(dir, 'index.jsonl')
  try {
    const file = new SessionIndexFile(path)
    await file.appendMany([{ sessionId: 'a', cwd: '/x' }, { sessionId: 'b', cwd: '/y' }])

    // 先读一次，让缓存建立。
    const first = await file.rowsOf()
    assert.equal(first.get('a')?.cwd, '/x')
    assert.equal(file.rows, first, '读完之后缓存应当被持有')

    // 再写：缓存对象**必须是同一个**。
    //
    // 这条断言是这次 OOM 的护栏。原来 appendMany 末尾写的是
    //   this.rows = undefined
    // 于是每写一次就丢掉整份缓存，下次 rowsOf() 必须 readFile + JSON.parse
    // 整个文件。索引是追加式的、会无界变长，两者叠加把 484 MB 的文件
    // 反复读进内存，最终 8 次 `Reached heap limit`。
    const before = file.rows
    await file.appendMany([{ sessionId: 'c', cwd: '/z' }])
    assert.equal(file.rows, before, '写入不应丢弃缓存对象，应当增量合并')
    assert.equal(file.rows.get('c')?.cwd, '/z', '新写入的行要出现在缓存里')
    assert.equal(file.rows.get('a')?.cwd, '/x', '旧行不能被冲掉')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionIndexFile: 同一会话反复写入不会让缓存膨胀', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-idx-'))
  const path = join(dir, 'index.jsonl')
  try {
    const file = new SessionIndexFile(path)
    await file.rowsOf()
    // 模拟真实负载：每轮把同一批会话完整重写一遍。
    for (let round = 0; round < 50; round++) {
      await file.appendMany([
        { sessionId: 's1', cwd: '/p', updatedAt: round },
        { sessionId: 's2', cwd: '/q', updatedAt: round },
      ])
    }
    const rows = await file.rowsOf()
    // 磁盘上是 100 行，但内存里只有 2 个会话 —— 这正是"增量合并"的意义。
    assert.equal(rows.size, 2)
    assert.equal(rows.get('s1')?.updatedAt, 49, '后写的覆盖先写的')
    const onDisk = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(onDisk.length, 100, '磁盘上仍然是追加式 100 行')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionIndexFile: compact 复用缓存而不是强制重读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-idx-'))
  const path = join(dir, 'index.jsonl')
  try {
    const file = new SessionIndexFile(path)
    await file.appendMany([{ sessionId: 'a', cwd: '/x' }])
    await file.rowsOf()
    const cached = file.rows
    // 塞够行数让它真的超阈值。
    const filler = []
    for (let i = 0; i < 20; i++) filler.push({ sessionId: `f${i}`, cwd: '/f' })
    await file.appendMany(filler)
    // 缓存必须还是同一个对象（appendMany 走增量合并）。
    assert.equal(file.rows, cached)
    const did = await file.compact(5)
    assert.equal(did, true, '行数超阈值时应当压实')
    // 压实后行数等于去重后的会话数。
    const after = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(after.length, 21)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
