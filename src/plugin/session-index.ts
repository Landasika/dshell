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

import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'

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
    if (this.rows !== undefined && !reload) return this.rows
    const snapshot = await this.read()
    return snapshot.rows
  }

  /** 追加一行（新值覆盖旧值）。返回写入是否成功，失败不抛。 */
  async append(row: SessionIndexRow): Promise<boolean> {
    const merged = { ...row, indexedAt: row.indexedAt ?? Date.now() }
    const line = serializeRow(merged)
    let ok = true
    this.chain = this.chain.then(async () => {
      try {
        await appendFile(this.path, line, 'utf8')
      } catch {
        ok = false
        return
      }
      this.physicalRows += 1
      // 增量合并（理由见 appendMany）。原来这里是 this.rows = undefined，
      // 单行更新也会让整份缓存失效。
      if (this.rows !== undefined) {
        this.rows.set(merged.sessionId, merged)
        this.loadedMtimeMs = Date.now()
      }
    })
    await this.chain
    return ok
  }

  /**
   * 批量追加，合并成一次写。
   *
   * 这里曾经在写完后执行 `this.rows = undefined`，本意是"别让内存里的旧值
   * 盖住刚写的"。但那等于**每写一次就丢掉整份缓存**，下一次 rowsOf() 必须
   * 重新 readFile + JSON.parse 整个文件。
   *
   * 索引只追加时文件会一直变长（同一会话被反复覆盖）。两者叠加就是放大器：
   *
   *     每轮写 522 行 → rows 失效 → 重读整个文件 → 再写 → 再失效 …
   *
   * 实测这套循环把 dshell-ws/session-index.jsonl 撑到 484 MB / 226 万行，
   * 单次 readFile + parse 就要 1.5 GB 以上，直接把 Node 的 4.2 GB 堆打爆
   * （journal 里 8 次 `FATAL ERROR: Reached heap limit`）。
   *
   * 正确做法是**增量合并**：刚写的行本来就在手边，直接并进内存映射即可，
   * 完全不需要重读磁盘。
   */
  async appendMany(rows: readonly SessionIndexRow[]): Promise<boolean> {
    if (rows.length === 0) return true
    const now = Date.now()
    const stamped = rows.map(row => ({ ...row, indexedAt: row.indexedAt ?? now }))
    const text = stamped.map(row => serializeRow(row)).join('')
    let ok = true
    this.chain = this.chain.then(async () => {
      try {
        await appendFile(this.path, text, 'utf8')
      } catch {
        ok = false
        return
      }
      this.physicalRows += rows.length
      // 增量合并而不是丢弃。缓存不存在时保持 undefined（下次读盘是对的）。
      if (this.rows !== undefined) {
        for (const row of stamped) this.rows.set(row.sessionId, row)
        this.loadedMtimeMs = Date.now()
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
    // 阈值定在会话数的 ~11 倍：每轮会全量重写一遍索引（见 appendMany 的注释），
    // 所以"重复倍数"就是"跑了多少轮没压实"。6,000 行对应 526 个会话约 11 轮，
    // 文件约 1.4 MB —— 远小于把堆打爆的量级，同时压实频率也不高（约 5 分钟一次）。
    //
    // 之前这个值写成 20,000 太宽松：实测每 30 秒涨 524 行，要一个多小时才压一次，
    // 期间文件会到 5 MB 以上，虽然不至于 OOM，但没有必要留着。
    //
    // 先看阈值再决定要不要读盘：低于阈值时直接返回，避免为了一次整数比较
    // 去 readFile 整个文件（这正是之前把内存打爆的那条路径）。
    if (this.physicalRows <= maxRows) return false
    // 缓存还在就直接复用。原来固定传 true，等于强制重读一遍全量文件；
    // 而 append/appendMany 现在做的是增量合并，缓存本来就是最新的。
    const rows = this.rows ?? (await this.rowsOf(true))
    // 压实要按**磁盘上的行数**判断，而不是去重后的行数：追加式写入的膨胀
    // 正是"同一个 id 被反复覆盖"，去重后的 size 恒等于会话数，用它会永远
    // 判定为"不需要压实"。
    if (this.physicalRows <= maxRows) return false
    const text = [...rows.values()].map(row => serializeRow(row)).join('')
    const temporary = `${this.path}.tmp-${String(process.pid)}`
    try {
      await writeFile(temporary, text, 'utf8')
      await rename(temporary, this.path)
      this.rows = undefined
      this.physicalRows = rows.size
      return true
    } catch {
      return false
    }
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
