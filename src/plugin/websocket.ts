/**
 * 零依赖 WebSocket 服务端（RFC 6455 子集），以及基于它的 `Channel` 实现。
 *
 * ## 为什么手写而不是依赖 `ws`
 *
 * dshell 目前只依赖 `yaml`。为一个单路复用的文本通道拉进整个 `ws` 依赖树
 * 不值得；更实际的理由是插件装进 dsh 进程运行，多一层依赖就多一处版本冲突
 * 的来源。这里只实现协议里够用的部分。
 *
 * ## 支持范围
 *
 * - 文本帧（0x1）、二进制帧（0x2）、关闭（0x8）、ping/pong（0x9/0xA）
 * - 分片（continuation 0x0）——App 发大 prompt 时会出现
 * - 客户端掩码（RFC 要求客户端必须掩码，服务端必须校验）
 * - 载荷长度 7 / 16 / 64 位三种编码
 *
 * ## 明确不做
 *
 * - **不协商 permessage-deflate**：握手时不广告扩展，双方按无压缩通信。
 *   压缩对 NDJSON 文本收益有限，却让帧层复杂度翻倍。
 * - **不校验 Origin**：手机 App 与桌面宠物都不是浏览器，没有同源概念；
 *   鉴权走 token。
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Channel } from './channel.ts'

/** RFC 6455 的握手魔数，写死在规范里。 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const

const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024

/**
 * 校验并完成握手。
 *
 * 成功返回 true（此时已写出 101 响应）；失败返回 false（已写出错误响应并断开）。
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return false
  }
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return true
}

/**
 * 把一条消息编成帧。服务端发出的帧**不加掩码**（RFC 6455 §5.1）。
 */
export function encodeFrame(payload: Buffer | string, opcode: number = OPCODE.TEXT): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const length = data.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode // FIN=1（不分片）
  return Buffer.concat([header, data])
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * 增量帧解析器。
 *
 * TCP 是字节流：一次 `data` 事件可能带来半个帧，也可能带来三个帧。所以必须
 * 自带缓冲区，而不是假设"一次 data = 一个帧"。
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode: number | undefined
  private fragmentBytes = 0
  private closed = false
  private readonly maxPayloadBytes: number
  private readonly onMessage: (payload: string | Buffer, binary: boolean) => void
  private readonly onClose: (payload: Buffer) => void
  private readonly onPing: (payload: Buffer) => void

  constructor(options: {
    maxPayloadBytes?: number
    onMessage?: (payload: string | Buffer, binary: boolean) => void
    onClose?: (payload: Buffer) => void
    onPing?: (payload: Buffer) => void
  } = {}) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD
    this.onMessage = options.onMessage ?? (() => {})
    this.onClose = options.onClose ?? (() => {})
    this.onPing = options.onPing ?? (() => {})
  }

  push(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]) as Buffer
    for (;;) {
      const frame = this.readFrame()
      if (frame === undefined) return
      this.dispatch(frame)
      if (this.closed) {
        this.buffer = Buffer.alloc(0)
        this.fragments = []
        this.fragmentBytes = 0
        return
      }
    }
  }

  /** 读出一帧；数据不够返回 undefined（保留缓冲区等下一次 data）。 */
  private readFrame(): Frame | undefined {
    const buf = this.buffer
    if (buf.length < 2) return undefined
    const fin = (buf[0]! & 0x80) !== 0
    const rsv = buf[0]! & 0x70
    const opcode = buf[0]! & 0x0f
    const masked = (buf[1]! & 0x80) !== 0
    let length = buf[1]! & 0x7f
    let offset = 2

    // RSV 位非零意味着协商了我们没实现的扩展——按协议必须断开
    if (rsv !== 0) throw new Error('reserved bits set without a negotiated extension')
    // 客户端到服务端的帧必须掩码（RFC 6455 §5.1），否则是攻击面
    if (!masked) throw new Error('client frame is not masked')

    if (length === 126) {
      if (buf.length < offset + 2) return undefined
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return undefined
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(this.maxPayloadBytes)) throw new Error('frame exceeds payload limit')
      length = Number(big)
      offset += 8
    }
    if (length > this.maxPayloadBytes) throw new Error('frame exceeds payload limit')
    if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('invalid control frame')
    if (opcode === OPCODE.CONTINUATION && this.fragmentBytes + length > this.maxPayloadBytes) {
      throw new Error('message exceeds payload limit')
    }

    if (buf.length < offset + 4 + length) return undefined
    const mask = buf.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = buf[offset + index]! ^ mask[index % 4]!
    }
    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  private dispatch(frame: Frame): void {
    const { fin, opcode, payload } = frame
    switch (opcode) {
      case OPCODE.PING:
        this.onPing(payload)
        return
      case OPCODE.PONG:
        return
      case OPCODE.CLOSE:
        this.closed = true
        this.onClose(payload)
        return
      case OPCODE.CONTINUATION: {
        if (this.fragmentOpcode === undefined) throw new Error('continuation without a start frame')
        if (payload.length > 0 && this.fragments.length >= 4096) throw new Error('too many message fragments')
        this.fragmentBytes += payload.length
        if (payload.length > 0) this.fragments.push(payload)
        if (!fin) return
        const whole = Buffer.concat(this.fragments)
        const type = this.fragmentOpcode
        this.fragments = []
        this.fragmentBytes = 0
        this.fragmentOpcode = undefined
        if (type === OPCODE.TEXT) this.onMessage(whole.toString('utf8'), false)
        else this.onMessage(whole, true)
        return
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (this.fragmentOpcode !== undefined) throw new Error('data frame during a fragmented message')
        if (!fin) {
          this.fragments = payload.length > 0 ? [payload] : []
          this.fragmentBytes = payload.length
          this.fragmentOpcode = opcode
          return
        }
        if (opcode === OPCODE.TEXT) this.onMessage(payload.toString('utf8'), false)
        else this.onMessage(payload, true)
        return
      }
      default:
        throw new Error(`unsupported opcode ${String(opcode)}`)
    }
  }
}

/**
 * WebSocket 上的通道实现。
 *
 * 手机 App 与桌面宠物走这条。它与 `UnixSocketChannel` 对中枢完全等价——
 * 这正是多端同步"白拿"的原因：中枢的订阅表同时装着两种通道。
 *
 * 一条 WS 帧就是一条消息，但仍按行切分：客户端可能把多条 NDJSON 打进一帧，
 * 保持与 CLI 相同的解析路径，中枢不需要区分。
 */
export class WebSocketChannel implements Channel {
  readonly label: string
  private readonly socket: Duplex
  private readonly parser: FrameParser
  private closed = false
  /** 客户端声明的身份（app / pet），握手后才有值。 */
  clientKind: 'app' | 'pet' = 'app'

  onLine?: (line: string) => void
  onClose?: () => void
  /** 中枢在握手后注入：让通道知道自己是 app 还是 pet。 */
  onHello?: (kind: 'app' | 'pet') => void

  constructor(socket: Duplex, maxPayloadBytes = DEFAULT_MAX_PAYLOAD) {
    this.socket = socket
    this.label = `ws:${(socket as { remoteAddress?: string }).remoteAddress ?? 'remote'}`
    this.parser = new FrameParser({
      maxPayloadBytes,
      onMessage: (payload, binary) => {
        if (binary || typeof payload !== 'string') return
        for (const line of payload.split('\n')) {
          if (this.closed) break
          if (line.trim().length > 0) this.onLine?.(line)
        }
      },
      onClose: () => this.close(),
      onPing: (payload) => {
        this.writeFrame(payload, OPCODE.PONG)
      },
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        this.parser.push(chunk)
      } catch {
        // 帧层违反协议：断开，而不是让坏帧进入中枢
        this.close()
      }
    })
    const cleanup = (): void => {
      if (this.closed) return
      this.closed = true
      this.onClose?.()
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  get alive(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.writable
  }

  write(value: unknown): void {
    if (!this.alive) return
    try {
      this.writeFrame(JSON.stringify(value), OPCODE.TEXT)
    } catch {
      // 对端可能在校验和写入之间重置
    }
  }

  private writeFrame(payload: Buffer | string, opcode: number): void {
    if (!this.alive) return
    try {
      if (this.socket.writableLength > 16 * 1024 * 1024) {
        this.close()
        return
      }
      this.socket.write(encodeFrame(payload, opcode))
    } catch {
      this.close()
    }
  }

  /** 发一个 ping 帧；客户端不回 pong 就说明它已经不在了。 */
  ping(): void {
    this.writeFrame(Buffer.alloc(0), OPCODE.PING)
  }

  close(): void {
    if (this.closed) {
      this.socket.destroy()
      return
    }
    this.closed = true
    this.onClose?.()
    try {
      if (!this.socket.destroyed && this.socket.writable) {
        this.socket.write(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE))
        this.socket.end()
      }
    } catch {
      // 关闭路径上的错误没有意义，直接销毁
    }
    this.socket.destroy()
  }
}
