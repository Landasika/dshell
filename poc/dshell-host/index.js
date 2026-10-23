import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

export const name = 'dshell-host'
export const inject = ['agents', 'sessions', 'sessionQuery']

const PROTOCOL = 1

function jsonLine(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const socketPath = resolve(config.socketPath ?? join(home, 'run', 'dshell.sock'))
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })

  try {
    unlinkSync(socketPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  /** @type {Set<import('node:net').Socket>} */
  const clients = new Set()
  /** @type {Map<import('node:net').Socket, string>} */
  const attached = new Map()
  /** @type {Map<string, { agent: unknown, dispose: () => Promise<void> }>} */
  const handles = new Map()

  async function liveAgent(sessionId) {
    const existing = ctx.agents.get(sessionId)
    if (existing !== undefined) return existing

    const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
    handles.set(sessionId, handle)
    return handle.agent
  }

  async function listSessions() {
    const records = await ctx.sessionQuery.listSessions()
    return records.map((record) => ({
      sessionId: record.header.id,
      cwd: record.header.cwd,
      createdAt: record.header.createdAt,
      live: record.live,
      persisted: record.persisted,
      formatStatus: record.formatStatus,
    }))
  }

  async function attach(socket, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      jsonLine(socket, { type: 'error', code: 'bad-session', message: 'attach requires a sessionId' })
      return
    }

    await liveAgent(sessionId)
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    attached.set(socket, sessionId)
    jsonLine(socket, {
      type: 'attached',
      sessionId,
      header: snapshot.session,
      cursor: snapshot.events.at(-1)?.seq ?? 0,
      events: snapshot.events,
    })
  }

  async function prompt(socket, message) {
    const sessionId = message.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      jsonLine(socket, { type: 'error', code: 'bad-session', message: 'prompt requires a sessionId' })
      return
    }
    if (typeof message.text !== 'string' || message.text.length === 0) {
      jsonLine(socket, { type: 'error', code: 'bad-prompt', message: 'prompt requires non-empty text' })
      return
    }

    const agent = await liveAgent(sessionId)
    // A prompt is also an attachment: the caller wants the resulting events.
    attached.set(socket, sessionId)
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `dshell-${randomUUID()}`

    // Acknowledge before waking the Agent: followup() may synchronously emit
    // turn/start, and the client should see `accepted` before those events.
    jsonLine(socket, { type: 'accepted', sessionId, requestId, mode: message.mode ?? 'queue' })

    agent.followup({
      id: requestId,
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    })
  }

  async function handleLine(socket, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      jsonLine(socket, { type: 'error', code: 'bad-json', message: 'message is not valid JSON' })
      return
    }

    try {
      switch (message.type) {
        case 'hello':
          jsonLine(socket, {
            type: 'welcome',
            protocol: PROTOCOL,
            socketPath,
            sessions: await listSessions(),
          })
          break
        case 'list':
          jsonLine(socket, { type: 'sessions', sessions: await listSessions() })
          break
        case 'attach':
          await attach(socket, message.sessionId)
          break
        case 'detach':
          attached.delete(socket)
          jsonLine(socket, { type: 'detached' })
          break
        case 'prompt':
          await prompt(socket, message)
          break
        default:
          jsonLine(socket, { type: 'error', code: 'bad-type', message: `unknown message type: ${String(message.type)}` })
      }
    } catch (error) {
      jsonLine(socket, { type: 'error', code: 'internal', message: errorMessage(error) })
    }
  }

  const server = createServer((socket) => {
    clients.add(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket })
    lines.on('line', (line) => {
      if (line.trim().length > 0) void handleLine(socket, line)
    })
    const cleanup = () => {
      clients.delete(socket)
      attached.delete(socket)
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.on('error', (error) => {
    console.error(`[dshell-host] socket error: ${errorMessage(error)}`)
  })

  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== session.id) continue
      jsonLine(socket, { type: 'event', sessionId, event })
    }
  })

  const disposeAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== agent.id) continue
      jsonLine(socket, { type: 'stream', sessionId, frame })
    }
  })

  const disposeAgentStatus = ctx.on('agent/status', ({ agent, status }) => {
    for (const [socket, sessionId] of attached) {
      if (sessionId !== agent.id) continue
      jsonLine(socket, { type: 'status', sessionId, status })
    }
  })

  ctx.effect(() => {
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600)
      console.error(`[dshell-host] listening on ${socketPath}`)
    })

    return async () => {
      disposeSessionEvent()
      disposeAssistantStream()
      disposeAgentStatus()
      for (const socket of clients) socket.destroy()
      clients.clear()
      attached.clear()
      await new Promise((resolveClose) => server.close(resolveClose))
      for (const handle of handles.values()) await handle.dispose().catch(() => {})
      handles.clear()
      try {
        unlinkSync(socketPath)
      } catch {
        // already gone
      }
    }
  })
}
