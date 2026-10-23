#!/usr/bin/env node
/**
 * dshell P0 probe: authenticated Node client for a running `dsh --profile web` Host.
 *
 * Usage:
 *   DSH_URL_FILE=../.p0/url node p0-client.mjs connect
 *   DSH_URL_FILE=../.p0/url node p0-client.mjs list
 *   DSH_URL_FILE=../.p0/url node p0-client.mjs create [cwd]
 *   DSH_URL_FILE=../.p0/url P0_APPROVAL=allow node p0-client.mjs prompt <sessionId>
 *   DSH_URL_FILE=../.p0/url node p0-client.mjs reconnect
 *   DSH_URL_FILE=../.p0/url node p0-client.mjs none <sessionId>
 *
 * This is deliberately a probe, not the P2 adapter. It records raw wire shapes.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3099'
const URL_FILE = process.env.DSH_URL_FILE ?? new URL('../.p0/url', import.meta.url).pathname

function launchUrl() {
  const raw = readFileSync(URL_FILE, 'utf8').trim()
  const url = new URL(raw)
  const token = url.searchParams.get('token')
  if (token === null || token.length === 0) throw new Error(`no token in ${URL_FILE}`)
  return { url, token }
}

class Stream {
  constructor(endpoint) {
    this.endpoint = endpoint
    this.messages = []
    this.waiters = []
    this.ended = false
    this.error = null
  }

  push(message) {
    this.messages.push(message)
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.predicate(message)) return true
      waiter.resolve(message)
      return false
    })
  }

  fail(error) {
    this.error = error
    this.ended = true
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters = []
  }

  end() {
    this.ended = true
    for (const waiter of this.waiters) waiter.reject(new Error(`${this.endpoint} ended`))
    this.waiters = []
  }

  once(predicate, timeoutMs = 30_000) {
    for (const message of this.messages) {
      if (predicate(message)) return Promise.resolve(message)
    }
    if (this.error !== null) return Promise.reject(this.error)
    if (this.ended) return Promise.reject(new Error(`${this.endpoint} already ended`))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve)
        reject(new Error(`timeout waiting on ${this.endpoint}`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (message) => { clearTimeout(timer); resolve(message) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }
}

class P0Client {
  constructor(options = {}) {
    this.cookie = ''
    this.ws = undefined
    this.nextStream = 1
    this.streams = new Map()
    this.clientId = undefined
    this.approvalMode = options.approvalMode ?? 'allow'
    this.approvalCount = 0
    this.frames = []
  }

  async connect(interactions = 'answer') {
    const { token } = launchUrl()
    const response = await fetch(
      `${BASE}/connect?token=${encodeURIComponent(token)}&interactions=${interactions}`,
      { redirect: 'manual' },
    )
    if (response.status !== 302) {
      throw new Error(`/connect returned HTTP ${response.status}: ${await response.text()}`)
    }
    const setCookies = response.headers.getSetCookie()
    if (setCookies.length === 0) throw new Error('/connect did not set a cookie')
    this.cookie = setCookies[0].split(';', 1)[0]
    return { cookieLength: this.cookie.length }
  }

  async openSocket() {
    if (this.cookie === '') throw new Error('connect() first')
    const wsUrl = BASE.replace(/^http/, 'ws') + '/api/remote.mux'
    this.ws = new WebSocket(wsUrl, { headers: { cookie: this.cookie } })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000)
      this.ws.once('open', () => { clearTimeout(timer); resolve() })
      this.ws.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    this.ws.on('message', (data) => this.onMessage(data.toString()))
    this.ws.on('close', () => {
      for (const stream of this.streams.values()) stream.end()
    })
  }

  async openEvents() {
    await this.openSocket()
    const events = this.openStream('$events', {})
    const ready = await events.once((message) => message.value?.type === 'ready', 15_000)
    this.clientId = ready.value.clientId
    return ready.value
  }

  onMessage(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      console.error('[ws] non-JSON frame', text.slice(0, 200))
      return
    }
    this.frames.push(frame)
    if (frame.type === 'waterfall') {
      void this.handleWaterfall(frame)
      return
    }
    if (frame.type === 'emit') {
      console.log(`[emit] event=${frame.event} resources=${JSON.stringify(frame.resources)}`)
      return
    }
    if (frame.type === 'cancel') {
      console.log(`[waterfall] cancel eventId=${frame.eventId}`)
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (stream === undefined) {
      console.error('[ws] unknown stream', frame.streamId)
      return
    }
    if (frame.type === 'item') {
      const value = frame.value
      console.log(`[item] endpoint=${stream.endpoint} valueType=${value?.type ?? '?'} event=${value?.event ?? ''}`)
      if (value?.type === 'waterfall') {
        this.frames.push(value)
        void this.handleWaterfall(value)
        return
      }
      if (value?.type === 'emit') {
        this.frames.push(value)
        return
      }
      if (value?.type === 'cancel') {
        this.frames.push(value)
        console.log(`[waterfall] cancel eventId=${value.eventId}`)
        return
      }
      stream.push(frame)
    }
    else if (frame.type === 'error') stream.fail(new Error(`${stream.endpoint}: ${JSON.stringify(frame.error)}`))
    else if (frame.type === 'end') stream.end()
  }

  async handleWaterfall(frame) {
    this.approvalCount += 1
    const summary = JSON.stringify(frame.request)
    console.log(`[waterfall] event=${frame.event} eventId=${frame.eventId} agentId=${frame.agentId} request=${summary.slice(0, 600)}`)
    try {
      if (frame.event === 'approval/request' && this.approvalMode !== 'manual') {
        const value = this.approvalMode === 'reject' ? 'rejected' : 'allowed-once'
        await this.rpc('$events/result', {
          clientId: this.clientId,
          eventId: frame.eventId,
          outcome: { kind: 'result', value },
        })
        console.log(`[waterfall] approval answered ${value}`)
      } else if (frame.event !== 'approval/request') {
        await this.rpc('$events/result', {
          clientId: this.clientId,
          eventId: frame.eventId,
          outcome: { kind: 'next' },
        })
        console.log('[waterfall] delegated next (no handler)')
      }
    } catch (error) {
      console.error('[waterfall] answer failed', error)
    }
  }

  openStream(endpoint, args) {
    const streamId = `s${this.nextStream++}`
    const stream = new Stream(endpoint)
    this.streams.set(streamId, stream)
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    return stream
  }

  async rpc(method, args) {
    const rpcId = randomUUID()
    const response = await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`)
    const envelope = JSON.parse(text)
    if (envelope.rpcId !== rpcId) throw new Error(`${method}: rpcId mismatch`)
    if (envelope.result?.ok !== true) {
      throw new Error(`${method}: ${JSON.stringify(envelope.result?.error)}`)
    }
    return envelope.result.value
  }

  async waitForFrame(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = this.frames.find(predicate)
      if (frame !== undefined) return frame
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`timeout waiting for frame on client ${this.clientId ?? '?'}`)
  }

  async close() {
    if (this.ws === undefined) return
    const closing = this.ws
    this.ws = undefined
    if (closing.readyState === WebSocket.CLOSED) return
    await new Promise((resolve) => {
      closing.once('close', resolve)
      closing.close()
      setTimeout(resolve, 2_000)
    })
  }
}

function summarizeEvent(event) {
  const text = JSON.stringify(event.data)
  return `seq=${event.seq} type=${event.type} data=${text.length > 240 ? text.slice(0, 240) + '…' : text}`
}

async function connectAndOpen(client, interactions = 'answer') {
  const auth = await client.connect(interactions)
  console.log(`[connect] interactions=${interactions} ok cookieLength=${auth.cookieLength}`)
  if (interactions === 'none') return undefined
  const ready = await client.openEvents()
  console.log(`[events] ready clientId=${ready.clientId} home=${ready.host.home}`)
  return ready
}

async function main() {
  const command = process.argv[2] ?? 'connect'
  const approvalMode = process.env.P0_APPROVAL ?? 'manual'
  const client = new P0Client({ approvalMode })

  try {
    if (command === 'watch') {
      await connectAndOpen(client, 'none')
      await client.openSocket()
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('watch requires a sessionId')
      const seconds = Number(process.argv[4] ?? 20)
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50 },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[watch] none client holding session=${sessionId} cursor=${snapshot.value.cursor} for ${seconds}s`)
      await new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
      console.log('[watch] done')
      return
    }

    if (command === 'none-prompt') {
      await connectAndOpen(client, 'none')
      await client.openSocket()
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('none-prompt requires a sessionId')
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[none-prompt] snapshot cursor=${snapshot.value.cursor}`)
      const requestId = `p0-${randomUUID()}`
      await client.rpc('session/prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: process.env.P0_PROMPT ?? 'Use the bash tool with sandbox_permissions set to danger-full-access and justification P0 none test to run: echo P0_NONE_SHOULD_NOT_RUN' }],
        },
      })
      console.log('[none-prompt] accepted')
      const deadline = Date.now() + 90_000
      let lastSeq = snapshot.value.cursor
      while (Date.now() < deadline) {
        const next = follow.messages.find((message) => {
          const value = message.value
          return value?.type === 'event' && value.event.seq > lastSeq
        })
        if (next === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        lastSeq = next.value.event.seq
        console.log(`[none-prompt] ${summarizeEvent(next.value.event)}`)
        if (next.value.event.type === 'turn/end' || next.value.event.type === 'turn/failed') break
      }
      return
    }

    if (command === 'none') {
      await connectAndOpen(client, 'none')
      await client.openSocket()
      const events = client.openStream('$events', {})
      try {
        await events.once(() => true, 3_000)
        console.log('[none] $events unexpectedly accepted')
      } catch (error) {
        console.log(`[none] $events rejected: ${error.message}`)
      }
      const sessionId = process.argv[3]
      if (sessionId !== undefined) {
        const follow = client.openStream('session/follow', {
          request: { address: { kind: 'session', sessionId }, maxMessages: 20 },
        })
        const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
        console.log(`[none] session/follow snapshot records=${snapshot.value.records.length}`)
      }
      return
    }

    await connectAndOpen(client, 'answer')

    if (command === 'connect') {
      const sessions = await client.rpc('session/list', { _request: {} })
      console.log(`[session/list] items=${sessions.items.length}`)
      const workspace = client.openStream('workspace/follow', {})
      const baseline = await workspace.once((message) => message.value?.type === 'baseline', 10_000)
      console.log(`[workspace/follow] baseline items=${baseline.value.value.items.length}`)
    } else if (command === 'list') {
      const sessions = await client.rpc('session/list', { _request: {} })
      console.log(JSON.stringify(sessions, null, 2))
    } else if (command === 'create') {
      const cwd = process.argv[3] ?? new URL('../.p0/work', import.meta.url).pathname
      const created = await client.rpc('session/create', { request: { cwd } })
      console.log(JSON.stringify(created, null, 2))
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      console.log(`[frames] ${client.frames.map((frame) => `${frame.type}:${frame.event ?? ''}`).join(', ')}`)
    } else if (command === 'prompt') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('prompt requires a sessionId')
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[follow] snapshot records=${snapshot.value.records.length} cursor=${snapshot.value.cursor} hasMore=${snapshot.value.hasMore}`)

      const requestId = `p0-${randomUUID()}`
      const prompt = await client.rpc('session/prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: process.env.P0_PROMPT ?? 'Reply with exactly P0_OK and nothing else.' }],
        },
      })
      console.log(`[prompt] accepted=${JSON.stringify(prompt)}`)

      const deadline = Date.now() + 120_000
      let lastSeq = snapshot.value.cursor
      while (Date.now() < deadline) {
        const next = follow.messages.find((message) => {
          const value = message.value
          return value?.type === 'event' && value.event.seq > lastSeq
        })
        if (next === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        lastSeq = next.value.event.seq
        console.log(`[event] ${summarizeEvent(next.value.event)}`)
        if (next.value.event.type === 'turn/end' || next.value.event.type === 'turn/failed') break
      }

      const page = await client.rpc('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq: lastSeq, maxMessages: 20 },
      })
      console.log(`[page] records=${page.records.length} hasMore=${page.hasMore}`)
      const assistant = [...page.records].reverse().find((record) => record.event.type === 'assistant/message')
      console.log(`[assistant] ${assistant === undefined ? 'none' : JSON.stringify(assistant.event.data).slice(0, 800)}`)
      console.log(`[approvals] count=${client.approvalCount}`)
    } else if (command === 'workspace') {
      const path = process.argv[3] ?? new URL('../.p0/ws', import.meta.url).pathname
      const created = await client.rpc('workspace/create', { request: { path } })
      console.log(`[workspace/create] ${JSON.stringify(created)}`)
      const follow = client.openStream('workspace/follow', {})
      const baseline = await follow.once((message) => message.value?.type === 'baseline', 10_000)
      console.log(`[workspace/follow] baseline items=${baseline.value.value.items.length}`)
      const session = await client.rpc('session/create', { request: { workspaceId: created.workspace.workspaceId } })
      console.log(`[session/create] ${JSON.stringify(session)}`)
      const upsert = await follow.once(
        (message) => message.value?.type === 'upsert' && message.value.workspace.workspaceId === created.workspace.workspaceId,
        10_000,
      )
      console.log(`[workspace/follow] upsert sessionIds=${JSON.stringify(upsert.value.workspace.sessionIds)}`)
    } else if (command === 'cancel-task') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('cancel-task requires a sessionId')
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50 },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[cancel-task] snapshot cursor=${snapshot.value.cursor}`)
      await client.rpc('session/prompt', {
        request: {
          requestId: `p0-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: 'Use the bash tool to run exactly: sleep 30; echo P0_CANCEL_SHOULD_NOT_RUN. Do not use any other tool.' }],
        },
      })
      console.log('[cancel-task] prompt accepted; waiting for tool/call')
      const call = await follow.once(
        (message) => message.value?.type === 'event' && message.value.event.type === 'tool/call',
        60_000,
      )
      console.log(`[cancel-task] tool/call seq=${call.value.event.seq}; cancelling`)
      const cancelled = await client.rpc('session/cancel', { request: { sessionId } })
      console.log(`[cancel-task] cancel=${JSON.stringify(cancelled)}`)
      let lastSeq = call.value.event.seq
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const next = follow.messages.find((message) => message.value?.type === 'event' && message.value.event.seq > lastSeq)
        if (next === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        lastSeq = next.value.event.seq
        console.log(`[cancel-task] ${summarizeEvent(next.value.event)}`)
        if (next.value.event.type === 'turn/end' || next.value.event.type === 'turn/failed') break
      }
    } else if (command === 'detach') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('detach requires a sessionId')
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[detach] snapshot cursor=${snapshot.value.cursor}`)
      const requestId = `p0-${randomUUID()}`
      await client.rpc('session/prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: process.env.P0_PROMPT ?? 'Use the bash tool to run: sleep 20; echo P0_SURVIVED' }],
        },
      })
      console.log('[detach] prompt accepted; waiting for tool/call')
      const call = await follow.once(
        (message) => message.value?.type === 'event' && message.value.event.type === 'tool/call',
        60_000,
      )
      console.log(`[detach] saw tool/call seq=${call.value.event.seq}; closing client`)
    } else if (command === 'race') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('race requires a sessionId')
      const a = new P0Client({ approvalMode: 'manual' })
      const b = new P0Client({ approvalMode: 'manual' })
      try {
        await a.connect('answer')
        await a.openEvents()
        await b.connect('answer')
        await b.openEvents()
        console.log(`[race] A=${a.clientId} B=${b.clientId}`)
        const follow = a.openStream('session/follow', {
          request: { address: { kind: 'session', sessionId }, maxMessages: 50 },
        })
        const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
        console.log(`[race] snapshot cursor=${snapshot.value.cursor}`)
        const requestId = `p0-${randomUUID()}`
        await a.rpc('session/prompt', {
          request: {
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: 'Use the bash tool with sandbox_permissions set to danger-full-access and justification P0 race test to run: echo P0_RACE_OK. Do not use any other tool.' }],
          },
        })
        console.log('[race] prompt accepted')
        const wa = await a.waitForFrame((frame) => frame.type === 'waterfall' && frame.event === 'approval/request', 60_000)
        const wb = await b.waitForFrame((frame) => frame.type === 'waterfall' && frame.event === 'approval/request', 15_000)
        console.log(`[race] A eventId=${wa.eventId} B eventId=${wb.eventId} same=${wa.eventId === wb.eventId}`)
        await a.rpc('$events/result', {
          clientId: a.clientId,
          eventId: wa.eventId,
          outcome: { kind: 'result', value: 'allowed-once' },
        })
        console.log('[race] A answered allowed-once')
        const cancel = await b.waitForFrame((frame) => frame.type === 'cancel' && frame.eventId === wa.eventId, 10_000)
        console.log(`[race] B cancel=${JSON.stringify(cancel)}`)
        let lastSeq = snapshot.value.cursor
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const next = follow.messages.find((message) => message.value?.type === 'event' && message.value.event.seq > lastSeq)
          if (next === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            continue
          }
          lastSeq = next.value.event.seq
          if (next.value.event.type === 'turn/end' || next.value.event.type === 'turn/failed') {
            console.log(`[race] ${next.value.event.type} seq=${lastSeq}`)
            break
          }
        }
      } finally {
        await a.close()
        await b.close()
      }
    } else if (command === 'page') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('page requires a sessionId')
      const list = await client.rpc('session/list', { _request: {} })
      const summary = list.items.find((item) => item.sessionId === sessionId)
      if (summary === undefined) throw new Error(`session not found: ${sessionId}`)
      const throughSeq = summary.projections.asOfSeq
      const first = await client.rpc('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 10 },
      })
      const firstSeqs = first.records.map((record) => record.event.seq)
      console.log(`[page] throughSeq=${throughSeq} records=${first.records.length} hasMore=${first.hasMore} seqs=${JSON.stringify(firstSeqs)}`)
      const beforeSeq = firstSeqs[0]
      const second = await client.rpc('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 10 },
      })
      const secondSeqs = second.records.map((record) => record.event.seq)
      const overlap = secondSeqs.filter((seq) => firstSeqs.includes(seq))
      console.log(`[page] beforeSeq=${beforeSeq} records=${second.records.length} hasMore=${second.hasMore} seqs=${JSON.stringify(secondSeqs)} overlap=${JSON.stringify(overlap)}`)
    } else if (command === 'history') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('history requires a sessionId')
      const follow = client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 200 },
      })
      const snapshot = await follow.once((message) => message.value?.type === 'snapshot', 15_000)
      console.log(`[history] records=${snapshot.value.records.length} cursor=${snapshot.value.cursor}`)
      for (const record of snapshot.value.records.slice(-12)) {
        console.log(`[history] ${summarizeEvent(record.event)}`)
      }
    } else if (command === 'cancel') {
      const sessionId = process.argv[3]
      if (sessionId === undefined) throw new Error('cancel requires a sessionId')
      const cancelled = await client.rpc('session/cancel', { request: { sessionId } })
      console.log(JSON.stringify(cancelled))
    } else if (command === 'reconnect') {
      const before = await client.rpc('session/list', { _request: {} })
      console.log(`[reconnect] before items=${before.items.length}`)
      const oldCookie = client.cookie
      await client.close()
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await client.rpc('session/list', { _request: {} })
        console.log('[reconnect] old cookie still accepted (unexpected)')
      } catch (error) {
        console.log(`[reconnect] old cookie rejected: ${error.message}`)
      }
      client.cookie = oldCookie
      const auth = await client.connect('answer')
      console.log(`[reconnect] new cookieLength=${auth.cookieLength}`)
      const ready = await client.openEvents()
      console.log(`[reconnect] ready clientId=${ready.clientId}`)
      const after = await client.rpc('session/list', { _request: {} })
      console.log(`[reconnect] after items=${after.items.length}`)
    } else {
      throw new Error(`unknown command: ${command}`)
    }
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('[fatal]', error)
  process.exitCode = 1
})
