/**
 * 传输抽象。
 *
 * ## 为什么需要它
 *
 * 中枢逻辑（订阅表、broadcast、审批协调、37 种消息）原本直接操作 `net.Socket`：
 * `clients: Set<Socket>`、`watched: Map<Socket, Set<string>>`、
 * `jsonLine(socket, msg)`。这让"多端同步"被绑死在一种传输上——手机和宠物
 * 连不进来，只能另写一套服务端，于是同一个中枢有了好几份实现。
 *
 * 抽出 `Channel` 之后，中枢只认识"一个能收发 JSON 行的通道"：
 *
 *   中枢（唯一实例）
 *     ├── UnixSocketChannel → CLI（终端会话）
 *     ├── WebSocketChannel  → 手机 App、桌面宠物
 *     └── （将来）任何实现了这四个成员的传输
 *
 * 关键：`watched` 与 `broadcast` **一行都不用改**，多端同步因此是白拿的——
 * 手机订阅了会话 A、桌面订阅了会话 B、宠物订阅全部，各收各的。
 *
 * ## 边界为什么这么小
 *
 * 原先 `Socket` 只用到 10 个成员，其中真正属于"通道语义"的只有四个：
 * 存活判断、写一条、读一行、关闭通知。其余是 socket 特有的连接细节，
 * 属于各自实现，不该泄漏到中枢。
 */
import type { Socket } from 'node:net'

/** 一个能收发 NDJSON 的通道。中枢只通过这个接口接触客户端。 */
export interface Channel {
  /** 还能不能写。false 时中枢会跳过它，并在适当时机清理。 */
  readonly alive: boolean

  /**
   * 写一条消息（实现方负责序列化）。
   *
   * 必须是"尽力而为"的：对端已断时静默失败，不能抛给调用方。
   * 中枢会在广播循环里调用它，一条失败的写不该中断整轮广播。
   */
  write(value: unknown): void

  /** 主动关闭。中枢清理连接时调用。 */
  close(): void

  /** 稳定标识，仅用于日志；不参与业务判断。 */
  readonly label: string

  /**
   * 中枢在接入时挂上的两个回调。
   *
   * 用属性而不是构造函数参数：中枢先建通道、再登记，而通道可能在登记前
   * 就收到数据（socket 的 data 事件可能在同一次事件循环里到达）。挂属性
   * 让"建"和"接"可以分开，不必把中枢的引用传进通道。
   */
  onLine?: (line: string) => void
  onClose?: () => void
}

/**
 * `net.Socket` 上的通道实现。
 *
 * CLI 走这条。行为与改造前完全一致：utf8 编码、按换行切分、8MB 上限、
 * 16MB 积压断开。
 */
export class UnixSocketChannel implements Channel {
  readonly label: string
  private readonly socket: Socket
  private buffer = ''
  private closed = false

  onLine?: (line: string) => void
  onClose?: () => void

  constructor(socket: Socket) {
    this.socket = socket
    this.label = 'unix:cli'
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024) {
          this.close()
          return
        }
        if (line.trim().length > 0) this.onLine?.(line)
      }
      if (Buffer.byteLength(this.buffer, 'utf8') > 8 * 1024 * 1024) this.close()
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
      // 与改造前一致：积压超过 16MB 说明对端不读了，断开而不是无限缓冲
      if (this.socket.writableLength > 16 * 1024 * 1024) {
        this.close()
        return
      }
      this.socket.write(`${JSON.stringify(value)}\n`)
    } catch {
      // 对端可能在校验和写入之间重置
    }
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }
}
