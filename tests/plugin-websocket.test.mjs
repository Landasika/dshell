/**
 * WebSocket 入口的集成测试。
 *
 * 重点不是"WS 能不能连上"，而是**它和 CLI 是不是同一个中枢**：
 * 同一个客户端集合、同一张订阅表、同一个审批协调器。多端同步是这个设计的
 * 直接结果，所以测试必须证明它——两个 WS 客户端订阅同一会话，一端发消息，
 * 另一端要收到事件。
 *
 * 用真 WebSocket 客户端（Node 24 自带）打真端口，只把 dsh 的 ctx 换成 fake。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { apply } = await import('../dist/plugin/index.js')

/** 找一个空闲端口：绑 0 让内核分配，再关掉。 */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function createFakeCtx() {
  const sessions = new Map()
  const listeners = new Map()
  const workspaces = new Map()
  let workspaceSeq = 0

  const makeAgent = (sessionId) => ({
    session: { id: sessionId },
    followup(message) {
      const list = listeners.get(sessionId) ?? []
      for (const listener of list) listener({ type: 'user/message', data: { message } })
    },
    steer(message) {
      const list = listeners.get(sessionId) ?? []
      for (const listener of list) listener({ type: 'user/message', data: { message } })
    },
    cancel() {},
  })

  const ctx = {
    agents: {
      get: (sessionId) => (sessions.get(sessionId)?.live === true ? makeAgent(sessionId) : undefined),
      list: () => [...sessions.keys()],
      resume: async ({ resumeSessionId }) => ({ agent: makeAgent(resumeSessionId) }),
      create: async () => ({ agent: makeAgent('created') }),
    },
    sessions: {
      get: (sessionId) => sessions.get(sessionId),
      list: () => [...sessions.values()],
    },
    sessionQuery: {
      listSessions: async () => [...sessions.values()].map((entry) => ({
        header: entry.header,
        live: entry.live === true,
        persisted: entry.persisted !== false,
      })),
      readSession: async (sessionId) => sessions.get(sessionId) ?? { events: [] },
      observeSession: async (sessionId) => {
        const entry = sessions.get(sessionId)
        if (entry?.title === undefined) throw new Error('no title')
        return { projections: { values: new Map([['title', entry.title]]) } }
      },
    },
    workspaceRegistry: {
      list: () => [...workspaces.values()],
      create: ({ path }) => {
        workspaceSeq += 1
        const workspace = { id: `ws-${String(workspaceSeq)}`, path, title: path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: () => ({ ok: true }),
      unarchiveSession: () => ({ ok: true }),
      pinSession: () => ({ ok: true }),
      unpinSession: () => ({ ok: true }),
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /** 测试可替换的服务查找表（真实 dsh 由 cordis 容器提供）。 */
    services: {},
    get(name) {
      return this.services[name]
    },
    effect(fn) {
      this.disposers.push(fn())
    },
    /** 测试用：派发一个 ctx 事件（真实 dsh 由 Host 触发）。 */
    __emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    disposers: [],
  }
  return { ctx, sessions, workspaces }
}

/** 一条真 WebSocket 客户端，按 NDJSON 收集消息。 */
class WsClient {
  constructor(ws) {
    this.ws = ws
    this.messages = []
    this.waiters = []
    ws.onmessage = (event) => {
      for (const line of String(event.data).split('\n')) {
        if (line.trim().length === 0) continue
        this.messages.push(JSON.parse(line))
        this.flush()
      }
    }
  }

  static async open(port, token, query = '') {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws?token=${encodeURIComponent(token)}${query}`)
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws open failed'))
      setTimeout(() => reject(new Error('ws open timeout')), 4000)
    })
    return new WsClient(ws)
  }

  send(message) {
    this.ws.send(`${JSON.stringify(message)}\n`)
  }

  async next(type, timeoutMs = 4000) {
    return this.waitFor((message) => message.type === type, timeoutMs)
  }

  async waitFor(predicate, timeoutMs = 4000) {
    const existing = this.messages.find(predicate)
    if (existing !== undefined) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting; saw ${this.messages.map((m) => String(m.type)).join(',')}`)), timeoutMs)
      this.waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message) } })
    })
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const match = this.messages.find(waiter.predicate)
      if (match === undefined) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve(match)
    }
  }

  destroy() {
    this.ws.close()
  }
}

async function start(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-ws-'))
  const socketPath = join(directory, 'dshell.sock')
  const port = await freePort()
  const harness = createFakeCtx()
  await apply(harness.ctx, {
    socketPath,
    wsPort: port,
    wsHost: '127.0.0.1',
    deviceFile: join(directory, 'devices.json'),
    ...config,
  })
  // 等监听就绪
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`)
      if (response.ok) break
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  t.after(async () => {
    for (const disposer of harness.ctx.disposers) await disposer?.()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...harness, port, directory, socketPath }
}

/** 直接从插件内部拿设备表签一个 token（测试里不走配对流程）。 */
async function issueToken(port) {
  // 配对端点没暴露成 HTTP（码要从本机取），测试里改走设备文件：
  // 这里用一个已知 token 直接写进设备表更简单——但那要 access 内部状态。
  // 所以改测配对：先 POST /api/pair/code 拿码（回环可用），再 claim。
  const codeResponse = await fetch(`http://127.0.0.1:${String(port)}/api/pair/code`, { method: 'POST' })
  assert.equal(codeResponse.status, 200, 'pair/code 应可用（回环）')
  const { code } = await codeResponse.json()
  const claim = await fetch(`http://127.0.0.1:${String(port)}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'test-device' }),
  })
  assert.equal(claim.status, 201, 'claim 应签发 token')
  const body = await claim.json()
  return body.token
}

test('无 token 的 WS 升级被拒绝', async (t) => {
  const harness = await start(t)
  await assert.rejects(
    WsClient.open(harness.port, ''),
    /ws open failed/,
    '空 token 不该连上',
  )
})

test('伪造 token 被拒绝', async (t) => {
  const harness = await start(t)
  await assert.rejects(WsClient.open(harness.port, 'not-a-real-token'), /ws open failed/)
})

test('合法 token 能完成 hello/welcome 握手', async (t) => {
  const harness = await start(t)
  const token = await issueToken(harness.port)
  const client = await WsClient.open(harness.port, token)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  const welcome = await client.next('welcome')
  assert.equal(welcome.protocol, 2)
  assert.ok(Array.isArray(welcome.capabilities), 'welcome 应带能力集')
  assert.ok(welcome.capabilities.length > 0, '能力集不该为空')
})

test('protocol 不符时明确报错，不是静默断开', async (t) => {
  const harness = await start(t)
  const token = await issueToken(harness.port)
  const client = await WsClient.open(harness.port, token)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 1 })
  const error = await client.next('error')
  assert.equal(error.code, 'PROTOCOL_MISMATCH')
})

test('WS 客户端能列出会话（与 CLI 同一数据源）', async (t) => {
  const harness = await start(t)
  harness.workspaces.set('w1', { id: 'w1', path: '/home/u/project', title: 'project' })
  harness.sessions.set('session-1', {
    header: { id: 'session-1', cwd: '/home/u/project', title: '示例会话', createdAt: 1000 },
    events: [{ type: 'user/message', seq: 1, data: { text: 'hi' } }],
    live: false,
    persisted: true,
  })
  const token = await issueToken(harness.port)
  const client = await WsClient.open(harness.port, token)
  t.after(() => client.destroy())
  client.send({ type: 'hello', protocol: 2 })
  await client.next('welcome')
  client.send({ type: 'list' })
  const sessions = await client.next('sessions')
  assert.equal(sessions.sessions.length, 1, `实际返回 ${JSON.stringify(sessions.sessions)}`)
  assert.equal(sessions.sessions[0].sessionId, 'session-1')
})

test('多端同步：两个 WS 客户端订阅同一会话，都能收到事件', async (t) => {
  const harness = await start(t)
  harness.sessions.set('shared', {
    header: { id: 'shared', cwd: '/home/u/project', title: '共享会话', createdAt: 1000 },
    events: [{ type: 'user/message', seq: 1, data: { text: 'hello' } }],
    live: true,
    persisted: true,
  })
  const token = await issueToken(harness.port)

  const phone = await WsClient.open(harness.port, token)
  const desktop = await WsClient.open(harness.port, token)
  t.after(() => { phone.destroy(); desktop.destroy() })

  for (const client of [phone, desktop]) {
    client.send({ type: 'hello', protocol: 2 })
    await client.next('welcome')
    client.send({ type: 'attach', sessionId: 'shared' })
    await client.next('attached')
  }

  // 中枢产生一个新事件，两端都应收到——这就是多端同步
  const listeners = harness.ctx.on
  harness.sessions.get('shared').events.push({ type: 'assistant/message', seq: 2, data: { text: 'world' } })
  // 触发 ctx 的 session/event 监听：直接用 sessions 里的 listeners
  // （fake ctx 把 on('session/event') 存在 listeners 表里，通过 emit 派发）
  const emit = harness.ctx.__emit
  if (typeof emit === 'function') emit('session/event', { id: 'shared' }, { type: 'assistant/message', seq: 2, data: { text: 'world' } })

  // 两个客户端都必须看到 seq=2（如果中枢为每个传输各建一份状态，这里就会失败）
  for (const [name, client] of [['phone', phone], ['desktop', desktop]]) {
    const event = await client.waitFor(
      (message) => message.type === 'event' && message.event?.seq === 2,
      4000,
    ).catch(() => undefined)
    assert.notEqual(event, undefined, `${name} 应收到共享会话的新事件（多端同步）`)
  }
})

test('配对码只能换一次 token', async (t) => {
  const harness = await start(t)
  const codeResponse = await fetch(`http://127.0.0.1:${String(harness.port)}/api/pair/code`, { method: 'POST' })
  const { code } = await codeResponse.json()

  const first = await fetch(`http://127.0.0.1:${String(harness.port)}/api/pair/claim`, {
    method: 'POST',
    body: JSON.stringify({ code, name: 'a' }),
  })
  assert.equal(first.status, 201)

  const second = await fetch(`http://127.0.0.1:${String(harness.port)}/api/pair/claim`, {
    method: 'POST',
    body: JSON.stringify({ code, name: 'b' }),
  })
  assert.notEqual(second.status, 201, '同一个码第二次不该签发 token')
})

test('宠物连上即收到聚合 state（无需自己请求）', async (t) => {
  const harness = await start(t)
  harness.workspaces.set('w1', { id: 'w1', path: '/home/u/project', title: 'project' })
  harness.sessions.set('busy', {
    header: { id: 'busy', cwd: '/home/u/project', title: '正在跑', createdAt: 2000 },
    events: [],
    live: true,
    persisted: true,
  })
  // `running` 来自 Host 的 sessionController 投影，不是 listSessions 的字段
  harness.ctx.services.sessionController = {
    list: async () => ({ items: [{ sessionId: 'busy', running: true, updatedAt: 5000 }] }),
  }

  const token = await issueToken(harness.port)
  const pet = await WsClient.open(harness.port, token, '&client=pet')
  t.after(() => pet.destroy())
  pet.send({ type: 'hello', protocol: 2 })

  const state = await pet.next('state', 6000)
  assert.ok(Array.isArray(state.sessions), 'state.sessions 应是数组')
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0].id, 'busy')
  assert.equal(state.sessions[0].phase, 'working', 'running+working 应折叠成 working')
  assert.equal(state.running, 1)
  assert.equal(state.focus, '正在跑', 'focus 应指向运行中的会话')
})

test('宠物身份不影响 app 客户端收到的是自己的视图', async (t) => {
  const harness = await start(t)
  const token = await issueToken(harness.port)
  const app = await WsClient.open(harness.port, token)
  t.after(() => app.destroy())
  app.send({ type: 'hello', protocol: 2 })
  const welcome = await app.next('welcome')
  assert.equal(welcome.protocol, 2)
  // app 不该被自动推 state
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(
    app.messages.filter((message) => message.type === 'state').length,
    0,
    'app 客户端不该收到 pet 的 state 推送',
  )
})
