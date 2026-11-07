import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import { FrameParser, OPCODE, WebSocketChannel } from '../dist/plugin/websocket.js'
import { UnixSocketChannel } from '../dist/plugin/channel.js'
import { acquireFileLock } from '../dist/plugin/file-lock.js'

function frame(text, opcode, fin = true) {
  const payload = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  return Buffer.concat([Buffer.from([(fin ? 128 : 0) | opcode, 128 | payload.length]), mask,
    Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))])
}

test('audit: fragmented messages enforce a cumulative limit including incomplete final frames', () => {
  const messages = []
  const parser = new FrameParser({ maxPayloadBytes: 8, onMessage: text => messages.push(text) })
  parser.push(frame('abcd', OPCODE.TEXT, false))
  parser.push(frame('efgh', OPCODE.CONTINUATION, false))
  assert.throws(() => parser.push(frame('i', OPCODE.CONTINUATION).subarray(0, 2)), /message exceeds/)
  assert.deepEqual(messages, [])
  const valid = new FrameParser({ maxPayloadBytes: 8, onMessage: text => messages.push(text) })
  valid.push(Buffer.concat([frame('abcd', OPCODE.TEXT, false), frame('ping', OPCODE.PING), frame('efgh', OPCODE.CONTINUATION)]))
  assert.deepEqual(messages, ['abcdefgh'])
})

test('audit: close frames stop parsing and interleaved data cannot overwrite an open message', () => {
  const messages = []
  const parser = new FrameParser({ onMessage: text => messages.push(text) })
  parser.push(Buffer.concat([frame('', OPCODE.CLOSE), frame('after close', OPCODE.TEXT)]))
  assert.deepEqual(messages, [])
  const fragmented = new FrameParser()
  fragmented.push(frame('start', OPCODE.TEXT, false))
  assert.throws(() => fragmented.push(frame('replacement', OPCODE.TEXT)), /fragmented message/)
})

for (const Channel of [UnixSocketChannel, WebSocketChannel]) {
  test(`audit: ${Channel.name} disconnects stalled readers and cleans up exactly once`, async () => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, _done) {} })
    const channel = new Channel(socket)
    let closes = 0
    channel.onClose = () => { closes += 1 }
    channel.write({ text: 'x'.repeat(17 * 1024 * 1024) })
    channel.write({ text: 'overflow' })
    channel.close()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(channel.alive, false)
    assert.equal(socket.destroyed, true)
    assert.equal(closes, 1)
  })
}

test('audit: configuration locks recover dead writers and legacy locks, and retain live owners', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dshell-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.lock')
  await writeFile(path, JSON.stringify({ pid: 2147483647 }))
  const release = acquireFileLock(path)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid)
  assert.throws(() => acquireFileLock(path), /being edited/)
  release()
  await assert.rejects(stat(path), { code: 'ENOENT' })
  await writeFile(path, '')
  await utimes(path, new Date(0), new Date(0))
  acquireFileLock(path)()
  await assert.rejects(stat(path), { code: 'ENOENT' })
  await writeFile(path, '')
  assert.throws(() => acquireFileLock(path), /being edited/, 'a new empty lock may still be initializing')
})
