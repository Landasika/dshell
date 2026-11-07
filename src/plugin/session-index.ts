/**
 * 会话轻索引。
 *
 * ## 为什么需要这层
 *
 * 列会话列表只需要**十来个字段**（标题、副标题、时间、归档/置顶、父子关系），
 * 但 `sessionQuery.listSessions()` 要读全量会话头，而 `preview`/`title` 之类
 * 的字段过去是靠 `readSession()` 去解析**整份日志正文**换来的。实测：24 份
 * 日志全量解压 + JSON 解析要 2 秒以上，缓存全冷时更久。
 *
 * Claude Code 和 Codex 都不这么做：
 *
 * - Claude Code 把每条用户 prompt 另存进 `~/.claude/history.jsonl`（436 KB，
 *   对应 522 MB 正文），列列表读索引，不碰正文；
 * - Codex 在 `state_5.sqlite` 的 `threads` 表里直接存 `title` / `preview` /
 *   `first_user_message` / `archived` / `is_pinned`，列列表就是一条 SQL。
 *
 * 两者索引与正文的体积比都在 1:600 ~ 1:1200，而 dshell 原来的投影缓存
 * （172 MB）比正文（270 MB）还大——索引做反了。
 *
 * 这个模块就是 dshell 版本的那张小表：**JSONL 边车，一次顺序读，增量追加。**
 *
 * ## 关键性质
 *
 * - **只追加**：每行一条记录，新的覆盖旧的（按 `sessionId` 取最后一条）。
 *   这样写入是 O(1) 的 `appendFile`，不需要重写全表，也不会写坏旧数据。
 * - **原子性**：追加单行小于 PIPE_BUF，进程崩溃最多丢最后一行；读取时遇到
 *   解析不了的行直接跳过，不让一条坏记录毁掉整份索引。
 * - **可重建**：索引永远是可丢弃的派生数据。删掉它只会让下次列表慢一次，
 *   真正的权威仍然是会话日志。
 * - **不阻塞**：本模块不碰日志正文，也不做任何网络或 Host 交互。
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { appendFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

/** 索引里为每个会话保存的那一行。 */
export interface SessionIndexRow {
  /** 会话 id（同时是索引行的去重键）。 */
  sessionId: string
  /** 展示标题（会话标题或用户第一条 prompt 的提炼）。 */
  title?: string
  /** 列表副标题：最近一条真实用户提问的首行。 */
  preview?: string
  /** 第一条真实用户提问的全文首行，用于在没有 title 时兜底。 */
  firstUserMessage?: string
  cwd?: string
  createdAt?: number
  /** 最近一次用户提问的时间（`lastPromptAt`）。 */
  updatedAt?: number
  /** 日志字节数，用于按体量排序/统计，不必再 stat。 */
  sizeBytes?: number
  /** 会话来源；`subagent` 表示子会话。 */
  origin?: string
  /** 父会话 id。子会话靠它挂到父会话下，而不是变成孤儿。 */
  parentSessionId?: string
  /** 委派深度，0 表示主会话。 */
  delegationDepth?: number
  /** 写入这一行的时间，用于判断索引是否落后于日志。 */
  indexedAt?: number
}

/** 读取索引的结果，带上"是否需要刷新"的判断材料。 */
export interface SessionIndexSnapshot {
  rows: Map<string, SessionIndexRow>
  /** 索引文件不存在，或存在但没有可解析的行。 */
  empty: boolean
  /** 索引文件自身的 mtime（毫秒）；`undefined` 表示文件不存在。 */
  mtimeMs?: number
}

/** 追加写入时用的序列化：一行一个 JSON，末尾补换行。 */
export function serializeRow(row: SessionIndexRow): string {
  return `${JSON.stringify(row)}\n`
}

/**
 * 解析索引文本。
 *
 * 容错是刻意的：索引是派生数据，一行坏了不该让整个列表报错——跳过它，
 * 让那条会话回到"下次刷新时重建"的状态即可。
 */
export function parseIndexText(text: string): Map<string, SessionIndexRow> {
  const rows = new Map<string, SessionIndexRow>()
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const row = parsed as SessionIndexRow
    if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue
    // 后写的行覆盖先写的：追加式更新的语义。
    rows.set(row.sessionId, row)
  }
  return rows
}

/** 从用户消息正文里取一行可读的副标题。 */
export function previewOfText(text: string, limit = 160): string | undefined {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return undefined
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

/**
 * 索引文件的读写句柄。
 *
 * 刻意做成"薄"的：不持有定时器、不做后台刷新，所有时机由调用方决定。
 * 这样它在测试里可以完全没有副作用地跑。
 */
export class SessionIndexFile {
  readonly path: string
  /** 串行化写入，避免并发 append 交错成半行。 */
  private chain: Promise<void> = Promise.resolve()
  /** 已读入内存的行，避免每次列表都重读整份文件。 */
  private rows: Map<string, SessionIndexRow> | undefined
  private loadedMtimeMs: number | undefined
  /** 磁盘上的实际行数（含被覆盖的旧行），用于压实判断。 */
  private physicalRows = 0

  constructor(path: string) {
    this.path = path
  }

  /** 读取索引；文件不存在等价于空索引，不抛错。 */
  async read(): Promise<SessionIndexSnapshot> {
    const operation = this.chain.then(() => this.load())
    this.chain = operation.then(() => undefined)
    return operation
  }

  private async load(): Promise<SessionIndexSnapshot> {
    let text: string
    let mtimeMs: number | undefined
    try {
      const info = await stat(this.path)
      mtimeMs = info.mtimeMs
      text = await readFile(this.path, 'utf8')
    } catch {
      this.rows = new Map()
      this.loadedMtimeMs = undefined
      this.physicalRows = 0
      return { rows: this.rows, empty: true, mtimeMs: undefined }
    }
    const rows = parseIndexText(text)
    this.rows = rows
    this.loadedMtimeMs = mtimeMs
    this.physicalRows = text.split('\n').filter(line => line.length > 0).length
    return { rows, empty: rows.size === 0, mtimeMs }
  }

  /**
   * 取内存里的行，必要时先读盘。
   *
   * `reload` 为真时强制重读（索引被外部进程追加过）。多个 dshell 客户端
   * 共用一个 Host，只有 Host 会写索引，所以正常情况下不需要。
   */
  async rowsOf(reload = false): Promise<Map<string, SessionIndexRow>> {
    await this.chain
    if (this.rows !== undefined && !reload) return this.rows
    const snapshot = await this.read()
    return snapshot.rows
  }

  /** Append only changed records; all writes and compactions share one queue. */
  async append(row: SessionIndexRow): Promise<boolean> {
    return this.appendMany([row])
  }

  async appendMany(rows: readonly SessionIndexRow[]): Promise<boolean> {
    if (rows.length === 0) return true
    let ok = true
    this.chain = this.chain.then(async () => {
      const current = this.rows ?? (await this.load()).rows
      const pending = new Map(current)
      const changed: SessionIndexRow[] = []
      for (const row of rows) {
        const previous = pending.get(row.sessionId)
        const { indexedAt: _nextAt, ...nextFields } = row
        const { indexedAt: _previousAt, ...previousFields } = previous ?? {}
        if (previous !== undefined && isDeepStrictEqual(nextFields, previousFields)) continue
        const stamped = { ...row, indexedAt: row.indexedAt ?? Date.now() }
        changed.push(stamped)
        pending.set(stamped.sessionId, stamped)
      }
      if (changed.length === 0) return
      try {
        await appendFile(this.path, changed.map(serializeRow).join(''), 'utf8')
        for (const row of changed) current.set(row.sessionId, row)
        this.physicalRows += changed.length
        this.loadedMtimeMs = Date.now()
      } catch {
        ok = false
      }
    })
    await this.chain
    return ok
  }

  /**
   * 压实索引：把内存里的最终值重写成一份干净文件。
   *
   * 追加式的好处是写入便宜，代价是文件会不断变长（同一个会话被反复覆盖）。
   * 行数超过 `maxRows` 时压实一次即可。先写临时文件再 rename，保证读取方
   * 永远看到一份完整索引。
   */
  async compact(maxRows = 6_000): Promise<boolean> {
    let compacted = false
    this.chain = this.chain.then(async () => {
      if (this.physicalRows <= maxRows) return
      const rows = this.rows ?? (await this.load()).rows
      const text = [...rows.values()].map(row => serializeRow(row)).join('')
      const temporary = `${this.path}.tmp-${randomUUID()}`
      try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, this.path)
        this.rows = rows
        this.loadedMtimeMs = Date.now()
        this.physicalRows = rows.size
        compacted = true
      } catch {
        // This derived index can be rebuilt after a failed write.
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    })
    await this.chain
    return compacted
  }

  /** 索引是否比给定时间旧。用于判断要不要回源补几行。 */
  isStale(thresholdMs: number): boolean {
    if (this.loadedMtimeMs === undefined) return true
    return Date.now() - this.loadedMtimeMs > thresholdMs
  }
}

/**
 * 把一批会话头折叠成索引行。
 *
 * 只做纯映射：不读日志、不解析事件。`preview` / `firstUserMessage` 由调用方
 * 在**写入时**喂进来（这也是竞品的做法——副标题在产生时就存好，而不是列出
 * 时去回放整份正文）。
 */
export function rowsFromHeaders(headers: readonly {
  id: string
  cwd?: string
  createdAt?: number
  title?: string
  origin?: string
  parentSession?: string
  delegationDepth?: number
}[], extras?: Map<string, Partial<SessionIndexRow>>): SessionIndexRow[] {
  const rows: SessionIndexRow[] = []
  for (const header of headers) {
    const extra = extras?.get(header.id)
    const row: SessionIndexRow = { sessionId: header.id }
    if (header.cwd !== undefined) row.cwd = header.cwd
    if (header.createdAt !== undefined) row.createdAt = header.createdAt
    const title = extra?.title ?? header.title
    if (title !== undefined && title.length > 0) row.title = title
    if (header.origin !== undefined) row.origin = header.origin
    if (header.parentSession !== undefined) row.parentSessionId = header.parentSession
    if (header.delegationDepth !== undefined) row.delegationDepth = header.delegationDepth
    if (extra?.preview !== undefined) row.preview = extra.preview
    if (extra?.firstUserMessage !== undefined) row.firstUserMessage = extra.firstUserMessage
    if (extra?.updatedAt !== undefined) row.updatedAt = extra.updatedAt
    if (extra?.sizeBytes !== undefined) row.sizeBytes = extra.sizeBytes
    rows.push(row)
  }
  return rows
}

/** 子会话是否属于某个父会话。 */
export function isSubagentRow(row: SessionIndexRow): boolean {
  return row.origin === 'subagent' || row.parentSessionId !== undefined
}

/**
 * 保留期策略：按 `updatedAt` 判断某个会话是否已过期。
 *
 * 抄 Claude Code 的 `cleanupPeriodDays`：**最小 1 天，不接受 0**。Claude 的
 * 二进制里明确写了拒绝 0 的理由——曾经 0 会静默关掉全部 transcript 写入，
 * 而把它设成 0 想表达"永不清理"的用户并没预期到这个后果。
 */
export const MIN_CLEANUP_DAYS = 1

export function normalizeCleanupDays(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  const days = Math.floor(value)
  if (days < MIN_CLEANUP_DAYS) return MIN_CLEANUP_DAYS
  return days
}

/** 该会话是否早于保留期（`undefined` 保留期表示永不清理）。 */
export function isExpired(row: SessionIndexRow, cleanupDays: number | undefined, now = Date.now()): boolean {
  const days = normalizeCleanupDays(cleanupDays)
  if (days === undefined) return false
  const reference = row.updatedAt ?? row.createdAt
  if (reference === undefined) return false
  return now - reference > days * 86_400_000
}
