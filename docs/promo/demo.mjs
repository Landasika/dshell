/**
 * Scripted dshell session for the promo video.
 *
 * The real TUI is driven over a real TTY (tmux pane), but the Host is a
 * FakeBackend fed by this script, so every take is identical: no model
 * latency, no differing answers, no waiting.
 *
 *   1. docs/promo/record.sh      — records and encodes everything
 *   2. node docs/promo/demo.mjs  — run by that script inside tmux
 */
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import { runTui } from '../../dist/tui/app.js'
import { FakeBackend } from '../../dist/backend/index.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const startedAt = Date.now()
const captions = []
const chapters = []
let lastCaption = ''

function caption(text) {
  if (text === lastCaption) return
  lastCaption = text
  const t = Date.now() - startedAt
  captions.push({ t, text })
  writeFileSync(`${HERE}out/captions.json`, JSON.stringify({ startedAt, captions, chapters }, null, 2))
}

function chapter(text) {
  const t = Date.now() - startedAt
  chapters.push({ t, text })
  writeFileSync(`${HERE}out/captions.json`, JSON.stringify({ startedAt, captions, chapters }, null, 2))
}

const COLUMNS = 110
const ROWS = 28

/** Records every frame dshell paints, so the encoder can rebuild the screen. */
const writes = []
const output = {
  isTTY: true,
  columns: COLUMNS,
  rows: ROWS,
  write(chunk) {
    writes.push({ t: Date.now() - startedAt, chunk: String(chunk) })
    return true
  },
  on() {},
  off() {},
  removeListener() {},
}

const input = new EventEmitter()
input.isTTY = true
input.setRawMode = () => {}
input.setEncoding = () => {}
input.resume = () => {}
input.pause = () => {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const type = async (text, cps = 24) => {
  for (const char of text) {
    input.emit('data', char)
    await sleep(1000 / cps)
  }
}
const key = (sequence) => input.emit('data', sequence)

const ENTER = '\r'
const ESC = '\u001b'
const ALT_UP = '\u001b[1;3A'
const ALT_DOWN = '\u001b[1;3B'
const ALT_Q = '\u001bq'
const CTRL_O = '\u000f'
const CTRL_C = '\u0003'

// ---------------------------------------------------------------- fixtures

const text = (value) => [{ type: 'text', text: value }]
const user = (id, value) => ({ message: { id, role: 'user', source: { kind: 'user' }, content: text(value) } })
const assistant = (value) => ({ message: { id: randomUUID(), role: 'assistant', content: text(value) } })

const s1Events = [
  ['turn/start', { turn: 1 }],
  ['user/message', user('u-1', '看一眼项目结构，配置加载那块我们要动')],
  ['tool/call', { name: 'bash', callId: 'c0', arguments: JSON.stringify({ command: 'ls src/config', description: 'List config module' }) }],
  ['tool/result', { message: { toolCallId: 'c0', isError: false, content: text('index.ts  load.ts  schema.ts  defaults.ts') } }],
  ['tool/call', { name: 'read', callId: 'c1', arguments: JSON.stringify({ path: 'src/config/load.ts' }) }],
  ['tool/result', { message: { toolCallId: 'c1', isError: false, content: text('export function loadConfig(cwd = process.cwd()) {\n  const file = join(cwd, "dshell.config.json")\n  return JSON.parse(readFileSync(file, "utf8"))\n}\n') } }],
  ['assistant/message', assistant('结构很小：`load.ts` 负责读文件，`schema.ts` 做校验，`index.ts` 只做导出。\n\n`loadConfig()` 是同步的，而且每次调用都会重新读盘 + 解析，热路径上会重复很多次。要改成异步加缓存的话，三处就够。')],
  ['turn/end', { reason: { kind: 'completed' } }],
]

const s2Events = [
  ['turn/start', { turn: 1 }],
  ['user/message', user('u-2', '整理一下终端里 markdown 的渲染差异')],
  ['assistant/message', assistant('主要在三个地方不一样：\n\n| 元素 | dshell 的处理 |\n| --- | --- |\n| 表格 | 按终端宽度重排，列内换行 |\n| 代码块 | 左侧竖线 + 变灰，不折行 |\n| 链接 | 展开成 `文字 (url)` |\n\n结论：按 80 列设计，超长行优先在单元格内换行，不要截断。')],
  ['turn/end', { reason: { kind: 'completed' } }],
]

const s3Events = [
  ['turn/start', { turn: 1 }],
  ['user/message', user('u-3', 'provider 列表里加一个字段说明')],
  ['assistant/message', assistant('好的，`/provider` 里每行会显示 `baseURL`、`apiKeyEnv` 和模型数量。')],
  ['turn/end', { reason: { kind: 'completed' } }],
]

const seed = (sessionId, title, events, ageMinutes) => {
  let seq = 0
  const out = events.map(([type, data]) => ({ type, seq: seq++, data }))
  return {
    sessionId,
    cwd: process.cwd(),
    title,
    createdAt: Date.now() - ageMinutes * 60_000,
    updatedAt: Date.now() - ageMinutes * 60_000,
    events: out,
  }
}

const backend = new FakeBackend([
  seed('s1', '把配置加载改成异步', s1Events, 2),
  seed('s2', 'Markdown 渲染调研', s2Events, 40),
  seed('s3', 'Provider 列表整理', s3Events, 90),
])

const seqs = new Map([['s1', s1Events.length], ['s2', s2Events.length], ['s3', s3Events.length]])
const nextSeq = (sessionId) => {
  const seq = seqs.get(sessionId) ?? 0
  seqs.set(sessionId, seq + 1)
  return seq
}
const emit = (sessionId, type, data) => backend.emit(sessionId, { type, seq: nextSeq(sessionId), data })
const stream = (sessionId, value) => backend.stream(sessionId, value)

const slowly = async (sessionId, value, ms) => {
  const chunks = Math.max(4, Math.round(ms / 55))
  const size = Math.max(1, Math.ceil(value.length / chunks))
  for (let index = 0; index < value.length; index += size) {
    stream(sessionId, value.slice(0, index + size))
    await sleep(ms / chunks)
  }
  stream(sessionId, value)
}

/** Queue of scripted replies, keyed by the text that was submitted. */
let onSend = async () => {}
let sendReceipt = null

const handleProxy = (handle) => new Proxy(handle, {
  get(target, prop) {
    if (prop === 'send') {
      return async (submitted, options = {}) => {
        const requestId = `req-${randomUUID().slice(0, 8)}`
        const receipt = { requestId, mode: options.mode ?? 'queue' }
        void onSend(submitted, options.mode ?? 'queue', requestId)
        return receipt
      }
    }
    if (prop === 'cancel') {
      return async () => {
        cancelled = true
        return target.cancel()
      }
    }
    const value = target[prop]
    return typeof value === 'function' ? value.bind(target) : value
  },
})

const backendProxy = new Proxy(backend, {
  get(target, prop) {
    if (prop === 'openSession') {
      return async (sessionId) => handleProxy(await target.openSession(sessionId))
    }
    if (prop === 'createSession') {
      return async (options) => handleProxy(await target.createSession(options))
    }
    const value = target[prop]
    return typeof value === 'function' ? value.bind(target) : value
  },
})

// ---------------------------------------------------------------- turns

const REPLY = `问题清楚了：\`loadConfig()\` 每次调用都会同步读盘再解析，热路径上重复很多。

改动集中在三处：

| 位置 | 改动 |
| --- | --- |
| src/config/load.ts | 改成 async，按 mtime 做一层缓存 |
| src/config/index.ts | 导出 getConfig()，懒加载单例 |
| tests/config.test.ts | 补缓存命中与失效用例 |

\`\`\`ts
export async function loadConfig(cwd = process.cwd()) {
  const stat = await fs.stat(file)
  if (cache && cache.mtime === stat.mtimeMs) return cache.value
  const value = schema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
  return (cache = { mtime: stat.mtimeMs, value }).value
}
\`\`\`

要我直接动手改吗？`

let busy = false
let cancelled = false

const refactorTurn = async (submitted, requestId) => {
  busy = true
  cancelled = false
  emit('s1', 'turn/start', { turn: 2 })
  await sleep(220)
  emit('s1', 'user/message', user(requestId, submitted))
  await sleep(420)
  await slowly('s1', '先看现在的实现。', 900)
  stream('s1', '')
  emit('s1', 'tool/call', { name: 'bash', callId: 'c2', arguments: JSON.stringify({ command: 'sed -n 1,20p src/config/load.ts', description: 'Read the loader' }) })
  await sleep(900)
  emit('s1', 'tool/result', { message: { toolCallId: 'c2', isError: false, content: text('export function loadConfig(cwd = process.cwd()) {\n  const file = join(cwd, "dshell.config.json")\n  return JSON.parse(readFileSync(file, "utf8"))\n}') } })
  await sleep(700)
  await slowly('s1', REPLY, 4200)
  stream('s1', '')
  await sleep(150)
  emit('s1', 'assistant/message', assistant(REPLY))
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  busy = false
}

const longTurn = async (submitted, requestId) => {
  busy = true
  cancelled = false
  emit('s1', 'turn/start', { turn: 3 })
  await sleep(200)
  emit('s1', 'user/message', user(requestId, submitted))
  const body = '正在梳理依赖：先跑一遍现有的测试，确认改动前的基线，然后把 load.ts 的同步读盘拆成异步加载 + 缓存，再补上缓存失效的用例。'
  for (let index = 1; index <= body.length; index += 1) {
    if (cancelled) break
    stream('s1', body.slice(0, index))
    await sleep(85)
    if (steer !== null && Date.now() - steer.at > 1600) {
      const pending = steer
      steer = null
      emit('s1', 'user/message', user(pending.requestId, pending.text))
      await sleep(400)
    }
  }
  busy = false
}

let steer = null

const shortTurn = async (submitted, requestId) => {
  const reply = '好，这轮结束后先跑 `pnpm test`，把基线留住再动 load.ts。'
  emit('s1', 'turn/start', { turn: 4 })
  await sleep(200)
  emit('s1', 'user/message', user(requestId, submitted))
  await sleep(300)
  await slowly('s1', reply, 1200)
  stream('s1', '')
  emit('s1', 'assistant/message', assistant(reply))
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  busy = false
}

onSend = async (submitted, mode, requestId) => {
  if (mode === 'steer' && busy) {
    steer = { requestId, text: submitted, at: Date.now() }
    return
  }
  if (mode === 'queue' && busy) return
  if (submitted.includes('配置加载')) return refactorTurn(submitted, requestId)
  if (submitted.includes('测试')) return shortTurn(submitted, requestId)
  if (submitted.includes('一起做掉')) return longTurn(submitted, requestId)
}

// ---------------------------------------------------------------- timeline

const main = async () => {
  await backend.connect()
  const app = runTui(backendProxy, {
    cwd: process.cwd(),
    resume: 's1',
    color: true,
    input,
    output,
  })
  await sleep(1200)

  // The renderer opens on a title card, so hold the first frame long enough
  // that the first caption is not hidden behind it.
  await sleep(4600)
  chapter('01 · 一次对话')
  caption('dshell：DeepSeek Harness 的终端前端')
  await sleep(3200)
  caption('同一个会话，同一个 Agent：流式、工具、审批都在')
  await sleep(2800)

  caption('说人话就行 · Enter 发送')
  await type('把配置加载改成异步的，顺便加一层缓存')
  await sleep(700)
  caption('真流式输出，工具调用收成一行')
  key(ENTER)
  await sleep(15000)
  caption('Markdown 表格按终端宽度重排，代码块原样保留')
  await sleep(5200)
  caption('Alt+↑ 选中一个块，Enter 看详情')
  key(ALT_UP)
  await sleep(1300)
  key(ALT_UP)
  await sleep(1200)
  caption('工具调用也能打开看完整结果')
  key(ENTER)
  await sleep(3000)
  key(ESC)
  await sleep(900)
  caption('Ctrl+O 展开 / 收起工具输出')
  key(CTRL_O)
  await sleep(2600)
  key(CTRL_O)
  await sleep(1500)
  caption('? 打开键位速查，随时查')
  key('?')
  await sleep(3000)
  key(ESC)
  await sleep(900)

  chapter('02 · 插话与排队')
  caption('新的一轮：等它跑起来')
  await type('把三处改动一起做掉', 26)
  key(ENTER)
  await sleep(1900)
  caption('Enter 插话：折进当前回合的下一步')
  await type('顺便把测试补上')
  key(ENTER)
  await sleep(2400)
  caption('Alt+Q 排队：当前回合结束后再执行')
  await type('跑一遍 pnpm test')
  key(ALT_Q)
  await sleep(2800)
  caption('Ctrl-C 只打断这一轮，队列里的请求接着跑')
  key(CTRL_C)
  await sleep(5200)

  chapter('03 · 会话是共享的')
  caption('/sessions：按最后编辑时间排序')
  await type('/sessions')
  key(ENTER)
  await sleep(3000)
  key('\u001b[B')
  await sleep(1000)
  key(ENTER)
  await sleep(2800)
  caption('会话属于 Host：换个终端、换台机器都能接上')
  await sleep(3200)

  chapter('04 · 审批也在终端里')
  caption('危险操作就地审批，按 a 通过')
  backend.askApproval('s2', {
    requestId: 'ap-1',
    sessionId: 's2',
    toolName: 'bash',
    reason: '需要执行 pnpm test 验证缓存改动',
  })
  await sleep(3400)
  key('a')
  await sleep(2400)

  chapter('05 · 结束')
  caption('一个命令开始：dshell')
  // Hold for the closing card, which the renderer overlays on the tail.
  await sleep(8600)
  writeFileSync(`${HERE}out/frames.jsonl`, writes.map((write) => JSON.stringify(write)).join('\n'))
  writeFileSync(`${HERE}out/meta.json`, JSON.stringify({ columns: COLUMNS, rows: ROWS, durationMs: Date.now() - startedAt }))
  process.exit(0)
  void app
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
