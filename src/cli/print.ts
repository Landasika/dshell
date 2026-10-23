import { stdin } from 'node:process'

import {
  SocketBackend,
  type SessionHandle,
  type SessionSummary,
  type SessionView,
} from '../backend/index.js'
import { DshellError } from '../client/socket-client.js'
import type { SessionEvent } from '../protocol/index.js'
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

async function readPrompt(options: PrintOptions): Promise<string> {
  if (options.prompt !== undefined) return options.prompt
  if (stdin.isTTY) {
    throw new DshellError('BAD_REQUEST', '`-p` needs a prompt argument or piped stdin')
  }
  const chunks: Buffer[] = []
  stdin.setEncoding('utf8')
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

async function chooseSession(
  backend: SocketBackend,
  options: PrintOptions,
): Promise<{ handle: SessionHandle; created: boolean }> {
  if (options.sessionId !== undefined) {
    return { handle: await backend.openSession(options.sessionId), created: false }
  }
  if (options.create === true) {
    return {
      handle: await backend.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      }),
      created: true,
    }
  }
  const sessions: SessionSummary[] = await backend.listSessions()
  const sorted = [...sessions].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  const preferred = sorted.find((session) => session.live === true) ?? sorted[0]
  if (preferred !== undefined) {
    return { handle: await backend.openSession(preferred.sessionId), created: false }
  }
  return {
    handle: await backend.createSession({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
  const prompt = await readPrompt(options)
  if (prompt.trim().length === 0) {
    throw new DshellError('BAD_REQUEST', 'prompt is empty')
  }

  const backend = new SocketBackend(socketPath)
  let handle: SessionHandle | undefined
  let off: (() => void) | undefined
  let timedOut = false
  let interrupted = false
  let approvalDenied = 0
  const deniedApprovals = new Set<string>()
  let reason = 'completed'
  let lastSeq = -1
  let requestId = ''
  const textParts: string[] = []

  const emit = (record: unknown): void => {
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
  let finishTurn: (() => void) | undefined

  const onSigint = (): void => {
    interrupted = true
    void handle?.cancel().catch(() => undefined)
    finishTurn?.()
  }

  try {
    await backend.connect()
    const chosen = await chooseSession(backend, options)
    handle = chosen.handle
    const initial = handle.snapshot()
    lastSeq = initial.cursor
    if (options.outputFormat === 'stream-json') {
      emit({ type: 'start', sessionId: handle.id, created: chosen.created })
    }
    if (options.verbose) {
      process.stderr.write(`dshell: session ${handle.id}${chosen.created ? ' (created)' : ''}\n`)
    }

    let settle: (() => void) | undefined
    const ended = new Promise<void>((resolve) => {
      settle = resolve
      finishTurn = resolve
    })

    off = handle.subscribe((view: SessionView) => {
      if (view.pendingApproval !== undefined && !deniedApprovals.has(view.pendingApproval.requestId)) {
        deniedApprovals.add(view.pendingApproval.requestId)
        approvalDenied += 1
        if (options.verbose) {
          process.stderr.write(`dshell: rejecting approval for ${view.pendingApproval.toolName} (non-interactive)\n`)
        }
        if (options.outputFormat === 'stream-json') {
          emit({ type: 'approval', action: 'rejected', ...view.pendingApproval })
        }
        void handle?.answerApproval(view.pendingApproval.requestId, 'rejected').catch(() => undefined)
      }
      for (const event of view.events) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        if (options.outputFormat === 'stream-json') {
          emit({ type: 'event', sessionId: view.sessionId, seq: event.seq, event })
        }
        const text = assistantText(event)
        if (text.length > 0) textParts.push(text)
        if (isTurnEnd(event)) {
          reason = endReason(event)
          settle?.()
        }
      }
    })

    process.on('SIGINT', onSigint)
    const receipt = await handle.send(prompt)
    requestId = receipt.requestId
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            void handle?.cancel().catch(() => undefined)
            resolve()
          }, options.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } finally {
    process.off('SIGINT', onSigint)
    off?.()
    handle?.dispose()
    await backend.disconnect()
  }

  const text = textParts.join('\n').trim()
  const status: ResultRecord['status'] = timedOut
    ? 'timeout'
    : interrupted
      ? 'cancelled'
      : statusFor(reason)
  const exitCode = timedOut ? 4 : interrupted ? 130 : approvalDenied > 0 ? 5 : status === 'completed' ? 0 : 3
  const record: ResultRecord = {
    type: 'result',
    sessionId: handle?.id ?? '',
    requestId,
    status,
    text,
    exitCode,
    approvalsDenied: approvalDenied,
    ...(status === 'completed' ? {} : { reason }),
  }

  if (options.outputFormat === 'json') {
    emit(record)
  } else if (options.outputFormat === 'stream-json') {
    emit(record)
  } else if (text.length > 0) {
    process.stdout.write(`${text}\n`)
  }
  if (options.verbose) process.stderr.write(`dshell: ${status}${approvalDenied > 0 ? ' (approval denied)' : ''}\n`)
  return exitCode
}
