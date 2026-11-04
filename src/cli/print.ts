import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { stdin } from 'node:process'

import {
  SocketBackend,
  type SessionHandle,
  type SessionEvent,
  type SessionSummary,
  type SessionView,
} from '../backend/index.js'
import { DshellError } from '../client/socket-client.js'
import { isTurnEnd, turnFailed } from './output.js'

export type OutputFormat = 'text' | 'json' | 'stream-json'

export interface PrintOptions {
  prompt?: string
  sessionId?: string
  workspaceId?: string
  cwd?: string
  create?: boolean
  outputFormat: OutputFormat
  timeoutMs: number
  verbose: boolean
}

interface ResultRecord {
  type: 'result'
  sessionId: string
  requestId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timeout'
  text: string
  exitCode: number
  approvalsDenied: number
  reason?: string
  error?: { code: string; message: string; action?: string }
}

function assistantText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  const data = (event.data ?? {}) as Record<string, any>
  const message = (data.message ?? data) as Record<string, any>
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text as string)
    .join('')
}

function endReason(event: SessionEvent): string {
  const data = (event.data ?? {}) as Record<string, any>
  const reason = (data.reason ?? {}) as Record<string, any>
  return typeof reason.kind === 'string' ? reason.kind : 'completed'
}

function statusFor(reason: string): ResultRecord['status'] {
  if (reason === 'completed') return 'completed'
  if (reason === 'cancelled' || reason === 'aborted' || reason === 'interrupted') return 'cancelled'
  return 'failed'
}

async function readPrompt(options: PrintOptions, signal: AbortSignal): Promise<string> {
  if (options.prompt !== undefined) return options.prompt
  if (stdin.isTTY) {
    throw new DshellError('BAD_REQUEST', '`-p` needs a prompt argument or piped stdin')
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = []
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      signal.removeEventListener('abort', onAbort)
      stdin.pause()
    }
    const onData = (chunk: string | Buffer): void => { chunks.push(String(chunk)) }
    const onEnd = (): void => { cleanup(); resolve(chunks.join('').replace(/\r\n/g, '\n').replace(/\n+$/, '')) }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error('prompt input aborted')) }
    if (signal.aborted) { onAbort(); return }
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    stdin.resume()
  })
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Same directory after symlink resolution; null never equals anything. */
function sameDirectory(left: string | undefined, right: string | null): boolean {
  if (left === undefined || right === null) return false
  return realPathOrNull(left) === right
}

/**
 * Pick the session a one-shot prompt belongs to.
 *
 * Contract: `--session` targets an explicit session, `--new` always creates,
 * and without either, an existing session is reused only inside the current
 * working directory's workspace — a prompt run in project B must never land
 * in project A's agent just because A's session is live or newer.
 */
async function chooseSession(
  backend: SocketBackend,
  options: PrintOptions,
): Promise<{ handle: SessionHandle; created: boolean }> {
  if (options.sessionId !== undefined) {
    if (options.create === true) {
      throw new DshellError('BAD_REQUEST', '--session and --new are mutually exclusive')
    }
    if (options.cwd !== undefined || options.workspaceId !== undefined) {
      throw new DshellError(
        'BAD_REQUEST',
        '--session targets one session; --cwd/--workspace cannot re-scope it (drop them, or use --new)',
      )
    }
    return { handle: await backend.openSession(options.sessionId), created: false }
  }
  if (options.create === true) {
    if (options.cwd !== undefined && options.workspaceId !== undefined) {
      throw new DshellError('BAD_REQUEST', '--new accepts --cwd or --workspace, not both')
    }
    return {
      handle: await backend.createSession({
        ...(options.workspaceId === undefined ? { cwd: realPathOrNull(options.cwd ?? process.cwd()) ?? (() => { throw new DshellError('BAD_REQUEST', 'cannot resolve working directory') })() } : {}),
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      }),
      created: true,
    }
  }
  if (options.cwd !== undefined && options.workspaceId !== undefined) {
    throw new DshellError('BAD_REQUEST', 'choose --cwd or --workspace for the session scope, not both')
  }

  const scopePath = realPathOrNull(options.cwd ?? process.cwd())
  if (options.workspaceId === undefined && scopePath === null) {
    throw new DshellError('BAD_REQUEST', `cannot resolve the working directory: ${options.cwd ?? process.cwd()}`)
  }
  const sessions: SessionSummary[] = await backend.listSessions()
  const scoped = sessions.filter((session) => (
    options.workspaceId !== undefined
      ? session.workspaceId === options.workspaceId
      : sameDirectory(session.cwd, scopePath)
  ))
  const preferred = [...scoped].sort(
    (left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
  )[0]
  if (preferred !== undefined) {
    return { handle: await backend.openSession(preferred.sessionId), created: false }
  }
  return {
    handle: await backend.createSession({
      ...(options.workspaceId === undefined ? { cwd: realPathOrNull(options.cwd ?? process.cwd()) ?? (() => { throw new DshellError('BAD_REQUEST', 'cannot resolve working directory') })() } : {}),
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    }),
    created: true,
  }
}

/**
 * Non-interactive print mode. It shares SocketBackend and SessionHandle with
 * the TUI, but never prompts for approval: an approval request is rejected and
 * reflected in the stable exit code (5) instead of being silently allowed.
 */
export async function runPrint(socketPath: string, options: PrintOptions): Promise<number> {
  const backend = new SocketBackend(socketPath)
  let handle: SessionHandle | undefined
  let off: (() => void) | undefined
  let offDisconnect: (() => void) | undefined
  let requestId = randomUUID(), lastSeq = -1
  let timedOut = false, interrupted = false, stopped = false, ownTurn = false
  let reason = 'completed', approvalDenied = 0
  let failure: { code: string; message: string; action?: string } | undefined
  const deadline = new AbortController()
  let cancellation: Promise<void> | undefined
  const textParts: string[] = [], denied = new Set<string>()
  const emit = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
  let finish!: () => void
  const ended = new Promise<void>(resolve => { finish = resolve })
  const cancelOwned = (): void => {
    cancellation = ownTurn
      ? handle?.cancel(false, requestId).catch(() => undefined)
      : handle?.removeQueued(requestId).catch(() => undefined)
  }
  const onSigint = (): void => { interrupted = true; stopped = true; reason = 'interrupted'; deadline.abort(); cancelOwned(); finish() }
  const timer = setTimeout(() => { timedOut = true; stopped = true; reason = 'deadline exceeded'; deadline.abort(); cancelOwned(); finish() }, options.timeoutMs)
  process.on('SIGINT', onSigint)
  const check = (): void => { if (stopped) throw new Error('operation stopped') }
  const work = async (): Promise<void> => {
    const prompt = await readPrompt(options, deadline.signal)
    check()
    if (!prompt.trim()) throw new DshellError('BAD_REQUEST', 'prompt is empty')
    await backend.connect()
    if (stopped) { await backend.disconnect(); return }
    offDisconnect = backend.onDisconnect(() => {
      if (stopped) return
      failure = { code: 'HOST_NOT_RUNNING', message: 'Host disconnected during print' }
      reason = 'Host disconnected'; stopped = true; finish()
    })
    if (!backend.capabilities().turnCorrelation) throw new DshellError('UNSUPPORTED_CAPABILITY', 'print requires a Host with prompt/turn correlation', 'Restart the Host with the current dshell-host plugin.')
    const chosen = await chooseSession(backend, options)
    handle = chosen.handle
    if (stopped) { handle.dispose(); return }
    const initial = handle.snapshot()
    if (initial.status === 'running' || initial.pendingApproval || initial.pendingAsk) throw new DshellError('SESSION_ACTIVE', 'print requires an idle session; use --new or wait')
    lastSeq = initial.cursor
    if (options.outputFormat === 'stream-json') emit({ type: 'start', sessionId: handle.id, created: chosen.created })
    if (options.verbose) process.stderr.write('dshell: session ' + handle.id + (chosen.created ? ' (created)' : '') + '\n')
    off = handle.subscribe((view: SessionView) => {
      if (stopped) return
      if (view.connected === false) {
        failure = { code: 'HOST_NOT_RUNNING', message: 'Session connection closed during print' }
        reason = 'Host disconnected'; stopped = true; finish(); return
      }
      for (const event of view.events) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        const data = (event.data ?? {}) as Record<string, any>
        if (event.type === 'user/message') {
          const message = data.message ?? data
          if (message.id === requestId || message.source?.rpcId === requestId) ownTurn = true
        }
        if (!ownTurn) continue
        if (options.outputFormat === 'stream-json') emit({ type: 'event', sessionId: view.sessionId, seq: event.seq, event })
        const text = assistantText(event)
        if (text) textParts.push(text)
        if (isTurnEnd(event)) { reason = endReason(event); ownTurn = false; stopped = true; finish(); return }
      }
      if (!ownTurn) return
      if (view.pendingAsk) {
        failure = { code: 'INTERACTION_REQUIRED', message: 'This prompt requires an interactive answer; reopen it in the TUI.' }
        reason = 'interactive answer required'; stopped = true; cancelOwned(); finish(); return
      }
      if (view.pendingApproval && !denied.has(view.pendingApproval.requestId)) {
        denied.add(view.pendingApproval.requestId); approvalDenied++
        if (options.outputFormat === 'stream-json') emit({ type: 'approval', action: 'rejected', ...view.pendingApproval })
        void handle?.answerApproval(view.pendingApproval.requestId, 'rejected').catch(() => undefined)
      }
    })
    const receipt = await handle.send(prompt, { requestId, requireIdle: true })
    if (receipt.requestId !== requestId) throw new DshellError('PROTOCOL_MISMATCH', 'Host changed the submitted prompt identity')
    await ended
  }
  const task = work().catch((error: unknown) => {
    if (!timedOut && !interrupted && !stopped) {
      const value = error as { code?: string; message?: string; action?: string }
      failure = { code: value.code ?? 'INTERNAL', message: value.message ?? String(error), ...(value.action ? { action: value.action } : {}) }
      reason = failure.message
    }
    finish()
  })
  try { await Promise.race([task, ended]) }
  finally {
    clearTimeout(timer); stopped = true
    process.off('SIGINT', onSigint)
    off?.(); offDisconnect?.()
    await cancellation
    handle?.dispose()
    await backend.disconnect()
  }
  const status: ResultRecord['status'] = timedOut ? 'timeout' : interrupted ? 'cancelled' : failure ? 'failed' : statusFor(reason)
  const exitCode = timedOut ? 4 : interrupted ? 130 : failure ? (failure.code === 'INTERACTION_REQUIRED' ? 5 : 1) : approvalDenied ? 5 : status === 'completed' ? 0 : 3
  const record: ResultRecord = { type: 'result', sessionId: handle?.id ?? '', requestId, status,
    text: textParts.join('\n').trim(), exitCode, approvalsDenied: approvalDenied,
    ...(status === 'completed' ? {} : { reason }), ...(failure ? { error: failure } : {}) }
  if (options.outputFormat !== 'text') emit(record)
  else {
    if (record.text) process.stdout.write(record.text + '\n')
    if (failure) process.stderr.write(failure.code + ': ' + failure.message + '\n')
  }
  return exitCode
}
