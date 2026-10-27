/**
 * Native Herdr integration.
 *
 * Herdr exports HERDR_ENV/HERDR_PANE_ID/HERDR_SOCKET_PATH into every pane. When
 * those are present the TUI reports its agent state, DSH session id and resume
 * command over the local socket, so Herdr's sidebar shows dshell as a
 * first-class agent and can restore the same session after a server restart.
 * Outside Herdr (or with DSHELL_NO_HERDR=1) this module is a no-op.
 */
import { accessSync, constants } from 'node:fs'
import { connect } from 'node:net'
import { basename, delimiter, join } from 'node:path'

export interface HerdrEnvironment {
  paneId: string
  socketPath: string
  binPath?: string
}

export type HerdrState = 'idle' | 'working' | 'blocked'

export interface HerdrReport {
  state: HerdrState
  message?: string
  sessionId?: string
  resumeArgv?: string[]
}

export const HERDR_SOURCE = 'dshell'
export const HERDR_AGENT = 'dshell'

/** Environment variables Herdr injects into managed pane processes. */
export function readHerdrEnvironment(env: NodeJS.ProcessEnv = process.env): HerdrEnvironment | undefined {
  if (env.DSHELL_NO_HERDR === '1') return undefined
  if (env.HERDR_ENV !== '1') return undefined
  const paneId = env.HERDR_PANE_ID
  const socketPath = env.HERDR_SOCKET_PATH
  if (paneId === undefined || paneId.length === 0) return undefined
  if (socketPath === undefined || socketPath.length === 0) return undefined
  return {
    paneId,
    socketPath,
    ...(env.HERDR_BIN_PATH === undefined ? {} : { binPath: env.HERDR_BIN_PATH }),
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `dshell` if it is on PATH, otherwise the current `node <bin>` invocation. */
export function resumeCommand(
  sessionId: string,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  if (sessionId.length === 0) return undefined
  if (/['\u0000-\u001f]/.test(sessionId)) return undefined
  const path = env.PATH ?? ''
  const hasDshell = path
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => isExecutable(join(entry, 'dshell')))
  if (hasDshell) return ['dshell', '--resume', sessionId]
  const script = argv[1]
  if (script !== undefined && script.length > 0 && basename(script).startsWith('dshell')) {
    return ['node', script, '--resume', sessionId]
  }
  return undefined
}

interface PendingReport {
  state: HerdrState
  message?: string
  sessionId?: string
  resumeArgv?: string[]
}

/**
 * Fire-and-forget reporter. At most one request is in flight; intermediate
 * states collapse into the newest one so a slow Herdr never back-pressures the
 * TUI. Failures are ignored by design.
 */
export class HerdrReporter {
  private seq = Date.now()
  private inFlight = false
  private pending: PendingReport | undefined
  private released = false

  constructor(
    private readonly environment: HerdrEnvironment,
    private readonly timeoutMs = 400,
  ) {}

  update(report: HerdrReport): void {
    if (this.released) return
    this.pending = { ...report }
    this.flush()
  }

  /** Report the new session while keeping the current semantic state. */
  session(sessionId: string, resumeArgv?: string[], state: HerdrState = 'idle'): void {
    this.update({ state, sessionId, ...(resumeArgv === undefined ? {} : { resumeArgv }) })
  }

  /** Clear the agent from the pane when the user really quits. */
  release(): void {
    if (this.released) return
    this.released = true
    this.pending = undefined
    void this.send('pane.release_agent', {
      pane_id: this.environment.paneId,
      source: HERDR_SOURCE,
      agent: HERDR_AGENT,
      seq: this.nextSeq(),
    })
  }

  private nextSeq(): number {
    const now = Date.now()
    this.seq = now > this.seq ? now : this.seq + 1
    return this.seq
  }

  private flush(): void {
    if (this.inFlight || this.pending === undefined) return
    const report = this.pending
    this.pending = undefined
    this.inFlight = true
    const params: Record<string, unknown> = {
      pane_id: this.environment.paneId,
      source: HERDR_SOURCE,
      agent: HERDR_AGENT,
      state: report.state,
      seq: this.nextSeq(),
    }
    if (report.message !== undefined && report.message.length > 0) params.message = report.message
    if (report.sessionId !== undefined) params.agent_session_id = report.sessionId
    if (report.resumeArgv !== undefined) params.resume_argv = report.resumeArgv
    void this.send('pane.report_agent', params).finally(() => {
      this.inFlight = false
      if (this.pending !== undefined && !this.released) this.flush()
    })
  }

  private send(method: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        socket.destroy()
        resolve()
      }
      const socket = connect(this.environment.socketPath)
      socket.setTimeout(this.timeoutMs)
      socket.once('connect', () => {
        socket.end(`${JSON.stringify({ id: `${HERDR_SOURCE}:${this.seq}`, method, params })}\n`)
      })
      socket.once('data', finish)
      socket.once('end', finish)
      socket.once('close', finish)
      socket.once('error', finish)
      socket.once('timeout', finish)
    })
  }
}

export function createHerdrReporter(env: NodeJS.ProcessEnv = process.env): HerdrReporter | undefined {
  const environment = readHerdrEnvironment(env)
  return environment === undefined ? undefined : new HerdrReporter(environment)
}
