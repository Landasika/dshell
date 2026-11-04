/**
 * WebSocket 客户端的设备表与配对。
 *
 * ## 为什么需要它
 *
 * unix socket 的权限由文件系统给（`srw-------`，只有本用户能连）。网络端口没有
 * 这层保护——任何能访问端口的人都能对你的会话发 prompt。所以必须有 token。
 *
 * ## 设计
 *
 * - **按 sha256 存**：token 泄漏等价于能操作任意会话，明文落盘时任何能读这个
 *   文件的进程都能冒充客户端。代价只是一个 hash。
 * - **一个码只换一个 token**：配对码用掉即删，否则同一个码可以被两台设备各换
 *   一份长期凭据。
 * - **码 5 分钟过期**：用户从屏幕抄码到输入，够用；长期挂着等于没有时效。
 * - **CLI 不经过这里**：它走 unix socket，由文件权限保护，不需要 token。
 *
 * ## 配对码只在本机可见
 *
 * `/api/pair/code` 只接受回环地址。否则局域网里任何人都能自助配对，
 * 那 token 就形同虚设。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'

import { resolveDshHome } from '../shared/paths.js'

/** 去掉易混的 I/L/O/0/1——用户要从屏幕上抄这个码。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PAIR_TTL_MS = 5 * 60 * 1000

export interface DeviceRecord {
  /** token 的 sha256（hex）。**不存明文**。 */
  hash: string
  name: string
  addedAt: number
  lastSeenAt?: number
}

export interface PairClaim {
  deviceId: string
  token: string
}

/** 设备表：token 的 hash → 记录。 */
export class DeviceStore {
  private readonly file: string
  private devices = new Map<string, DeviceRecord>()

  constructor(file?: string) {
    this.file = file ?? join(resolveDshHome(), 'dshell-ws', 'devices.json')
    this.load()
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const row of parsed) {
        if (row !== null && typeof row === 'object' && typeof (row as DeviceRecord).hash === 'string') {
          const record = row as DeviceRecord
          this.devices.set(record.hash, record)
        }
      }
    } catch {
      // 文件损坏时从空表开始：宁可要求重新配对，也不要带着半份状态运行
    }
  }

  private save(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // 某些文件系统不支持 chmod；内容本身已经是 hash
    }
  }

  /** 签发一个 token，返回明文（调用方只给用户看这一次）。 */
  issue(name: string): string {
    const token = randomBytes(32).toString('base64url')
    this.devices.set(DeviceStore.hash(token), { hash: DeviceStore.hash(token), name, addedAt: Date.now() })
    this.save()
    return token
  }

  /** 校验 token；成功返回记录并更新 lastSeenAt。 */
  verify(token: string): DeviceRecord | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const hash = DeviceStore.hash(token)
    const record = this.devices.get(hash)
    if (record === undefined) return undefined
    // 定长比较：表里是 hash，但保持恒定时间比较的习惯
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(record.hash, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
    record.lastSeenAt = Date.now()
    return record
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()]
  }

  revoke(hash: string): boolean {
    const removed = this.devices.delete(hash)
    if (removed) this.save()
    return removed
  }

  count(): number {
    return this.devices.size
  }
}

/** 待领取的配对码。 */
export class PairCodes {
  private readonly codes = new Map<string, number>()

  issue(): string {
    // 顺手清理过期的，避免长期运行后无限堆积
    const now = Date.now()
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= now) this.codes.delete(code)
    }
    let code = ''
    do {
      code = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
    } while (this.codes.has(code))
    this.codes.set(code, now + PAIR_TTL_MS)
    return code
  }

  /** 用掉即删：一个码不能换出两份长期凭据。 */
  claim(code: string): boolean {
    const expiresAt = this.codes.get(code)
    if (expiresAt === undefined) return false
    this.codes.delete(code)
    return expiresAt > Date.now()
  }

  get size(): number {
    return this.codes.size
  }

  clear(): void {
    this.codes.clear()
  }
}
