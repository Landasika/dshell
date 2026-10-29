import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function write(socket, message) {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // the CLI may exit immediately after reading its result
  }
}

async function fakeHost({ approval = false, silent = false, sessions = [{ cwd: process.cwd(), updatedAt: 9 }] } = {}) {
  const hostSessions = sessions
  const createdCwd = new Map()
  let created = 0
  function sessionCwd(sessionId) {
    if (sessionId.startsWith('created-')) return createdCwd.get(sessionId) ?? process.cwd()
    const index = Number(sessionId.slice(1)) - 1
    return hostSessions[index]?.cwd ?? process.cwd()
  }

  const directory = await mkdtemp(join(tmpdir(), 'dshell-print-'))
  const socketPath = join(directory, 'dshell.sock')
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
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
        const message = JSON.parse(line)
        if (message.type === 'hello') {
          write(socket, {
            type: 'welcome',
            protocol: 2,
            pluginVersion: 'test',
            dshVersion: 'test',
            capabilities: ['list', 'attach', 'prompt', 'event', 'stream', 'status'],
            socketPath: 'test.sock',
            sessions: [],
            workspaces: [],
          })
        } else if (message.type === 'session/list') {
          write(socket, { type: 'sessions', sessions: hostSessions.map((entry, index) => ({ sessionId: `s${index + 1}`, live: true, ...entry })) })
        } else if (message.type === 'attach') {
          write(socket, {
            type: 'attached',
            sessionId: message.sessionId,
            header: { id: message.sessionId, cwd: sessionCwd(message.sessionId) },
            cursor: -1,
            events: [],
          })
        } else if (message.type === 'session/create') {
          created += 1
          const sessionId = `created-${created}`
          createdCwd.set(sessionId, message.cwd ?? process.cwd())
          write(socket, {
            type: 'session-created',
            sessionId,
            header: { id: sessionId, cwd: message.cwd ?? process.cwd() },
            workspaceId: `workspace:${message.cwd ?? process.cwd()}`,
          })
        } else if (message.type === 'prompt') {
          write(socket, { type: 'accepted', sessionId: message.sessionId, requestId: 'r1', mode: 'queue' })
          if (approval) {
            write(socket, {
              type: 'approval-request',
              sessionId: message.sessionId,
              requestId: 'a1',
              toolName: 'bash',
              reason: 'test',
            })
          } else if (!silent) {
            write(socket, { type: 'event', sessionId: message.sessionId, event: { type: 'turn/start', seq: 0, data: {} } })
            write(socket, {
              type: 'event',
              sessionId: message.sessionId,
              event: {
                type: 'assistant/message',
                seq: 1,
                data: { message: { content: [{ type: 'text', text: `PRINT_OK_${message.sessionId}` }] } },
              },
            })
            write(socket, {
              type: 'event',
              sessionId: message.sessionId,
              event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
            })
          }
        } else if (message.type === 'approval/answer') {
          write(socket, {
            type: 'approval-resolved',
            sessionId: 's1',
            requestId: message.requestId,
            outcome: message.outcome,
            source: 'cli',
          })
          write(socket, {
            type: 'event',
            sessionId: 's1',
            event: { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: 'denied' }], isError: true } } },
          })
          write(socket, {
            type: 'event',
            sessionId: 's1',
            event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'failed' } } },
          })
        }
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

async function runCli(socketPath, args, input) {
  const child = spawn(process.execPath, ['dist/bin/dshell.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DSHELL_SOCKET: socketPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  if (input !== undefined) child.stdin.end(input)
  else child.stdin.end()
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, stdout, stderr }
}

test('print mode emits clean text and stable exit 0', async (t) => {
  const host = await fakeHost()
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello'])
  assert.equal(result.code, 0)
  assert.match(result.stdout.trim(), /^PRINT_OK_s\d+$/)
  assert.ok(!result.stdout.includes('"type"'))
})

test('print mode emits parseable JSON', async (t) => {
  const host = await fakeHost()
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello', '--json'])
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.type, 'result')
  assert.equal(parsed.status, 'completed')
  assert.match(parsed.text, /^PRINT_OK_s\d+$/)
  assert.equal(parsed.exitCode, 0)
})

test('print mode stream-json is one JSON value per line', async (t) => {
  const host = await fakeHost()
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello', '--output-format', 'stream-json'])
  assert.equal(result.code, 0)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.every((line) => typeof JSON.parse(line) === 'object'), true)
  assert.equal(lines[0].includes('"type":"start"'), true)
  assert.equal(JSON.parse(lines.at(-1)).type, 'result')
})

test('print mode reads stdin and fails closed on approval with exit 5', async (t) => {
  const host = await fakeHost({ approval: true })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p'], 'please run\n')
  assert.equal(result.code, 5, result.stderr)
  assert.equal(result.stdout.trim(), '')
  const json = await runCli(host.socketPath, ['-p', '--json'], 'please run\n')
  assert.equal(json.code, 5)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.approvalsDenied, 1)
  assert.equal(parsed.exitCode, 5)
})

test('print mode timeout returns exit 4 instead of hanging', async (t) => {
  const host = await fakeHost({ silent: true })
  t.after(host.close)
  const started = Date.now()
  const result = await runCli(host.socketPath, ['-p', 'hello', '--json', '--timeout', '150'])
  assert.equal(result.code, 4)
  assert.ok(Date.now() - started < 5_000)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.status, 'timeout')
  assert.equal(parsed.exitCode, 4)
})

test('-p never reuses a live session from another project (DS-003)', async (t) => {
  const host = await fakeHost({
    sessions: [
      { cwd: '/project-a', updatedAt: 99 }, // live, newest, WRONG project
      { cwd: process.cwd(), updatedAt: 5 }, // older, but ours
    ],
  })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'PRINT_OK_s2')
})

test('-p reuses the most recently updated session of this project (DS-003)', async (t) => {
  const host = await fakeHost({
    sessions: [
      { cwd: process.cwd(), updatedAt: 4 },
      { cwd: process.cwd(), updatedAt: 8 },
    ],
  })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'PRINT_OK_s2')
})

test('-p with no matching session creates one instead of borrowing (DS-003)', async (t) => {
  const host = await fakeHost({ sessions: [{ cwd: '/project-a', updatedAt: 99 }] })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'PRINT_OK_created-1')
})

test('--session targets the explicit session, even from another project (DS-003)', async (t) => {
  const host = await fakeHost({ sessions: [{ cwd: '/project-a', updatedAt: 99 }] })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello', '--session', 's1'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'PRINT_OK_s1')
})

test('conflicting session flags fail loudly instead of being ignored (DS-003)', async (t) => {
  const host = await fakeHost()
  t.after(host.close)
  const cases = [
    [['--session', 's1', '--new']],
    [['--session', 's1', '--cwd', '/tmp']],
    [['--session', 's1', '--workspace', 'workspace:x']],
    [['--new', '--cwd', '/tmp', '--workspace', 'workspace:x']],
  ]
  for (const [extra] of cases) {
    const result = await runCli(host.socketPath, ['-p', 'hello', ...extra])
    assert.notEqual(result.code, 0, `expected failure for ${extra.join(' ')}`)
    assert.match(result.stderr, /mutually exclusive|cannot re-scope|not both/i)
  }
})

test('--new always creates in the requested directory (DS-003)', async (t) => {
  const host = await fakeHost({ sessions: [{ cwd: process.cwd(), updatedAt: 99 }] })
  t.after(host.close)
  const result = await runCli(host.socketPath, ['-p', 'hello', '--new', '--cwd', '/project-b'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'PRINT_OK_created-1')
})
