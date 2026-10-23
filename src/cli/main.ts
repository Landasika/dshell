import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { DshellError } from '../client/socket-client.js'
import { BackendError, SocketBackend, type SessionView } from '../backend/index.js'
import type { SessionEvent } from '../protocol/index.js'
import { resolveSocketPath } from '../shared/paths.js'
import { packageVersion } from '../shared/package.js'
import { printEvent, printSessions, printWorkspaces, isTurnEnd, turnFailed } from './output.js'
import { runDoctor } from './doctor.js'
import { runTui } from '../tui/app.js'
import { runPrint, type OutputFormat } from './print.js'

interface Options {
  command: string
  args: string[]
  socket?: string
  timeoutMs: number
  verbose: boolean
  resume?: string
  color?: boolean
  print: boolean
  outputFormat: OutputFormat
  sessionId?: string
  workspaceId?: string
  cwd?: string
  create?: boolean
}

const HELP = `dshell ${packageVersion()}

Usage:
  dshell                  interactive TUI (same as 'dshell tui')
  dshell tui [--resume <sessionId>]
  dshell -p [options] [prompt]        non-interactive one-shot
  dshell --print --session <id> "…"
  dshell doctor
  dshell workspaces
  dshell list [workspaceId]
  dshell new [cwd]
  dshell attach <sessionId>
  dshell prompt <sessionId> <text...>
  dshell steer <sessionId> <text...>
  dshell cancel <sessionId>

Options:
  --socket <path>     override the control socket
  --timeout <ms>      prompt/turn timeout (default: 120000)
  --verbose           print context and lifecycle events
  --resume <id>, -r   open a session directly in the TUI
  --no-color          disable ANSI colors
  -p, --print         one-shot mode; prompt from args or stdin
  --output-format <f> text | json | stream-json (default: text)
  --json              shorthand for --output-format json
  -s, --session <id>  use an existing session (print)
  -w, --workspace <id> use a workspace when creating a session
  --cwd <path>        working directory for a new session
  --new               always create a new session (print)
  -h, --help          show this help
  -V, --version       show the version

Environment:
  DSH_HOME            DSH home directory (default: ~/.dsh)
  DSHELL_SOCKET       control socket override

The dsh Host must already be running with the dshell-host plugin:
  dsh --profile web
`

function parseArgs(argv: string[]): Options {
  let command: string | undefined
  const args: string[] = []
  let socket: string | undefined
  let timeoutMs = 120_000
  let verbose = false
  let resume: string | undefined
  let color: boolean | undefined
  let print = false
  let outputFormat: OutputFormat = 'text'
  let sessionId: string | undefined
  let workspaceId: string | undefined
  let cwd: string | undefined
  let create = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue

    if (arg === '--') {
      args.push(...argv.slice(index + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      command = 'help'
      continue
    }
    if (arg === '-V' || arg === '--version') {
      command = 'version'
      continue
    }
    if (arg === '-p' || arg === '--print') {
      print = true
      continue
    }
    if (arg === '--json') {
      outputFormat = 'json'
      continue
    }
    if (arg === '--output-format') {
      const value = argv[index + 1]
      if (value !== 'text' && value !== 'json' && value !== 'stream-json') {
        throw new DshellError('BAD_REQUEST', '--output-format must be text, json, or stream-json')
      }
      outputFormat = value
      index += 1
      continue
    }
    if (arg === '--session' || arg === '-s') {
      const value = argv[index + 1]
      if (value === undefined) throw new DshellError('BAD_REQUEST', `${arg} requires a sessionId`)
      sessionId = value
      index += 1
      continue
    }
    if (arg === '--workspace' || arg === '-w') {
      const value = argv[index + 1]
      if (value === undefined) throw new DshellError('BAD_REQUEST', `${arg} requires a workspaceId`)
      workspaceId = value
      index += 1
      continue
    }
    if (arg === '--cwd') {
      const value = argv[index + 1]
      if (value === undefined) throw new DshellError('BAD_REQUEST', '--cwd requires a path')
      cwd = value
      index += 1
      continue
    }
    if (arg === '--new') {
      create = true
      continue
    }
    if (arg === '--verbose') {
      verbose = true
      continue
    }
    if (arg === '--no-color') {
      color = false
      continue
    }
    if (arg === '--color') {
      color = true
      continue
    }
    if (arg === '--resume' || arg === '-r') {
      const value = argv[index + 1]
      if (value === undefined) throw new DshellError('BAD_REQUEST', `${arg} requires a sessionId`)
      resume = value
      index += 1
      continue
    }
    if (arg === '--socket') {
      const value = argv[index + 1]
      if (value === undefined) throw new DshellError('BAD_REQUEST', '--socket requires a path')
      socket = value
      index += 1
      continue
    }
    if (arg === '--timeout') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) {
        throw new DshellError('BAD_REQUEST', '--timeout requires a positive number of milliseconds')
      }
      timeoutMs = value
      index += 1
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      throw new DshellError('BAD_REQUEST', `unknown option: ${arg}`)
    }

    if (print) args.push(arg)
    else if (command === undefined) command = arg
    else args.push(arg)
  }

  return {
    command: print ? 'print' : command ?? (argv.length === 0 ? 'tui' : 'help'),
    args,
    socket,
    timeoutMs,
    verbose,
    ...(resume === undefined ? {} : { resume }),
    ...(color === undefined ? {} : { color }),
    print,
    outputFormat,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(create ? { create } : {}),
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DshellError('INTERNAL', message))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

async function workspaces(socketPath: string): Promise<void> {
  const backend = new SocketBackend(socketPath)
  try {
    await backend.connect()
    printWorkspaces(await backend.listWorkspaces())
  } finally {
    await backend.disconnect()
  }
}

async function newSession(socketPath: string, cwd: string | undefined): Promise<void> {
  const backend = new SocketBackend(socketPath)
  let handle = undefined as Awaited<ReturnType<SocketBackend['openSession']>> | undefined
  try {
    await backend.connect()
    handle = await backend.createSession({ cwd: cwd ?? process.cwd() })
    const header = handle.snapshot().header
    console.log(`[created] ${handle.id}  ${String(header.cwd ?? '')}`)
  } finally {
    handle?.dispose()
    await backend.disconnect()
  }
}

async function cancel(socketPath: string, sessionId: string): Promise<void> {
  const backend = new SocketBackend(socketPath)
  let handle = undefined as Awaited<ReturnType<SocketBackend['openSession']>> | undefined
  try {
    await backend.connect()
    handle = await backend.openSession(sessionId)
    await handle.cancel()
    console.log(`[cancelled] ${sessionId}`)
  } finally {
    handle?.dispose()
    await backend.disconnect()
  }
}

async function list(socketPath: string, workspaceId?: string): Promise<void> {
  const backend = new SocketBackend(socketPath)
  try {
    await backend.connect()
    printSessions(await backend.listSessions(workspaceId))
  } finally {
    await backend.disconnect()
  }
}

function printViewHeader(view: SessionView): void {
  console.log(`\n[attached] ${view.sessionId} cursor=${view.cursor} history=${view.events.length}`)
}

async function attach(socketPath: string, sessionId: string, verbose: boolean): Promise<void> {
  const backend = new SocketBackend(socketPath)
  let handle = undefined as Awaited<ReturnType<SocketBackend['openSession']>> | undefined
  try {
    await backend.connect()
    handle = await backend.openSession(sessionId)
    const initial = handle.snapshot()
    printViewHeader(initial)
    for (const event of initial.events) printEvent(event, verbose)
    let lastSeq = initial.cursor

    const off = handle.subscribe((view) => {
      for (const event of view.events) {
        if (event.seq <= lastSeq) continue
        printEvent(event, verbose)
        lastSeq = event.seq
      }
      if (verbose && view.status !== 'unknown') console.log(`[status] ${view.status}`)
    })
    console.log('[attached] listening; press Ctrl-C to exit')
    await waitForInterrupt()
    off()
  } finally {
    handle?.dispose()
    await backend.disconnect()
  }
}

async function steer(
  socketPath: string,
  sessionId: string,
  text: string,
  timeoutMs: number,
  verbose: boolean,
): Promise<void> {
  const backend = new SocketBackend(socketPath)
  let handle: Awaited<ReturnType<SocketBackend['openSession']>> | undefined
  let off: (() => void) | undefined
  try {
    await backend.connect()
    handle = await backend.openSession(sessionId)
    if (handle.snapshot().status !== 'running') {
      throw new DshellError(
        'BAD_REQUEST',
        'steer needs a running turn; use prompt for a new turn',
        'Run `dshell prompt <sessionId> <text...>` instead.',
      )
    }
    let lastSeq = handle.snapshot().cursor
    let settle: (() => void) | undefined
    const ended = new Promise<void>((resolve) => {
      settle = resolve
    })
    let asking = false
    const askApproval = async (view: SessionView): Promise<void> => {
      const pending = view.pendingApproval
      if (pending === undefined || asking) return
      asking = true
      try {
        if (!input.isTTY) {
          console.error(`[approval] ${pending.toolName}: no TTY; rejecting (fail closed)`)
          await handle?.answerApproval(pending.requestId, 'rejected')
          return
        }
        const rl = createInterface({ input, output })
        try {
          const answer = await rl.question(
            `\n[approval] ${pending.toolName}${pending.reason === undefined ? '' : `: ${pending.reason}`} [a]llow once / [r]eject: `,
          )
          await handle?.answerApproval(
            pending.requestId,
            answer.trim().toLowerCase().startsWith('a') ? 'allowed-once' : 'rejected',
          )
        } finally {
          rl.close()
        }
      } catch (error) {
        console.error(`[approval] ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        asking = false
      }
    }

    off = handle.subscribe((view) => {
      for (const event of view.events) {
        if (event.seq <= lastSeq) continue
        printEvent(event, verbose)
        lastSeq = event.seq
        if (isTurnEnd(event)) settle?.()
      }
      if (view.pendingApproval !== undefined) void askApproval(view)
    })
    const receipt = await handle.send(text, { mode: 'steer' })
    console.log(`[steered] ${receipt.requestId}`)
    await withTimeout(ended, timeoutMs, `steer did not finish within ${timeoutMs}ms`)
  } finally {
    off?.()
    handle?.dispose()
    await backend.disconnect()
  }
}

async function prompt(
  socketPath: string,
  sessionId: string,
  text: string,
  timeoutMs: number,
  verbose: boolean,
): Promise<void> {
  const backend = new SocketBackend(socketPath)
  let handle = undefined as Awaited<ReturnType<SocketBackend['openSession']>> | undefined
  let off: (() => void) | undefined
  try {
    await backend.connect()
    handle = await backend.openSession(sessionId)
    const initial = handle.snapshot()
    let lastSeq = initial.cursor
    let settle: ((event: SessionEvent) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const turnDone = new Promise<SessionEvent>((resolve, reject) => {
      settle = resolve
      fail = reject
    })

    let asking = false
    const askApproval = async (view: SessionView): Promise<void> => {
      const pending = view.pendingApproval
      if (pending === undefined || asking) return
      asking = true
      try {
        if (!input.isTTY) {
          console.error(`[approval] ${pending.toolName}: no TTY; rejecting (fail closed)`)
          await handle?.answerApproval(pending.requestId, 'rejected')
          return
        }
        const rl = createInterface({ input, output })
        try {
          const answer = await rl.question(
            `\n[approval] ${pending.toolName}${pending.reason === undefined ? '' : `: ${pending.reason}`} [a]llow once / [r]eject: `,
          )
          await handle?.answerApproval(
            pending.requestId,
            answer.trim().toLowerCase().startsWith('a') ? 'allowed-once' : 'rejected',
          )
        } finally {
          rl.close()
        }
      } catch (error) {
        console.error(`[approval] ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        asking = false
      }
    }

    off = handle.subscribe((view) => {
      for (const event of view.events) {
        if (event.seq <= lastSeq) continue
        printEvent(event, verbose)
        lastSeq = event.seq
        if (isTurnEnd(event)) settle?.(event)
      }
      if (view.pendingApproval !== undefined) void askApproval(view)
      if (verbose && view.status !== 'unknown') console.log(`[status] ${view.status}`)
    })

    const receipt = await handle.send(text)
    console.log(`[accepted] ${receipt.requestId}`)
    const end = await withTimeout(
      turnDone,
      timeoutMs,
      `turn did not finish within ${timeoutMs}ms; the Host may still be running it`,
    )
    if (turnFailed(end)) process.exitCode = 1
  } finally {
    off?.()
    handle?.dispose()
    await backend.disconnect()
  }
}

/** CLI entry point. */
export async function main(argv: string[]): Promise<void> {
  let options: Options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof DshellError) {
      console.error(`dshell: ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (options.command === 'help') {
    console.log(HELP)
    return
  }
  if (options.command === 'version') {
    console.log(`dshell ${packageVersion()}`)
    return
  }

  const socketPath = resolveSocketPath(options.socket)

  try {
    switch (options.command) {
      case 'tui':
      case 'interactive': {
        if (!output.isTTY) {
          console.log(HELP)
          return
        }
        const backend = new SocketBackend(socketPath)
        try {
          await backend.connect()
          process.exitCode = await runTui(backend, {
            cwd: process.cwd(),
            ...(options.resume === undefined
              ? options.sessionId === undefined
                ? {}
                : { resume: options.sessionId }
              : { resume: options.resume }),
            verbose: options.verbose,
            ...(options.color === undefined ? {} : { color: options.color }),
          })
        } finally {
          await backend.disconnect()
        }
        return
      }
      case 'print': {
        const prompt = options.args.length === 0 ? undefined : options.args.join(' ')
        process.exitCode = await runPrint(socketPath, {
          ...(prompt === undefined ? {} : { prompt }),
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.create === true ? { create: true } : {}),
          outputFormat: options.outputFormat,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
        })
        return
      }
      case 'doctor':
        process.exitCode = await runDoctor(socketPath)
        return
      case 'list':
      case 'sessions':
        await list(socketPath, options.args[0])
        return
      case 'workspaces':
        await workspaces(socketPath)
        return
      case 'new': {
        await newSession(socketPath, options.args[0])
        return
      }
      case 'cancel': {
        const sessionId = options.args[0]
        if (sessionId === undefined) throw new DshellError('BAD_REQUEST', 'cancel requires a sessionId')
        await cancel(socketPath, sessionId)
        return
      }
      case 'attach': {
        const sessionId = options.args[0]
        if (sessionId === undefined) throw new DshellError('BAD_REQUEST', 'attach requires a sessionId')
        await attach(socketPath, sessionId, options.verbose)
        return
      }
      case 'prompt': {
        const sessionId = options.args[0]
        const text = options.args.slice(1).join(' ')
        if (sessionId === undefined || text.length === 0) {
          throw new DshellError('BAD_REQUEST', 'prompt requires <sessionId> <text...>')
        }
        await prompt(socketPath, sessionId, text, options.timeoutMs, options.verbose)
        return
      }
      case 'steer': {
        const sessionId = options.args[0]
        const text = options.args.slice(1).join(' ')
        if (sessionId === undefined || text.length === 0) {
          throw new DshellError('BAD_REQUEST', 'steer requires <sessionId> <text...>')
        }
        await steer(socketPath, sessionId, text, options.timeoutMs, options.verbose)
        return
      }
      default:
        throw new DshellError('BAD_REQUEST', `unknown command: ${options.command}`)
    }
  } catch (error) {
    if (error instanceof DshellError || error instanceof BackendError) {
      console.error(`dshell: ${error.message}`)
      if (error.action !== undefined) console.error(`       ${error.action}`)
      process.exitCode = error.code === 'BAD_REQUEST' ? 2 : 1
      return
    }
    console.error(`dshell: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
