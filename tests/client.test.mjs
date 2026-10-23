import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DshellError, HostConnection } from '../dist/client/socket-client.js'

async function socketServer(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-test-'))
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
        if (line.length === 0) continue
        handler(JSON.parse(line), socket)
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

test('handshake, list, and prompt over a Unix socket', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'prompt', 'event', 'stream', 'status', 'workspaces', 'history', 'cancel', 'steer', 'approval'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'list') {
      write(socket, { type: 'sessions', sessions: [{ sessionId: 's1', live: true }] })
    } else if (message.type === 'prompt') {
      write(socket, { type: 'accepted', sessionId: message.sessionId, requestId: 'r1', mode: 'queue' })
      write(socket, {
        type: 'event',
        sessionId: message.sessionId,
        event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } },
      })
    }
  })
  const connection = await HostConnection.connect(server.socketPath)
  t.after(async () => {
    connection.close()
    await server.close()
  })
  assert.equal(connection.welcome.protocol, 2)

  connection.send({ type: 'list' })
  const sessions = await connection.waitFor((message) => message.type === 'sessions')
  assert.equal(sessions.sessions[0].sessionId, 's1')

  connection.send({ type: 'prompt', sessionId: 's1', text: 'hello' })
  const accepted = await connection.waitFor((message) => message.type === 'accepted')
  assert.equal(accepted.requestId, 'r1')
  const end = await connection.waitFor((message) => message.type === 'event')
  assert.equal(end.event.type, 'turn/end')
})

test('handshake error is surfaced as DshellError', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type !== 'hello') return
    write(socket, {
      type: 'error',
      code: 'PROTOCOL_MISMATCH',
      message: 'expected 1',
      action: 'update',
    })
  })
  t.after(server.close)

  await assert.rejects(
    HostConnection.connect(server.socketPath),
    (error) => error instanceof DshellError && error.code === 'PROTOCOL_MISMATCH',
  )
})

test('missing socket maps to HOST_NOT_RUNNING', async () => {
  await assert.rejects(
    HostConnection.connect('/tmp/dshell-does-not-exist.sock', 1_000),
    (error) => error instanceof DshellError && error.code === 'HOST_NOT_RUNNING',
  )
})
