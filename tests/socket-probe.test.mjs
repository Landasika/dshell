/**
 * Socket-path ownership probes (the DS-011 split-brain guard).
 *
 * A Host that preempts another live Host's control socket splits every client
 * across two servers; the probe must only clear a path it has positively
 * confirmed stale.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { probeSocket, prepareSocketPath } = await import('../dist/plugin/index.js')

async function tmpDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dshell-probe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function listenAt(path) {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {})
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('probeSocket classifies a live listener as connected', async (t) => {
  const dir = await tmpDir(t)
  const path = join(dir, 'live.sock')
  const server = await listenAt(path)
  t.after(() => closeServer(server))
  assert.equal(await probeSocket(path, 2_000), 'connected')
})

test('probeSocket classifies a leftover dead socket file as refused', async (t) => {
  const dir = await tmpDir(t)
  const path = join(dir, 'dead.sock')
  // close() leaves the socket file on disk; connecting to it gets ECONNREFUSED.
  await closeServer(await listenAt(path))
  assert.equal(await probeSocket(path, 2_000), 'refused')
})

test('probeSocket classifies a missing path as refused', async (t) => {
  const dir = await tmpDir(t)
  assert.equal(await probeSocket(join(dir, 'none.sock'), 2_000), 'refused')
})

test('prepareSocketPath refuses to replace a socket a live host answers on', async (t) => {
  const dir = await tmpDir(t)
  const path = join(dir, 'live.sock')
  const server = await listenAt(path)
  t.after(() => closeServer(server))
  await assert.rejects(prepareSocketPath(path), /already listening/)
  assert.equal(existsSync(path), true)
})

test('prepareSocketPath removes a stale socket file when the probe refuses', async (t) => {
  const dir = await tmpDir(t)
  const path = join(dir, 'dead.sock')
  await closeServer(await listenAt(path))
  await prepareSocketPath(path, async () => 'refused')
  assert.equal(existsSync(path), false)
})

test('prepareSocketPath refuses to preempt when the probe is inconclusive', async (t) => {
  const dir = await tmpDir(t)
  const path = join(dir, 'busy.sock')
  const server = await listenAt(path)
  t.after(() => closeServer(server))
  // A busy Host may accept too slowly to confirm either way; the only safe
  // move is to keep the file and refuse to bind.
  await assert.rejects(prepareSocketPath(path, async () => 'unknown'), /refusing to replace/)
  assert.equal(existsSync(path), true)
})

test('prepareSocketPath leaves a missing path alone without probing', async (t) => {
  const dir = await tmpDir(t)
  let probed = 0
  await prepareSocketPath(join(dir, 'none.sock'), async () => {
    probed += 1
    return 'refused'
  })
  assert.equal(probed, 0)
})
