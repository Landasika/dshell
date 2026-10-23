import { DshellError, HostConnection } from '../client/socket-client.js'
import type { ServerMessage, SessionEvent, SessionsMessage, AttachedMessage } from '../protocol/index.js'
import { resolveSocketPath } from '../shared/paths.js'
import { packageVersion } from '../shared/package.js'
import { printAttached, printEvent, printSessions, isTurnEnd, turnFailed } from './output.js'
import { runDoctor } from './doctor.js'

interface Options {
  command: string
  args: string[]
  socket?: string
  timeoutMs: number
  verbose: boolean
}

const HELP = `dshell ${packageVersion()}

Usage:
  dshell doctor
  dshell list
  dshell attach <sessionId>
  dshell prompt <sessionId> <text...>

Options:
  --socket <path>     override the control socket
  --timeout <ms>      prompt/turn timeout (default: 120000)
  --verbose           print context and lifecycle events
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
    if (arg === '--verbose') {
      verbose = true
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
    if (arg.startsWith('-')) {
      throw new DshellError('BAD_REQUEST', `unknown option: ${arg}`)
    }

    if (command === undefined) command = arg
    else args.push(arg)
  }

  return {
    command: command ?? 'help',
    args,
    socket,
    timeoutMs,
    verbose,
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

async function list(socketPath: string): Promise<void> {
  const connection = await HostConnection.connect(socketPath)
  try {
    connection.send({ type: 'list' })
    const message = await connection.waitFor<SessionsMessage>(
      (candidate) => candidate.type === 'sessions',
      10_000,
    )
    printSessions(message.sessions)
  } finally {
    connection.close()
  }
}

async function attach(socketPath: string, sessionId: string, verbose: boolean): Promise<void> {
  const connection = await HostConnection.connect(socketPath)
  let attachedSeen = false
  const pending: ServerMessage[] = []
  const off = connection.onMessage((message) => {
    if (!attachedSeen) {
      pending.push(message)
      return
    }
    if (message.type === 'event') printEvent(message.event, verbose)
    else if (message.type === 'status' && verbose) console.log(`[status] ${message.status}`)
  })

  try {
    connection.send({ type: 'attach', sessionId })
    const attached = await connection.waitFor<AttachedMessage>(
      (candidate) => candidate.type === 'attached',
      10_000,
    )
    printAttached(attached, verbose)
    attachedSeen = true
    for (const message of pending) {
      if (message.type === 'event' && message.event.seq > attached.cursor) {
        printEvent(message.event, verbose)
      }
    }
    pending.length = 0
    console.log('[attached] listening; press Ctrl-C to exit')
    await waitForInterrupt()
  } finally {
    off()
    connection.close()
  }
}

async function prompt(
  socketPath: string,
  sessionId: string,
  text: string,
  timeoutMs: number,
  verbose: boolean,
): Promise<void> {
  const connection = await HostConnection.connect(socketPath)
  let settle: ((event: SessionEvent) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const turnDone = new Promise<SessionEvent>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const off = connection.onMessage((message: ServerMessage) => {
    if (message.type === 'event') {
      printEvent(message.event, verbose)
      if (isTurnEnd(message.event)) settle?.(message.event)
    } else if (message.type === 'accepted') {
      console.log(`[accepted] ${message.requestId}`)
    } else if (message.type === 'error') {
      fail?.(new DshellError(message.code, message.message, message.action))
    } else if (message.type === 'status' && verbose) {
      console.log(`[status] ${message.status}`)
    }
  })

  try {
    connection.send({ type: 'prompt', sessionId, text })
    const end = await withTimeout(
      turnDone,
      timeoutMs,
      `turn did not finish within ${timeoutMs}ms; the Host may still be running it`,
    )
    if (turnFailed(end)) process.exitCode = 1
  } finally {
    off()
    connection.close()
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
      case 'doctor':
        process.exitCode = await runDoctor(socketPath)
        return
      case 'list':
        await list(socketPath)
        return
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
      default:
        throw new DshellError('BAD_REQUEST', `unknown command: ${options.command}`)
    }
  } catch (error) {
    if (error instanceof DshellError) {
      console.error(`dshell: ${error.message}`)
      if (error.action !== undefined) console.error(`       ${error.action}`)
      process.exitCode = 1
      return
    }
    console.error(`dshell: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
