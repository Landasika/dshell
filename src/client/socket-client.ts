import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type DshellErrorCode,
  type ServerMessage,
  type WelcomeMessage,
} from '../protocol/index.js'

export class DshellError extends Error {
  readonly code: DshellErrorCode
  readonly action?: string

  constructor(code: DshellErrorCode, message: string, action?: string) {
    super(message)
    this.name = 'DshellError'
    this.code = code
    this.action = action
  }
}

function socketError(error: NodeJS.ErrnoException, socketPath: string): DshellError {
  switch (error.code) {
    case 'ENOENT':
    case 'ECONNREFUSED':
      return new DshellError(
        'HOST_NOT_RUNNING',
        `no dsh Host is listening on ${socketPath}`,
        'Start it with: dsh --profile web',
      )
    case 'EACCES':
    case 'EPERM':
      return new DshellError(
        'SOCKET_PERMISSION_DENIED',
        `permission denied for ${socketPath}`,
        'Run dshell as the same user that started the dsh Host.',
      )
    default:
      return new DshellError('HOST_NOT_RUNNING', `cannot connect to ${socketPath}: ${error.message}`)
  }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new DshellError('HOST_NOT_RUNNING', `timed out connecting to ${socketPath}`))
    }, timeoutMs)

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(socketError(error as NodeJS.ErrnoException, socketPath))
    })
  })
}

type MessageListener = (message: ServerMessage) => void

/** One attach connection to the local dshell-host plugin. */
export class HostConnection {
  private readonly socket: Socket
  private readonly queue: ServerMessage[] = []
  private readonly listeners = new Set<MessageListener>()
  private readonly waiters = new Set<{
    predicate: (message: ServerMessage) => boolean
    resolve: (message: ServerMessage) => void
    reject: (error: Error) => void
  }>()
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  private welcomeMessage: WelcomeMessage | null = null

  private constructor(socket: Socket) {
    this.socket = socket
    const lines = createInterface({ input: socket })
    lines.on('line', (line) => {
      if (line.trim().length === 0) return
      let message: ServerMessage
      try {
        message = JSON.parse(line) as ServerMessage
      } catch {
        this.fail(new DshellError('PLUGIN_MISSING', 'dshell-host sent invalid JSON'))
        return
      }
      this.receive(message)
    })
    socket.on('close', () => {
      this.fail(new DshellError('HOST_NOT_RUNNING', 'dshell-host closed the connection'))
    })
    socket.on('error', (error) => {
      this.fail(socketError(error as NodeJS.ErrnoException, 'the dshell socket'))
    })
  }

  static async connect(socketPath: string, timeoutMs = 5_000): Promise<HostConnection> {
    const socket = await connectSocket(socketPath, timeoutMs)
    const connection = new HostConnection(socket)
    connection.send({ type: 'hello', protocol: PROTOCOL_VERSION })

    let message: ServerMessage
    try {
      message = await connection.waitFor(
        (candidate) => candidate.type === 'welcome' || candidate.type === 'error',
        timeoutMs,
      )
    } catch (error) {
      connection.close()
      throw error
    }

    if (message.type === 'error') {
      connection.close()
      throw new DshellError(message.code, message.message, message.action)
    }
    if (message.type !== 'welcome') {
      connection.close()
      throw new DshellError('PLUGIN_MISSING', 'dshell-host did not complete the handshake')
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      connection.close()
      throw new DshellError(
        'PROTOCOL_MISMATCH',
        `host uses protocol ${message.protocol}; this CLI uses ${PROTOCOL_VERSION}`,
        'Install a matching CLI and dshell-host plugin version.',
      )
    }
    connection.welcomeMessage = message
    return connection
  }

  get welcome(): WelcomeMessage {
    if (this.welcomeMessage === null) throw new DshellError('PLUGIN_MISSING', 'handshake incomplete')
    return this.welcomeMessage
  }

  get socketPath(): string {
    return this.welcome.socketPath
  }

  get closedByPeer(): boolean {
    return this.closed
  }

  /** Called once when the connection is gone, however it went away. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  private notifyClosed(): void {
    for (const listener of [...this.closeListeners]) {
      try {
        listener()
      } catch {
        // A listener must not break the transport teardown.
      }
    }
    this.closeListeners.clear()
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(message: ClientMessage): void {
    if (this.closed || this.socket.destroyed) {
      throw new DshellError('HOST_NOT_RUNNING', 'dshell-host connection is closed')
    }
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 30_000,
  ): Promise<T> {
    const queuedIndex = this.queue.findIndex(predicate)
    if (queuedIndex !== -1) {
      const [message] = this.queue.splice(queuedIndex, 1)
      return Promise.resolve(message as T)
    }
    if (this.closed) {
      return Promise.reject(new DshellError('HOST_NOT_RUNNING', 'dshell-host connection is closed'))
    }

    return new Promise<T>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: ServerMessage) => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve(message as T)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        waiter.reject(new DshellError('INTERNAL', 'timed out waiting for dshell-host'))
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.notifyClosed()
    // Destroy rather than only half-closing: a viewer may quit while the Host
    // is still writing, and an `end()` can leave the client process alive.
    this.socket.destroy()
    for (const waiter of this.waiters) {
      waiter.reject(new DshellError('HOST_NOT_RUNNING', 'dshell-host connection is closed'))
    }
    this.waiters.clear()
  }

  private receive(message: ServerMessage): void {
    if (message.type === 'welcome') this.welcomeMessage = message
    // Errors are replies to the command in flight, never a broadcast: reject
    // every pending waiter so callers see the failure immediately instead of
    // blocking until their timeout.
    if (message.type === 'error') {
      for (const listener of this.listeners) listener(message)
      const error = new DshellError(message.code, message.message, message.action)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      return
    }
    this.queue.push(message)
    for (const listener of this.listeners) listener(message)
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue
      const index = this.queue.indexOf(message)
      if (index !== -1) this.queue.splice(index, 1)
      waiter.resolve(message)
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.notifyClosed()
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }
}
