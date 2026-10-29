import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DshellError, HostConnection } from '../dist/client/socket-client.js'

const STASH_LIMIT = 4096

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

test('a command error rejects the pending waiter immediately', async (t) => {
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'models'],
        socketPath: 'test.sock',
        sessions: [],
      })
    } else if (message.type === 'model/select') {
      write(socket, {
        type: 'error',
        code: 'INTERNAL',
        message: 'provider "x" model "y" does not support reasoning effort "off"',
        action: 'pick another level',
      })
    }
  })
  const connection = await HostConnection.connect(server.socketPath)
  t.after(async () => {
    connection.close()
    await server.close()
  })

  const started = Date.now()
  connection.send({ type: 'model/select', sessionId: 's1', provider: 'x', model: 'y', reasoningEffort: 'off' })
  await assert.rejects(
    connection.waitFor((message) => message.type === 'model-selected', 20_000),
    (error) =>
      error instanceof DshellError &&
      error.code === 'INTERNAL' &&
      /does not support reasoning effort/.test(error.message) &&
      error.action === 'pick another level',
  )
  // The rejection is immediate; the 20s waiter timeout never fires.
  assert.equal(Date.now() - started < 2_000, true)
})

test('missing socket maps to HOST_NOT_RUNNING', async () => {
  await assert.rejects(
    HostConnection.connect('/tmp/dshell-does-not-exist.sock', 1_000),
    (error) => error instanceof DshellError && error.code === 'HOST_NOT_RUNNING',
  )
})

test('broadcast floods do not grow the stash and replies survive until claimed (DS-005)', async (t) => {
  const sockets = new Set()
  let broadcaster
  const server = await socketServer((message, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list', 'attach', 'event', 'stream', 'status'],
        socketPath: 'test.sock',
        sessions: [],
      })
      broadcaster = socket
    }
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await server.close()
  })

  // A subscriber-driven connection (the TUI's session view) never stashes.
  const view = await HostConnection.connect(server.socketPath)
  view.setBroadcastOnly()
  const seen = []
  view.onMessage((message) => seen.push(message.type))
  for (let index = 0; index < 10_000; index += 1) {
    write(broadcaster, { type: 'stream', sessionId: 's1', frame: { i: index } })
    if (index % 100 === 0) write(broadcaster, { type: 'event', sessionId: 's1', event: { type: 'user/message', seq: index, data: {} } })
    if (index % 250 === 0) write(broadcaster, { type: 'status', sessionId: 's1', status: 'running' })
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(seen.filter((type) => type === 'stream').length, 10_000)
  assert.ok(seen.filter((type) => type === 'event').length >= 39)
  assert.ok(seen.includes('status'))
  assert.equal(view.stashSize, 0, 'broadcasts must not be stashed on a broadcast-only connection')
  view.close()

  // A reply-minded connection still stashes what lands before waitFor, and
  // the stash is bounded even if a hostile host floods it.
  const hoarder = await HostConnection.connect(server.socketPath)
  for (let index = 0; index < STASH_LIMIT + 200; index += 1) {
    write(broadcaster, { type: 'pong', time: index })
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(hoarder.stashSize, STASH_LIMIT)
  const pong = await hoarder.waitFor((candidate) => candidate.type === 'pong', 500)
  assert.equal(typeof pong.time, 'number')
  hoarder.close()
})

test('waiters are released when the connection drops mid-flood', async (t) => {
  let broadcaster
  const server = await socketServer((message, socket) => {
    if (message.type === 'hello') {
      write(socket, {
        type: 'welcome',
        protocol: 2,
        pluginVersion: 'test',
        dshVersion: 'test',
        capabilities: ['list'],
        socketPath: 'test.sock',
        sessions: [],
      })
      broadcaster = socket
    }
  })
  t.after(server.close)
  const connection = await HostConnection.connect(server.socketPath)
  const pending = connection.waitFor((candidate) => candidate.type === 'sessions', 5_000)
  broadcaster.destroy()
  await assert.rejects(pending, /closed|HOST/i)
  connection.close()
})
