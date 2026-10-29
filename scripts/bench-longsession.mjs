#!/usr/bin/env node
/**
 * Long-session performance benchmark (DS-007).
 *
 * Drives the real TUI (fake backend + fake terminal) against a synthetic
 * durable history, then measures the cost of consecutive streaming updates
 * and of appending one durable event, at several history sizes. Run with
 * `node scripts/bench-longsession.mjs`; numbers are wall-clock medians and
 * heap deltas, meant for before/after comparison, not absolute claims.
 */
import { EventEmitter } from 'node:events'

const { runTui } = await import('../dist/tui/app.js')
const { FakeBackend } = await import('../dist/backend/index.js')

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
  columns = 120
  rows = 40
  text = ''
  write(chunk) { this.text += chunk; return true }
}

function syntheticHistory(count) {
  const events = []
  let seq = 0
  for (let turn = 0; turn < Math.ceil(count / 5); turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({ type: 'user/message', seq: seq++, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { message: { content: [{ type: 'reasoning', text: 'thinking about it '.repeat(3) }, { type: 'text', text: `answer ${turn} with some words to lay out` }] } } })
    events.push({ type: 'tool/call', seq: seq++, data: { name: 'bash', callId: `c${turn}`, arguments: JSON.stringify({ command: `echo ${turn}`, description: 'step' }) } })
    events.push({ type: 'tool/result', seq: seq++, data: { message: { toolCallId: `c${turn}`, isError: false, content: [{ type: 'text', text: 'ok' }] } } })
    events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'completed' } } })
  }
  return events.slice(0, count)
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measure(historySize, streamFrames) {
  const backend = new FakeBackend([{ sessionId: 's1', cwd: '/work', events: [] }])
  await backend.connect()
  const handle = await backend.openSession('s1')
  // Load the history before the TUI attaches so the first render already
  // carries the full past.
  for (const event of syntheticHistory(historySize)) backend.emit('s1', event)

  const input = new FakeInput()
  const output = new FakeOutput()
  const app = runTui(backend, { cwd: '/work', resume: 's1', color: false, input, output })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const freshOutputLength = output.text.length

  // Consecutive streaming updates with a stable durable prefix.
  global.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const streamTimes = []
  for (let index = 0; index < streamFrames; index += 1) {
    const started = performance.now()
    backend.stream('s1', `token ${index} `.repeat(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    streamTimes.push(performance.now() - started)
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const heapAfter = process.memoryUsage().heapUsed

  // One durable append after the stream settles.
  const cursor = handle.snapshot().cursor
  const appendStarted = performance.now()
  backend.emit('s1', { type: 'assistant/message', seq: cursor + 1, data: { message: { content: [{ type: 'text', text: 'final answer lands' }] } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const appendMs = performance.now() - appendStarted

  input.push('\u0004')
  await app
  await backend.disconnect()

  return {
    historySize,
    streamMedianMs: Number(median(streamTimes).toFixed(2)),
    streamTotalMs: Number(streamTimes.reduce((sum, value) => sum + value, 0).toFixed(1)),
    heapDeltaKb: Math.round((heapAfter - heapBefore) / 1024),
    appendMs: Number(appendMs.toFixed(1)),
    outputKb: Math.round((output.text.length - freshOutputLength) / 1024),
  }
}

const sizes = process.argv.length > 2 ? [Number(process.argv[2])] : [1_000, 10_000, 50_000]
console.log('stream frames per run: 150')
for (const size of sizes) {
  const result = await measure(size, 150)
  console.log(JSON.stringify(result))
}
