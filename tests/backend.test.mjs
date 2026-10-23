import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BackendError, FakeBackend, SocketBackend } from '../dist/backend/index.js'

async function socketServer(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-backend-'))
  const socketPath = join(directory, 'dshell.sock')
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) handler(JSON.parse(line), socket)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function write(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`)
}

test('FakeBackend exposes workspaces, sessions, streaming, and approval', async () => {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work/one', events: [] }])
  await backend.connect()
  assert.equal(backend.capabilities().createSession, true)

  const workspaces = await backend.listWorkspaces()
  assert.equal(workspaces[0].path, '/work/one')
  assert.equal((await backend.listSessions())[0].sessionId, 's1')

  const handle = await backend.createSession({ cwd: '/work/two' })
  const seen = []
  const off = handle.subscribe((view) => seen.push(view))
  const receipt = await handle.send('hello')
  assert.match(receipt.requestId, /^[0-9a-f-]{36}$/)
  const last = seen.at(-1)
  assert.equal(last.events.at(-1).type, 'turn/end')
  assert.equal(last.events.find((event) => event.type === 'assistant/message').data.message.content[0].text, 'echo: hello')
  assert.equal(seen.some((view) => view.events.some((event) => event.type === 'user/message')), true)
  off()
  handle.dispose()
  await backend.disconnect()
})

test('SocketBackend maps list, attach, prompt, and stream over a Unix socket', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 1,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt', 'event', 'stream', 'status'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'list') {
      write(socket, { type: 'sessions', sessions: [{ sessionId: 's1', live: true, cwd: '/work' }] })
    } else if (message.type === 'attach') {
      write(socket, {
        type: 'attached',
        sessionId: message.sessionId,
        header: { id: message.sessionId, cwd: '/work' },
        cursor: 0,
        events: [{ type: 'user/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'old' }] } } }],
      })
    } else if (message.type === 'prompt') {
      write(socket, {
        type: 'accepted',
        sessionId: message.sessionId,
        requestId: 'r1',
        mode: 'queue',
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: { type: 'turn/start', seq: 1, data: { turn: 1 } },
      })
      write(socket, {
        type: 'stream',
        sessionId: message.sessionId,
        frame: { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: {
          type: 'assistant/message',
          seq: 2,
          data: { message: { content: [{ type: 'text', text: 'hi' }] } },
        },
      })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
      })
    }
  })
  t.after(server.close)

  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  assert.equal(backend.capabilities().createSession, false)
  assert.equal((await backend.listSessions())[0].sessionId, 's1')
  assert.equal((await backend.listWorkspaces())[0].path, '/work')

  const handle = await backend.openSession('s1')
  const seen = []
  const off = handle.subscribe((view) => seen.push(view))
  const receipt = await handle.send('hello')
  assert.equal(receipt.requestId, 'r1')
  const last = seen.at(-1)
  assert.equal(last.events.at(-1).type, 'turn/end')
  assert.equal(last.events.find((event) => event.type === 'assistant/message').seq, 2)
  assert.equal(seen.some((view) => view.streamText === 'hi'), true)
  off()
  handle.dispose()
  await backend.disconnect()
})

test('SocketBackend reports unsupported capabilities clearly', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 1,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt'],
        socketPath: 'test.sock',
        sessions: [],
      })
    }
  })
  t.after(server.close)
  const backend = new SocketBackend(server.socketPath)
  await backend.connect()
  await assert.rejects(
    backend.createSession(),
    (error) => error instanceof BackendError && error.code === 'UNSUPPORTED_CAPABILITY',
  )
  await backend.disconnect()
})
