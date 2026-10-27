import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { EventEmitter } from 'node:events'

import { FakeBackend } from '../dist/backend/index.js'
import { runTui } from '../dist/tui/app.js'
import {
  createHerdrReporter,
  readHerdrEnvironment,
  resumeCommand,
} from '../dist/tui/herdr.js'

async function withFakeHerdr(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-herdr-'))
  const socketPath = join(dir, 'herdr.sock')
  const requests = []
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        try {
          requests.push(JSON.parse(line))
        } catch {
          // ignore malformed lines
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  const binDir = join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const fakeDshell = join(binDir, 'dshell')
  await writeFile(fakeDshell, '#!/bin/sh\n')
  await chmod(fakeDshell, 0o755)
  const previous = { ...process.env }
  Object.assign(process.env, {
    PATH: `${binDir}:${previous.PATH ?? ''}`,
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: '/usr/local/bin/herdr',
  })
  delete process.env.DSHELL_NO_HERDR
  const waitFor = async (predicate) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for herdr request')
  }
  try {
    await run({ requests, socketPath, waitFor, dir })
  } finally {
    process.env = previous
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
}

test('herdr environment is only detected inside a managed pane', () => {
  assert.equal(readHerdrEnvironment({}), undefined)
  assert.equal(readHerdrEnvironment({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }), undefined)
  assert.equal(readHerdrEnvironment({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/x', DSHELL_NO_HERDR: '1' }), undefined)
  assert.deepEqual(
    readHerdrEnvironment({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/x' }),
    { paneId: 'w1:p1', socketPath: '/tmp/x' },
  )
})

test('resume command prefers dshell on PATH and falls back to node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-bin-'))
  try {
    const bin = join(dir, 'dshell')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    assert.deepEqual(resumeCommand('s1', ['/usr/bin/node', '/app/dist/bin/dshell.js'], { PATH: dir }), ['dshell', '--resume', 's1'])
    assert.deepEqual(resumeCommand('s1', ['/usr/bin/node', '/app/dist/bin/dshell.js'], { PATH: '/nonexistent' }), ['node', '/app/dist/bin/dshell.js', '--resume', 's1'])
    assert.equal(resumeCommand("bad'id", ['node', '/app/bin.js'], { PATH: dir }), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reporter sends state, session, resume argv and release over the socket', async () => {
  await withFakeHerdr(async ({ requests, waitFor }) => {
    const reporter = createHerdrReporter()
    assert.ok(reporter)
    const reportsSoFar = () => requests.filter((request) => request.method === 'pane.report_agent')
    reporter.update({ state: 'working' })
    await waitFor(() => reportsSoFar().length >= 1)
    reporter.update({ state: 'blocked', message: 'bash needs a decision' })
    await waitFor(() => reportsSoFar().length >= 2)
    reporter.session('session-1', ['node', '/app/dist/bin/dshell.js', '--resume', 'session-1'], 'idle')
    await waitFor(() => reportsSoFar().length >= 3)
    const reports = reportsSoFar()
    assert.equal(reports.at(-1).params.agent, 'dshell')
    assert.equal(reports.at(-1).params.source, 'dshell')
    assert.equal(reports.at(-1).params.pane_id, 'w1:p1')
    assert.equal(reports.at(-1).params.agent_session_id, 'session-1')
    assert.deepEqual(reports.at(-1).params.resume_argv, ['node', '/app/dist/bin/dshell.js', '--resume', 'session-1'])
    const sequences = reports.map((request) => request.params.seq)
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
    assert.ok(reports.some((request) => request.params.state === 'blocked' && /decision/.test(request.params.message)))

    reporter.release()
    await waitFor(() => requests.some((request) => request.method === 'pane.release_agent'))
    const release = requests.find((request) => request.method === 'pane.release_agent')
    assert.equal(release.params.agent, 'dshell')
  })
})

test('the TUI reports its session to herdr and releases on quit', async () => {
  await withFakeHerdr(async ({ requests, waitFor }) => {
    class FakeInput extends EventEmitter {
      isTTY = true
      setRawMode() {}
      setEncoding() {}
      resume() {}
      pause() {}
      push(chunk) { this.emit('data', chunk) }
    }
    class FakeOutput extends EventEmitter {
      isTTY = true
      columns = 100
      rows = 30
      text = ''
      write(chunk) { this.text += chunk; return true }
    }
    const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', title: 'Herdr' }])
    await backend.connect()
    const input = new FakeInput()
    const output = new FakeOutput()
    const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
    await waitFor(() => requests.some((request) => request.method === 'pane.report_agent' && request.params.agent_session_id === 's1'))
    const report = requests.find((request) => request.method === 'pane.report_agent' && request.params.agent_session_id === 's1')
    assert.equal(report.params.agent, 'dshell')
    assert.equal(report.params.state, 'idle')
    assert.deepEqual(report.params.resume_argv, ['dshell', '--resume', 's1'])
    input.push('\u0003')
    await app
    await waitFor(() => requests.some((request) => request.method === 'pane.release_agent'))
    await backend.disconnect()
  })
})
