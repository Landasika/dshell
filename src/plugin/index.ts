import { AsyncLocalStorage } from 'node:async_hooks'
import { stringify, parseDocument } from 'yaml'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'

import { UnixSocketChannel, type Channel } from './channel.js'
import { acquireFileLock } from './file-lock.js'
import { acceptUpgrade, WebSocketChannel } from './websocket.js'
import { basename, dirname, join, resolve, sep } from 'node:path'

import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  type AgentPresetSummary,
  type AgentRosterMessage,
  type ProviderEntry,
  type PromptContentPart,
  type QuestionAnswer,
  type QuestionClosedMessage,
  type QuestionRequestMessage,
  type SkillEntry,
  type ApprovalRequestMessage,
  type Capability,
  type ErrorMessage,
  type AskedQuestion,
  type HistoryMessage,
  type ModelCatalog,
  type ModelSelection,
  type SessionCreatedMessage,
  type SessionEvent,
  type SessionHeader,
  type SessionSummary,
  type WorkspaceSummary,
} from '../protocol/index.js'
import { resolveDshHome, resolveSocketPath } from '../shared/paths.js'
import { zstdDecompressSync } from 'node:zlib'
import { latestUserPreview } from '../shared/session-events.js'
import { advanceModelSelection, readModelSelection, type ModelSelectionState } from '../shared/model-selection.js'
import { DeviceStore, PairCodes, hostName } from './devices.js'
import { ApprovalCoordinator } from './approval.js'
import { openHistory, historyEvents, type HarnessHistoryOwner } from './harness-history.js'
import {
  SessionIndexFile,
  rowsFromHeaders,
  isSubagentRow,
  isExpired,
  normalizeCleanupDays,
  previewOfText,
  serializeRow,
  type SessionIndexRow,
} from './session-index.js'
import {
  HUB_PROVIDER,
  createBundledProvider,
  createHubProvider,
  readSkillFile,
  resolveHubDirs,
  toSkillEntry,
  watchSkillDirs,
  type SkillsRegistryLike,
} from './skills.js'
import {
  ProviderEditError,
  addProvider,
  clearProviderField,
  hasProviderConfig,
  isProviderField,
  readProviderDetail,
  syncProviderModels,
  readProviders,
  removeProvider,
  setProviderField,
} from './profile.js'

export const name = 'dshell-host'
export const inject = [
  'agents',
  'sessions',
  'sessionQuery',
  'workspaceRegistry',
  'agentPresets',
  'agentDefaultModel',
]

export interface Config {
  socketPath?: string
  /**
   * WebSocket 监听端口，给手机 App 与桌面宠物用。
   *
   * 它们和 CLI 共用同一个中枢：订阅表、广播、审批协调都是同一份，所以
   * 手机上点的审批桌面立刻能看到，多端天然同步。省略则不开放网络端口
   * （只有本机 CLI 能用）。
   */
  wsPort?: number
  /** WebSocket 绑定的地址。默认 0.0.0.0（手机要通过局域网连）。 */
  wsHost?: string
  /** 设备表路径；默认 `$DSH_HOME/dshell-ws/devices.json`。 */
  deviceFile?: string
  /** Hard fail-closed deadline for an unanswered CLI approval. */
  approvalTimeoutMs?: number
  /**
   * 会话列表查询的预算（毫秒），默认 15 秒。
   *
   * 超时会返回 `SESSION_LIST_TIMEOUT` 错误而不是空列表。做成可配主要是
   * 为了测试能快速跑——正常部署不该动它。
   */
  sessionListTimeoutMs?: number
  /** 启动后是否预热会话列表缓存，默认 true。测试里关掉以免抢占数据准备。 */
  warmSessionList?: boolean
  /**
   * 会话轻索引文件路径；默认 `$DSH_HOME/dshell-ws/session-index.jsonl`。
   *
   * 索引只存列表需要的字段（标题、副标题、时间、归档/置顶、父子边），
   * 让"列会话"不必解析日志正文。索引是可丢弃的派生数据：删掉只会让下次
   * 列表慢一次。Claude Code 用 `~/.claude/history.jsonl`、Codex 用
   * `state_5.sqlite` 的 `threads` 表，都是同一个思路。
   */
  sessionIndexFile?: string
  /**
   * 会话保留天数；默认不清理。
   *
   * 抄 Claude Code 的 `cleanupPeriodDays`：最小 1 天，**0 会被抬到 1**——
   * 把 0 当作"永不清理"是常见误解，而它曾经真的会关掉写入。这里只用于
   * 索引侧的过期标记与报表，不会自动删日志。
   */
  cleanupPeriodDays?: number
  /**
   * Extra skill hubs (directories of `SKILL.md` bundles) served through
   * `ctx.skills`; `/skills` lists them alongside project and user skills.
   */
  skillHub?: string | string[]
}

interface UserMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user'; rpcId?: string } | { kind: 'user-question-reply'; callId: string; outcome: 'answered' }
}

interface InboxLike {
  nextTurn: readonly UserMessageLike[]
  nextStep: readonly UserMessageLike[]
  remove(id: string): boolean | void
  replace(id: string, message: UserMessageLike): void
}

/**
 * dsh 内核压缩服务的最小结构。
 *
 * 只写 dshell 真正调用到的部分：`compactNow`。其余（范围压缩等）留给用得上
 * 的地方再补，避免把内核一整个 API 面抄进来。
 */
/**
 * dsh 内核的 commands 服务（`ctx.commands`）的最小结构。
 *
 * 只声明 dshell 用到的 `execute`：把一个斜杠命令行交给内核执行。
 * `/compact`、`/goal` 这类"给人类用的命令"都由它注册，具体实现留在内核里。
 */
interface CommandsServiceLike {
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ text?: string } | undefined>
}

interface AgentLike {
  id: string
  status?: 'idle' | 'running'
  session: { id: string }
  followup(message: UserMessageLike): void
  steer(message: UserMessageLike): void
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  inbox?: InboxLike
}

interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

interface SessionRecordLike {
  header: {
    id: string
    cwd?: string
    createdAt?: number
    title?: string
    origin?: string
    parentSession?: string
    delegationDepth?: number
  }
  live: boolean
  persisted: boolean
  formatStatus?: string
}

interface SessionSnapshotLike {
  session: SessionHeader
  events: SessionEvent[]
}

interface SessionObservationLike {
  header: SessionHeader
  events: SessionEvent[]
  projections?: {
    values: {
      agentPreset?: string
      modelSelection?: {
        lastUsed?: Record<string, unknown>
        next?: Record<string, unknown>
      }
    }
  }
  [Symbol.dispose](): void
}

interface SessionTitleResultLike {
  sessionId: string
  status: 'fulfilled' | 'rejected'
  value?: {
    title?: {
      title?: string
    }
  }
}

interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<SessionTitleResultLike[]>
  readSession(sessionId: string): Promise<SessionSnapshotLike>
  observeSession(sessionId: string, options?: { projectionMode?: 'all' | 'none' }): Promise<SessionObservationLike>
}

interface WorkspaceLike {
  id: string
  path: string
  title: string
  sessionIds?: readonly string[]
  attachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  archiveSession?(id: string): Promise<void>
  unarchiveSession?(id: string): Promise<void>
  pinSession?(id: string): Promise<void>
  unpinSession?(id: string): Promise<void>
  list(): WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
  create(path: string, title?: string): Promise<WorkspaceLike>
  /** 按路径查已登记的 workspace（内部会 realpath 归一化）。 */
  resolveByPath?(path: string): Promise<WorkspaceLike | undefined>
}

interface ApprovalRequestLike {
  agent: AgentLike
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

interface AgentPresetLike {
  id: string
}

interface AgentPresetRegistryLike {
  resolve(id?: string): Promise<AgentPresetLike>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
  /** Live registry config: the selected default and its fallback. */
  config?: {
    selectedDefault?: { get?(): unknown }
    default?: { get?(): unknown }
  }
}

/** One addressable row of the profile composition, as the config editor sees it. */
interface ConfigRowLike {
  inherited?: Record<string, unknown>
  entry: { options: { id: string; name?: string; config?: unknown } }
  override: Record<string, unknown>
}

interface ConfigEditorLike {
  documentPath?: string
  configuration?(): readonly ConfigRowLike[]
  edit?(entry: ConfigRowLike['entry'], change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** The plugin package a row must mount to declare an agent preset. */
const AGENT_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

interface AgentDefaultModelLike {
  currentSelection(): Record<string, unknown>
  saveSelection?(selection: ModelSelection): Promise<void>
}

interface SessionControllerLike extends HarnessHistoryOwner {
  cancel?(request: { sessionId: string }): { accepted: true } | Promise<{ accepted: true }>
  rename?(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  fork?(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  modelCatalog(): Promise<ModelCatalog>
  prompt?(request: { sessionId: string; requestId: string; mode: 'queue' | 'steer'; content: PromptContentPart[] }, signal: AbortSignal): Promise<unknown>
  resolveAgent?(sessionId: string): Promise<{ agent: AgentLike } | { error: Error }>
  create?(request: { cwd?: string; workspaceId?: string; sessionId?: string }): Promise<{ sessionId: string }>
  selectModel(request: ModelSelection & { sessionId: string }): Promise<{ selected: ModelSelection }>
  list?(
    request: { cursor?: string },
    /** dshell 不传：abort 传进 host 查询链会把 host 打死（见 listSessionsFresh）。 */
    signal?: AbortSignal,
  ): Promise<{ items: readonly { sessionId: string; updatedAt: number; running?: boolean }[] }>
}

interface PluginContext {
  agents: {
    get(sessionId: string): AgentLike | undefined
    list(): AgentLike[]
    resume(options: {
      resumeSessionId: string
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandleLike>
    create(options: {
      sessionId: string
      meta?: {
        cwd?: string
        agentPreset?: string
      }
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandleLike>
  }
  sessions: unknown
  sessionQuery: SessionQueryLike
  workspaceRegistry?: WorkspaceRegistryLike
  agentPresets?: AgentPresetRegistryLike
  agentDefaultModel?: AgentDefaultModelLike
  sessionController?: SessionControllerLike
  get?(name: string): unknown
  on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean; prepend?: boolean }): () => void
  effect(setup: () => void | (() => void | Promise<void>)): void
}

/** Stable fingerprint of a provider list, compared before and after a write. */
function providerSignature(rows: readonly ProviderEntry[]): string[] {
  return rows.map((row) =>
    [row.id, row.displayName ?? '', row.baseURL ?? '', row.api ?? '', row.apiKeyEnv ?? '', String(row.models)].join('\u0000'))
}

function readProviderEntries(text: string): ProviderEntry[] {
  return readProviders(text).map((record) => ({
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.baseURL === undefined ? {} : { baseURL: record.baseURL }),
    ...(record.api === undefined ? {} : { api: record.api }),
    ...(record.apiKeyEnv === undefined ? {} : { apiKeyEnv: record.apiKeyEnv }),
    models: record.models,
  }))
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function inferDshVersion(): string {
  const configured = process.env.DSH_VERSION
  if (configured !== undefined && configured.length > 0) return configured
  try {
    const bin = process.argv[1]
    if (bin !== undefined) {
      const parsed = JSON.parse(readFileSync(join(dirname(bin), '..', 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (typeof parsed.version === 'string') return parsed.version
    }
  } catch {
    // The plugin also runs in tests and in non-standard launchers.
  }
  return 'unknown'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mappedError(error: unknown): ErrorMessage {
  const code = (error as { code?: unknown }).code
  const message = errorText(error)
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || /session .*not found|not found/i.test(message)) {
    return {
      type: 'error',
      code: 'SESSION_NOT_FOUND',
      message,
      action: 'Run `dshell list` and attach an existing session.',
    }
  }
  if (code === 'session/writer-held' || /already owned by an active write/i.test(message)) {
    return {
      type: 'error',
      code: 'SESSION_ALREADY_LIVE',
      message,
      action: 'Another Host or the Web UI is writing this session right now. Wait for that turn, or open a different session.',
    }
  }
  if (/already registered|already live/i.test(message)) {
    return {
      type: 'error',
      code: 'SESSION_ALREADY_LIVE',
      message,
      action: 'Attach the session instead of resuming it twice.',
    }
  }
  return { type: 'error', code: 'INTERNAL', message }
}

const rpcContext = new AsyncLocalStorage<{ channel: Channel; rpcId?: string }>()
const BROADCAST_TYPES = new Set(['event', 'stream', 'status', 'approval-request', 'approval-resolved', 'question/request', 'question/closed'])
/**
 * 写一条消息给某个通道。
 *
 * 改造前这里直接操作 `net.Socket`（检查 destroyed/writable、16MB 积压、
 * 手动加换行）。那些都属于传输细节，现在由 `Channel` 实现自己负责，
 * 中枢只表达"发这条消息"。
 *
 * `rpcId` 回填逻辑不变：只有当前 RPC 的发起通道拿得到它，广播类型不回填
 * （否则一次广播会把某个客户端的 rpcId 泄漏给所有人）。
 */
function jsonLine(channel: Channel, message: unknown): void {
  if (!channel.alive) return
  const context = rpcContext.getStore()
  const payload = message as { type?: string }
  const outgoing = context?.channel === channel && context.rpcId && !BROADCAST_TYPES.has(payload.type ?? '')
    ? { ...payload, rpcId: context.rpcId } : payload
  channel.write(outgoing)
}

/**
 * Bound a host-side query that may contend with another Host over the same
 * DSH home. Resolves to `undefined` on timeout so callers can degrade to an
 * empty/summary view instead of blocking every connected client.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[dshell-host] ${label} timed out after ${timeoutMs}ms`)
      resolve(undefined)
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        console.error(`[dshell-host] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
        resolve(undefined)
      },
    )
  })
}

/** Outcome of probing a control-socket path for an existing listener. */
export type SocketProbeOutcome = 'connected' | 'refused' | 'unknown'

/**
 * Probe whether another dshell host is listening on `socketPath`.
 *
 * Only `refused` means the path is definitely safe to reclaim. A busy host's
 * event loop may accept too slowly for the probe to complete — that is
 * `unknown`, never proof the file is stale, and must not be treated as one
 * (a host that unlinked a live peer's socket split every client across two
 * servers; see the socket-probe tests).
 */
export function probeSocket(socketPath: string, timeoutMs = 1_000): Promise<SocketProbeOutcome> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const settle = (value: SocketProbeOutcome) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => settle('unknown'), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      settle('connected')
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'refused' : 'unknown')
    })
    socket.connect(socketPath)
  })
}

export async function prepareSocketPath(
  socketPath: string,
  probe: (path: string) => Promise<SocketProbeOutcome> = probeSocket,
): Promise<void> {
  const directory = dirname(socketPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // The directory may be owned by a manager with a different policy.
  }

  try {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket()) {
      throw new Error(`refusing to replace non-socket path: ${socketPath}`)
    }
    const outcome = await probe(socketPath)
    if (outcome === 'connected') {
      throw new Error(`another dshell host is already listening on ${socketPath}`)
    }
    if (outcome === 'unknown') {
      throw new Error(
        `refusing to replace ${socketPath}: the probe could not confirm it is stale ` +
        '(another host may be listening but slow to answer); ' +
        'if that host is really gone, delete the socket file and reload',
      )
    }
    unlinkSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  // A half-open client can keep server.close pending forever; bound the
  // shutdown so a restart handover never stalls on one.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000)
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function apply(ctx: PluginContext, config: Config = {}): Promise<void> {
  const socketPath = resolveSocketPath(config.socketPath)
  await prepareSocketPath(socketPath)

  /**
   * WebSocket 相关的凭据。
   *
   * unix socket 靠文件权限保护，网络端口没有这层保护——任何能访问端口的人
   * 都能对会话发 prompt。所以 WS 客户端必须持 token，而 CLI 不需要。
   */
  const devices = new DeviceStore(config.deviceFile)
  const pairCodes = new PairCodes()

  const clients = new Set<Channel>()
  const watched = new Map<Channel, Set<string>>()
  const handles = new Map<string, AgentHandleLike>()
  const resuming = new Map<string, Promise<AgentHandleLike>>()
  const queues = new WeakMap<Channel, Promise<void>>()
  const approvalTimeoutMs = config.approvalTimeoutMs ?? 120_000
  let closing = false

  /** 目录是否真实存在（跟随软链；不是文件）。补登记前用它挡掉已删项目。 */
  const existsAsDirectory = async (path: string): Promise<boolean> => {
    try {
      const { stat } = await import('node:fs/promises')
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * 把「有会话但没登记」的目录补进 workspace 注册表。
   *
   * 为什么需要：历史 bug 让 `controller.create({ cwd })` 只建会话、不注册
   * workspace（内核里 `workspace` 为空就跳过 attachSession），于是那些目录
   * 永远进不了 workspace.json。之后任何按 workspace 过滤的会话列表都会把
   * 它们静默丢掉——用户以为"会话又没了"，其实日志一直完好。
   *
   * 两道保险，缺一不可：
   *  1. **只认父会话**。子 agent 的 cwd 与父会话相同，把它们算进来不会多出
   *     目录，却会让统计口径混乱；更重要的是子会话本就不该出现在会话列表
   *     （`isSubagentRow` 负责过滤），补登记也只该围绕父会话做。
   *  2. **只注册磁盘上真实存在的目录**。删掉的项目不该被重新创建成一个
   *     空壳 workspace——那会在选择器里留下永远打不开的条目。
   *
   * 幂等：已经登记的路径用 `resolveByPath` 命中后直接跳过，不 touch 记录，
   * 所以每次启动跑一遍是安全的，也不会打乱用户手动调整过的顺序。
   */
  const adoptOrphanWorkspaces = async (): Promise<number> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) return 0
    const rows = await sessionIndex().rowsOf()
    if (rows.size === 0) return 0
    // 父会话的 cwd 去重；子会话按 isSubagentRow 排除。
    const candidates = new Set<string>()
    for (const row of rows.values()) {
      if (isSubagentRow(row)) continue
      if (row.cwd === undefined || row.cwd.length === 0) continue
      candidates.add(row.cwd)
    }
    let adopted = 0
    for (const path of candidates) {
      // 已登记就跳过：resolveByPath 内部会 realpath 归一化，避免同一个
      // 目录因为软链或尾部斜杠被当成两个 workspace。
      //
      // 注意 `resolveByPath` 是可选方法：缺失时它返回 undefined，而
      // `undefined !== undefined` 是 false —— 直接写 `if (x !== undefined)
      // continue` 会把**每一个**目录都当成"已登记"跳掉，补登记静默失效。
      // 所以必须显式区分"方法不存在"和"没查到"。
      if (registry.resolveByPath !== undefined) {
        if (await registry.resolveByPath(path) !== undefined) continue
      } else if (registry.list().some((workspace) => workspace.path === path)) {
        continue
      }
      // 目录不存在就不登记：宁可让那条会话暂时查不到，也不留空壳 workspace。
      if (!(await existsAsDirectory(path))) continue
      try {
        await registry.create(path)
        adopted += 1
      } catch {
        // 单个目录失败（权限、竞态）不该阻断其余目录的补登记。
      }
    }
    return adopted
  }

  const workspaceList = (): WorkspaceSummary[] => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) return []
    return registry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...(workspace.sessionIds ?? [])],
    }))
  }

  // Enumerating a large shared DSH home is the single slowest control call:
  // hundreds of session logs plus their projection snapshots. Cache the folded
  // list briefly, resolve titles only for the sessions we actually return, and
  // keep subagent children out of the picker (they belong to a parent's roster).
  const sessionCache = new Map<string, { at: number; sessions: SessionSummary[] }>()
  /** Running-session input state, cached with the same TTL as the list. */
  const activePrompt = new Map<string, string>()
  /**
   * 「此刻正在等用户」的会话集合，按原因分开。
   *
   * 存在的唯一理由是性能：列表要为 257 个会话各判一次，而
   * `approvals.snapshot()` 每次都要摊一遍 pending 表。用集合把查询降到 O(1)。
   *
   * 这两个集合是**派生缓存**，真相在 `approvals` / `questionRequests` 里；
   * 只要在开始和结束两端都维护，就不会漂。
   */
  const waitingApproval = new Set<string>()
  const waitingQuestion = new Set<string>()
  /** Pending approval details for session-list cards, including unwatched sessions. */
  const pendingApprovalInfo = new Map<string, {
    sessionId: string
    toolName?: string
    reason?: string
    expiresAt?: number
  }>()
  /**
   * 严格排队：用户按"排队"发的消息**先留在这里**，等当前回合真的结束了
   * 才交给内核。
   *
   * 为什么不能直接丢给内核：内核 `dsh-agent-loop` 的 `preStep` 每个 step 都会
   * 调用 `inbox.claim('next-turn', ...)`，而 `claim` 会顺手吃掉 1 条
   * next-turn。step 的粒度是**一次工具调用**，不是一轮对话——于是一轮里
   * 几十个 step 中随便哪一个都会把排队消息捎走，"排队"变成了"下一步就插进去"。
   *
   * 实测：发一条排队消息后 0.0 秒就收到 `agent/inbox/spliced target=next-turn`，
   * 再 0.0 秒就 accepted，用户在手机上连撤回的窗口都没有。
   *
   * 所以这里把它截下来，按 FIFO 存在插件侧；监听 `turn/end` / `turn/failed`，
   * 回合真正收尾了才按顺序投递。
   */
  interface DeferredPrompt {
    requestId: string
    content: PromptContentPart[]
    sessionId: string
    channel: Channel
  }
  const deferredQueue = new Map<string, DeferredPrompt[]>()
  const deferredTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Keep the reservation through admission and the entire resulting turn.
  const deferredFlights = new Map<string, { started: boolean }>()
  const titleCache = new Map<string, { at: number; title: string }>()
  const previewCache = new Map<string, { at: number; preview: string }>()
  /**
   * 一条会话当前处在什么相位。
   *
   * 输入是 Host 已经算好的投影（`running` / `needsInput` / `status`），
   * 不是原始事件流——重扫事件既慢又会和 Host 的判断打架。
   */
  type PetPhase = 'idle' | 'thinking' | 'working' | 'waiting-approval' | 'completed' | 'error'
  const phaseOf = (row: SessionSummary): PetPhase => {
    // 等待用户输入优先级最高：宠物要立刻表现出"需要你"
    if (row.needsInput === 'approval' || row.needsInput === 'question') return 'waiting-approval'
    if (row.running === true) {
      // `listSessions` 的 status 只有 running/live/idle 三值——"在调工具"与
      // "在思考"的分界在事件日志里，而这份列表故意不读事件日志（那会很慢）。
      // 所以统一报 `working`：对挂件来说"有活在跑"就够表达，不必知道细节。
      return 'working'
    }
    if (row.status === 'error') return 'error'
    if (row.status === 'completed') return 'completed'
    return 'idle'
  }

  /** 组装并推送一份聚合状态。宠物连上时推一次，之后按需推。 */
  const sendPetState = async (channel: Channel): Promise<void> => {
    if (!channel.alive) return
    try {
      const rows = await listSessions(undefined, false)
      // 查不到就一个字节都别推：推一份空 `state` 会让宠物显示"什么都没在跑"，
      // 而实际上只是这次查询超时了。宁可保持它上一帧。
      if (rows === null) return
      if (!channel.alive) return
      const sessions = rows.slice(0, 30).map((row) => {
        const perms = permissionsOf(row.sessionId)
        return {
          id: row.sessionId,
          title: row.title ?? '',
          phase: phaseOf(row),
          updatedAt: row.updatedAt ?? row.createdAt ?? 0,
          preview: row.preview ?? '',
          // 带上待决审批的 requestId，客户端才能**不 attach** 就画出可点的
          // 审批卡。没有它的话，state 只能说"这条在等审批"，却点不了。
          ...(perms.length === 0 ? {} : { permissions: perms }),
        }
      })
      jsonLine(channel, {
        type: 'state',
        sessions,
        running: sessions.filter((entry) => entry.phase === 'thinking' || entry.phase === 'working').length,
        waitingApproval: sessions.filter((entry) => entry.phase === 'waiting-approval').length,
        focus: sessions.find((entry) => entry.phase === 'thinking' || entry.phase === 'working')?.title ?? '',
        at: Date.now(),
      })
    } catch {
      // 状态是增值信息；取不到就不推，不能让宠物连接因此中断
    }
  }

  const SESSION_LIST_TIMEOUT_MS = config.sessionListTimeoutMs ?? 15_000
  /**
   * 会话轻索引。列表优先读它，慢路径只在后台补全。
   *
   * 路径放在 `dshell-ws/` 下，与设备表同处：它是 dshell 自己的派生数据，
   * 不该混进 dsh 的 `storages/`。
   */
  let sessionIndexInstance: SessionIndexFile | undefined
  const sessionIndex = (): SessionIndexFile => {
    if (sessionIndexInstance === undefined) {
      const base = dshHome() ?? join(process.env.HOME ?? '.', '.dsh')
      sessionIndexInstance = new SessionIndexFile(
        config.sessionIndexFile ?? join(base, 'dshell-ws', 'session-index.jsonl'),
      )
    }
    return sessionIndexInstance
  }
  /** 保留期（天）；未配置表示不做过期标记。 */
  const cleanupDays = normalizeCleanupDays(config.cleanupPeriodDays)
  /**
   * 索引是否已经至少完整读过一次。
   *
   * 索引为空时（首次运行、刚删过）必须先走一次慢路径把它填起来，否则
   * 列表会永远是空的——"可丢弃"不等于"可以当作权威的空"。
   */
  let indexPrimed = false
  /** 索引正在被首次填充；期间的列表请求沿用慢路径并等它。 */
  let priming: Promise<void> | undefined
  const SESSION_CACHE_MS = 4_000
  const PREVIEW_CACHE_MS = 300_000
  const PREVIEW_ROWS = 24
  const PREVIEW_BUDGET_MS = 1_500
  /** 索引命中后的后台全量补全最小间隔：多端轮询不该把枚举变成常驻负载。 */
  const BACKGROUND_LIST_INTERVAL_MS = 30_000
  /** 上次全量枚举发起时刻（含直查与启动预热）；后台补全按它限流。 */
  let lastFreshListAt = 0

  /**
   * @returns 会话摘要列表；**`null` 表示这次查不到**（底层查询超时/抛错）。
   *
   * `null` 和 `[]` 必须分开：前者是"不知道"，后者是"确认没有"。
   * 原先超时直接 `return []`，于是把一次 15 秒的查询超时伪装成了
   * "这台机器上一个会话都没有"——客户端首页因此显示空，而用户的
   * 6 个 live 会话其实一直在跑。这不是降级，是**谎报**。
   */
  /**
   * 后台刷新中的 key：避免多个调用方同时触发同一次慢查询。
   *
   * 枚举 249 个会话要十几秒，如果每个轮询/每个客户端都开一次，慢查询会
   * 互相叠加，把整个 host 拖死。
   */
  const inflightList = new Map<string, Promise<SessionSummary[] | null>>()

  /** 开一轮后台全量枚举，登记进 [inflightList] 去重。 */
  const spawnBackgroundList = (
    workspaceId: string | undefined,
    includeArchived: boolean,
    cacheKey: string,
  ): Promise<SessionSummary[] | null> =>
    // host 把任何 unhandledRejection 当致命错误 exit(1)，后台任务必须就地吞拒绝。
    listSessionsFresh(workspaceId, includeArchived)
      .catch((): SessionSummary[] | null => null)
      .finally(() => { inflightList.delete(cacheKey) })

  /**
   * 从轻索引直接构造列表（毫秒级）。
   *
   * 这条路径**不读任何会话日志**，也不调 `sessionQuery.listSessions()`，
   * 所以它不会超时。索引里没有的会话就不会出现——这是刻意的取舍：列表是
   * 元数据视图，完整性由后台补全去追，而不是让用户等 15 秒。
   *
   * `running` / `status` 这类"此刻状态"索引给不了，保持 `undefined`
   * （= 不知道），而不是写成 `idle`（= 确认没在跑）。
   */
  /**
   * 「这个会话此刻是不是在等人」——纯内存判断，O(1)，不读文件。
   *
   * 两处调用方（索引主路径、慢路径）都要用它。之前只有慢路径有推断逻辑，
   * 而索引命中时根本走不到慢路径，所以手机首页永远拿不到 needsInput。
   */
  /** Build actionable approval cards from the pending request details. */
  const permissionsOf = (sessionId: string): NonNullable<SessionSummary['permissions']> => {
    const found: NonNullable<SessionSummary['permissions']> = []
    for (const [requestId, info] of pendingApprovalInfo) {
      if (info.sessionId !== sessionId) continue
      found.push({
        requestId,
        ...(info.toolName === undefined ? {} : { toolName: info.toolName }),
        ...(info.reason === undefined ? {} : { reason: info.reason }),
        ...(info.expiresAt === undefined ? {} : { expiresAt: info.expiresAt }),
      })
    }
    return found
  }

  /**
   * 放行一条排队消息。
   *
   * 一次只放一条，且只在回合确实结束（`agent.status !== 'running'`）时才放：
   * 连放两条的话，内核会在新回合的第一个 step 里把第二条也 claim 走，
   * 于是"排队"又退化回"插队"。
   */
  const flushDeferred = async (sessionId: string): Promise<void> => {
    if (closing || deferredFlights.has(sessionId) || deferredTimers.has(sessionId)) return
    const list = deferredQueue.get(sessionId)
    if (list === undefined || list.length === 0) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      // 会话没了（被删/进程重启），留着只会一直占内存。
      deferredQueue.delete(sessionId)
      return
    }
    if (agent.status === 'running') {
      const timer = setTimeout(() => {
        deferredTimers.delete(sessionId)
        void flushDeferred(sessionId)
      }, 300)
      timer.unref()
      deferredTimers.set(sessionId, timer)
      return
    }
    const next = list.shift()
    if (next === undefined) return
    if (list.length === 0) deferredQueue.delete(sessionId)
    const flight = { started: false }
    deferredFlights.set(sessionId, flight)
    try {
      const controller = sessionController()
      if (controller?.prompt) {
        await controller.prompt(
          { sessionId: next.sessionId, requestId: next.requestId, mode: 'queue', content: next.content },
          new AbortController().signal,
        )
      } else {
        const text = next.content
          .filter((part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text')
          .map(part => part.text)
          .join('\n')
        agent.followup({
          id: next.requestId,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: next.requestId },
        })
      }
      if (next.channel.alive) {
        jsonLine(next.channel, {
          type: 'accepted',
          sessionId: next.sessionId,
          requestId: next.requestId,
          mode: 'queue',
          promoted: true,
        })
      }
    } catch (error) {
      if (deferredFlights.get(sessionId) === flight) deferredFlights.delete(sessionId)
      if (next.channel.alive) {
        sendError(next.channel, {
          type: 'error',
          code: 'QUEUE_DELIVERY_FAILED',
          message: error instanceof Error ? error.message : 'queued prompt could not be delivered',
        })
      }
    }
  }

  const liveInputOf = (sessionId: string): 'approval' | 'question' | undefined => {
    // 注意：不要写成 `approvals.snapshot(sessionId).length > 0`。
    // snapshot 内部是 [...pending.values()].filter(...)，对每个会话都摊一次
    // 整张表；列表有 257 个会话时就是 257 次无谓遍历。这里用一个按会话
    // 累加的集合，查询是 O(1)。
    if (waitingApproval.has(sessionId)) return 'approval'
    if (waitingQuestion.has(sessionId)) return 'question'
    return undefined
  }

  const listSessionsFromIndex = async (
    workspaceId: string | undefined,
    includeArchived: boolean,
  ): Promise<SessionSummary[] | undefined> => {
    const rows = await sessionIndex().rowsOf()
    if (rows.size === 0) return undefined
    const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    const pinned = new Set(ctx.workspaceRegistry?.pinnedSessionIds ?? [])
    const workspaces = workspaceList()
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
    // 过滤时也要认同 cwd 而不是只认 workspace 注册表。
    //
    // 历史原因：`controller.create({ cwd })` 只建会话、不注册 workspace，
    // 于是这些目录从来没进过 workspace.json。旧写法
    // `workspace?.id !== workspaceId` 在 workspace 为 undefined 时成立，
    // 把整条会话 `continue` 掉——用户看到"会话又没了"，但磁盘上的
    // session.v4.jsonl.zstd 一直是好的。
    //
    // 这里改成：注册表里查不到 workspace 时，只要 row.cwd 等于目标
    // workspace 的 path，也算属于它。列表因此能显示这些"孤儿"会话；
    // 真正的新建路径已在 createSession 里修好，不会再产生新的孤儿。
    const targetPath = workspaceId === undefined
      ? undefined
      : workspaces.find((workspace) => workspace.id === workspaceId)?.path
    const sessions: SessionSummary[] = []
    for (const row of rows.values()) {
      // 子会话（subagent）不进展柜：它们挂在父会话下，靠索引里的父子边查。
      if (isSubagentRow(row)) continue
      const isArchived = archived.has(row.sessionId)
      if (!includeArchived && isArchived) continue
      const workspace = row.cwd === undefined ? undefined : workspaceByPath.get(row.cwd)
      if (workspaceId !== undefined) {
        const belongs = workspace?.id === workspaceId
          || (targetPath !== undefined && row.cwd === targetPath)
        if (!belongs) continue
      }
      const summary: SessionSummary = { sessionId: row.sessionId }
      if (row.title !== undefined && row.title.length > 0) summary.title = row.title
      if (row.cwd !== undefined) summary.cwd = row.cwd
      if (row.createdAt !== undefined) summary.createdAt = row.createdAt
      if (row.updatedAt !== undefined) summary.updatedAt = row.updatedAt
      if (isArchived) summary.archived = true
      if (pinned.has(row.sessionId)) summary.pinned = true
      if (workspace !== undefined) summary.workspaceId = workspace.id
      // 索引本身给不出此刻是否在跑（它只是磁盘上的元数据摘要），
      // 但 **Host 内存里知道**：`ctx.agents` 只装真正活着的 agent，
      // 查得到就是 running。这是 O(1)，不读任何文件。
      //
      // 这里必须补，因为**索引路径才是主路径**：`listSessions` 命中索引
      // 就直接返回，根本走不到 `listSessionsFresh` 里那段状态推断。
      // 只在慢路径修，手机上看到的仍然是错的。
      const liveStatus = ctx.agents.get(row.sessionId)?.status
      if (liveStatus !== undefined) {
        summary.status = liveStatus
        if (liveStatus === 'running') summary.running = true
      }
      // 同上：索引路径是主路径，必须也带上「有人在等你」。
      // 这里查的是两张内存表（O(1)、无 IO），不是读会话文件，所以不会
      // 把这条毫秒级路径拖慢。
      const waiting = liveInputOf(row.sessionId)
      if (waiting !== undefined) summary.needsInput = waiting
      const pendingPerms = permissionsOf(row.sessionId)
      if (pendingPerms.length > 0) summary.permissions = pendingPerms
      summary.persisted = true
      if (row.preview !== undefined && row.preview.length > 0) summary.preview = row.preview
      sessions.push(summary)
    }
    sessions.sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true)
      || (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0))
    return sessions
  }

  const listSessions = async (workspaceId?: string, includeArchived = false): Promise<SessionSummary[] | null> => {
    const cacheKey = `${workspaceId ?? ''}:${includeArchived ? 'archived' : 'active'}`
    const cached = sessionCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < SESSION_CACHE_MS) return cached.sessions
    // 索引命中就先给索引结果，同时后台补全。这是与竞品对齐的主路径：
    // 列会话读索引，不解析正文。索引为空时（首次运行）才走慢路径。
    if (indexPrimed) {
      const fromIndex = await listSessionsFromIndex(workspaceId, includeArchived)
      if (fromIndex !== undefined) {
        if (!inflightList.has(cacheKey) && Date.now() - lastFreshListAt >= BACKGROUND_LIST_INTERVAL_MS) {
          inflightList.set(cacheKey, spawnBackgroundList(workspaceId, includeArchived, cacheKey))
        }
        return fromIndex
      }
    }
    // 陈旧但存在的数据：**先返回它**，同时后台刷新。
    //
    // 枚举一个 266MB / 1034 文件的 DSH home 要 14~15 秒，正好卡在预算边缘，
    // 于是列表时好时坏（同一份数据，这一次 249 条，下一次超时变空）。
    // 用户看到的就是"任务一会儿有一会儿没有"。
    //
    // 与其让每次刷新都赌这 15 秒，不如把已知数据先给出去，让新鲜度由
    // 后台那次刷新去追。列表是元数据摘要，晚几秒完全可以接受；
    // "突然变空"则完全不可接受。
    if (cached !== undefined) {
      if (!inflightList.has(cacheKey) && Date.now() - lastFreshListAt >= BACKGROUND_LIST_INTERVAL_MS) {
        inflightList.set(cacheKey, spawnBackgroundList(workspaceId, includeArchived, cacheKey))
      }
      return cached.sessions
    }
    return listSessionsFresh(workspaceId, includeArchived)
  }

  /** 真正去枚举会话的那条慢路径（14~15 秒）。结果会写进 [sessionCache]。 */
  const listSessionsFresh = async (workspaceId?: string, includeArchived = false): Promise<SessionSummary[] | null> => {
    const cacheKey = `${workspaceId ?? ''}:${includeArchived ? 'archived' : 'active'}`
    lastFreshListAt = Date.now()
    /**
     * 两条查询**并行**发起。
     *
     * `controller.list()` 内部第一件事就是自己再调一次
     * `sessionQuery.listSessions()`（见 `dsh-api-session-controller`），也就是
     * 同一份会话要被列举两遍。原来这里是串行的：先等 records，再等
     * controller —— 于是两次全量列举的耗时直接相加。
     *
     * 实测（515 份会话）：records 1.2–3.2 秒、controller 1.6–8.9 秒，串行
     * 叠加后就是 3–12 秒，正好把 15 秒预算吃穿。并发之后，总耗时从
     * "两段之和"降到"两段之中较慢的那段"。
     */
    const recordsPromise = withTimeout(ctx.sessionQuery.listSessions(), SESSION_LIST_TIMEOUT_MS, 'session list')
    /**
     * 投影与 records 并行，但**绝不把 AbortSignal 传进 host**：host 把任何
     * unhandledRejection 当致命错误 exit(1)，而 abort 会在它的查询链深处
     * 产生没人接住的拒绝。预算用本地赛跑表达——withTimeout 超时只是不等
     * 投影（projectionOk=false，status 置"未知"），查询让它在 host 里跑完。
     */
    const controllerPromise = (() => {
      const controller = sessionController()
      if (controller?.list === undefined) return undefined
      return withTimeout(controller.list({}), SESSION_LIST_TIMEOUT_MS, 'session projection')
    })()
    const records = await recordsPromise
    if (records === undefined) {
      // records 失败时投影还在后台跑；withTimeout 自己兜错，让它自然结束。
      return null
    }
    const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    const pinned = new Set(ctx.workspaceRegistry?.pinnedSessionIds ?? [])
    // The durable activity time comes from the Host's session list projection;
    // without it the picker falls back to the creation time.
    const activity = new Map<string, number>()
    const runningIds = new Set<string>()
    /**
     * `controller.list()` 有没有拿到**可用**结果。
     *
     * 它超时/抛错时 `runningIds` 是空的，而下面据此把所有会话写成
     * `status:'idle'`——那不是"中性默认值"，是**错误结论**：正在跑的任务
     * 被报成空闲，客户端首页于是显示"没有进行中的任务"。
     *
     * 更糟的是这个错误结果还会进缓存（4 秒），所以切换主机触发重连后，
     * 那几秒里怎么刷新都是空的。用户看到的就是"来回切一下，任务就没了"。
     *
     * 没有 list 能力时（`controller.list === undefined`）视为正常：
     * 那种部署本来就只有 live/idle 两种状态，不是"不知道"。
     */
    let projectionOk = controllerPromise === undefined
    if (controllerPromise !== undefined) {
      const listed = await controllerPromise
      if (listed !== undefined) {
        for (const item of listed.items ?? []) {
          if (typeof item?.sessionId === 'string' && typeof item.updatedAt === 'number') {
            activity.set(item.sessionId, item.updatedAt)
          }
          if (typeof item?.sessionId === 'string' && item.running === true) {
            runningIds.add(item.sessionId)
          }
        }
        projectionOk = true
      }
    }
    const lastActivity = (record: SessionRecordLike): number =>
      activity.get(record.header.id) ?? record.header.createdAt ?? 0
    const workspaces = workspaceList()
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
    const workspaceOf = (record: SessionRecordLike): WorkspaceSummary | undefined =>
      record.header.cwd === undefined ? undefined : workspaceByPath.get(record.header.cwd)
    // 与索引路径同样的修正：workspace 查不到时按 cwd 归属，别把会话过滤掉。
    const targetPath = workspaceId === undefined
      ? undefined
      : workspaces.find((workspace) => workspace.id === workspaceId)?.path
    const visible = records
      .filter(record => includeArchived || !archived.has(record.header.id))
      .filter((record) => record.header.origin !== 'subagent' && record.header.parentSession === undefined)
      .map((record) => ({ record, workspace: workspaceOf(record) }))
      .filter((entry) => workspaceId === undefined
        || entry.workspace?.id === workspaceId
        || (targetPath !== undefined && entry.record.header.cwd === targetPath))
      .sort((left, right) => Number(pinned.has(right.record.header.id)) - Number(pinned.has(left.record.header.id))
        || lastActivity(right.record) - lastActivity(left.record))

    const titles = new Map<string, string>()
    const TITLE_CACHE_MS = 300_000
    if (ctx.sessionQuery.readTitleSnapshots !== undefined) {
      // Each snapshot read costs a few hundred ms, so resolve titles only for
      // the rows the picker can show, in parallel, and cache them across polls.
      const pending: string[] = []
      for (const entry of visible.slice(0, 24)) {
        const id = entry.record.header.id
        const cachedTitle = titleCache.get(id)
        if (cachedTitle !== undefined && Date.now() - cachedTitle.at < TITLE_CACHE_MS) {
          titles.set(id, cachedTitle.title)
        } else {
          pending.push(id)
        }
      }
      // The projection store serializes snapshot reads, so ask one at a time
      // with a whole-batch budget: a title must never hold the picker hostage.
      // Each poll advances a few more rows, so older sessions fill in over time.
      let deadline = Date.now() + 3_000
      let resolved = 0
      for (const id of pending) {
        if (Date.now() > deadline || resolved >= 12) break
        resolved += 1
        try {
          const observations = await withTimeout(
            ctx.sessionQuery.readTitleSnapshots!([id]),
            1_200,
            'session title',
          )
          const observation = observations?.[0]
          const title = observation?.value?.title?.title
          if (observation?.status === 'fulfilled' && typeof title === 'string' && title.length > 0) {
            titles.set(id, title)
            titleCache.set(id, { at: Date.now(), title })
          }
        } catch {
          // A title is presentation metadata; a slow or missing snapshot must
          // not delay the session list.
          deadline = Math.min(deadline, Date.now() + 500)
        }
      }
    }

    const sessions: SessionSummary[] = visible.map(({ record, workspace }) => {
      const title = titles.get(record.header.id) ?? record.header.title
      // Host 内存里的实时状态。查不到就是 undefined（没在跑），
      // 这正是我们想要的语义 —— 不需要任何 IO。
      const liveStatus = ctx.agents.get(record.header.id)?.status
      return {
        sessionId: record.header.id,
        archived: archived.has(record.header.id),
        pinned: pinned.has(record.header.id),
        ...(title === undefined || title.length === 0 ? {} : { title }),
        cwd: record.header.cwd,
        createdAt: record.header.createdAt,
        ...(activity.has(record.header.id) ? { updatedAt: activity.get(record.header.id) } : {}),
        live: record.live,
        persisted: record.persisted,
        formatStatus: record.formatStatus,
        ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        ...(liveStatus === 'running' || runningIds.has(record.header.id) ? { running: true } : {}),
        // ## 状态从哪来（按优先级）
        //
        // 1. `ctx.agents.get(id)?.status` —— **内存表，O(1)，零 IO**。
        //    它只装"真正活着的 agent"（`liveAgent()` 是懒加载的，
        //    闲着的会话根本不在表里），所以查不到 = 没在跑，语义精确。
        //
        // 2. `runningIds` —— 来自 `controller.list()` 的 `items[].running`。
        //    实测这个字段**永远是空的**：底层会话投影不追踪 turn 状态
        //    （下面那段英文注释自己承认了"turn state lives in the event
        //    log, which this list does not read"）。保留它只为兼容
        //    将来投影真能报 running 的情况。
        //
        // 3. `record.live` —— 只代表"agent 驻留"，不等于在跑一个 turn。
        //
        // ## 为什么必须加第 1 条
        //
        // 实测（24.7 秒的任务，58 次采样）：
        //     attach 报 running:  57 次   ✅
        //     list   报 running:   0 次   ❌
        // 手机上看到的就是"电脑终端在跑，列表里全是空闲"。同一个时刻问
        // `ctx.agents` 和 `list`，一个说 running 一个连字段都没有。
        //
        // 投影没拿到时给 undefined（= 不知道），而不是 'idle'（= 确认没在跑）。
        // 客户端遇到 undefined 会沿用上一次已知状态，而不是把"进行中"抹掉。
        status: liveStatus
          ?? (runningIds.has(record.header.id)
            ? 'running'
            : !projectionOk
              ? undefined
              : record.live ? 'live' : 'idle'),
      }
    })
    // "Needs input" comes from the durable tail of the running sessions only
    // (an idle turn cannot hold a live approval or question): an unanswered
    // approval/asked or a dangling ask_user_question call inside the open turn.
    const needsInputOf = (sessionId: string): Promise<'approval' | 'question' | undefined> => {
      // 只问**实时表**，不读会话文件。
      //
      // 这里原来在实时表查不到时还会 `readSession()` 回退，扫一遍尾部事件
      // 推断——但加上「不再只看 running」之后，这个回退会对**每一个**空闲
      // 会话都跑一次。257 个会话各读一次会话文件，直接把慢路径拖垮：
      // 日志刷屏 `session tail timed out after 2000ms`，attach 也跟着超时。
      //
      // 实时表已经覆盖了全部真相：
      //   - approvals        ：有人等你批准
      //   - questionRequests ：有人等你回答
      // 等审批/等回答**一定**在这两张表里有一条记录，否则就没有人在等。
      // 所以不需要回退，也就不需要读文件。
      return Promise.resolve(liveInputOf(sessionId))
    }
    await Promise.all(sessions.map(async (session) => {
      const needs = await needsInputOf(session.sessionId)
      if (needs !== undefined) session.needsInput = needs
      const pendingPerms = permissionsOf(session.sessionId)
      if (pendingPerms.length > 0) session.permissions = pendingPerms
    }))
    const previewOf = async (sessionId: string): Promise<string | undefined> => {
      const cachedPreview = previewCache.get(sessionId)
      if (cachedPreview !== undefined && Date.now() - cachedPreview.at < PREVIEW_CACHE_MS) {
        return cachedPreview.preview.length === 0 ? undefined : cachedPreview.preview
      }
      try {
        const snapshot = await withTimeout(ctx.sessionQuery.readSession(sessionId), 1_200, 'session preview')
        if (snapshot === undefined) return undefined
        const preview = latestUserPreview(snapshot.events)
        previewCache.set(sessionId, { at: Date.now(), preview: preview ?? '' })
        return preview
      } catch {
        return undefined
      }
    }
    // Mobile and desktop pickers need one useful subtitle, but list latency is
    // more important than completeness. Timed-out rows fill on a later poll.
    const previewDeadline = Date.now() + PREVIEW_BUDGET_MS
    await Promise.all(sessions.slice(0, PREVIEW_ROWS).map(async (session) => {
      if (Date.now() > previewDeadline) return
      const preview = await previewOf(session.sessionId)
      if (preview !== undefined) session.preview = preview
    }))
    // 投影失败的结果**不进缓存**：它不是"过 4 秒会自动好的旧数据"，
    // 而是一次瞬时故障。缓存它等于把故障延长成 4 秒的确定错误，
    // 而这正好落在切换主机后客户端最需要正确数据的那几秒里。
    if (projectionOk) sessionCache.set(cacheKey, { at: Date.now(), sessions })
    // 顺手把这一轮结果写进轻索引：下次列表就走毫秒级的索引路径。
    // 失败不影响返回值——索引是派生数据，写不进去只是下次还得慢一遍。
    void refreshSessionIndex(records, sessions).catch(() => undefined)
    return sessions
  }

  /**
   * 用一次慢查询的结果刷新轻索引。
   *
   * 只写"列表需要的字段"：标题、副标题、时间、父会话边。正文永远不进索引。
   * `records` 里含 subagent（它们不进展柜，但要留父子边给级联查询用）。
   */
  const refreshSessionIndex = async (
    records: readonly SessionRecordLike[],
    summaries: readonly SessionSummary[],
  ): Promise<void> => {
    const byId = new Map(summaries.map(summary => [summary.sessionId, summary]))
    const extras = new Map<string, Partial<SessionIndexRow>>()
    for (const summary of summaries) {
      const extra: Partial<SessionIndexRow> = {}
      if (summary.title !== undefined) extra.title = summary.title
      if (summary.preview !== undefined) extra.preview = summary.preview
      if (summary.updatedAt !== undefined) extra.updatedAt = summary.updatedAt
      extras.set(summary.sessionId, extra)
    }
    // 标题可能只解析了前若干行；索引里已有的旧标题不要被"这次没算到"覆盖掉。
    const existing = await sessionIndex().rowsOf()
    const rows: SessionIndexRow[] = []
    for (const record of records) {
      const header = record.header
      const summary = byId.get(header.id)
      const previous = existing.get(header.id)
      const row: SessionIndexRow = { sessionId: header.id }
      if (header.cwd !== undefined) row.cwd = header.cwd
      if (header.createdAt !== undefined) row.createdAt = header.createdAt
      const title = summary?.title ?? previous?.title ?? header.title
      if (title !== undefined && title.length > 0) row.title = title
      const preview = summary?.preview ?? previous?.preview
      if (preview !== undefined && preview.length > 0) row.preview = preview
      if (summary?.updatedAt !== undefined) row.updatedAt = summary.updatedAt
      else if (previous?.updatedAt !== undefined) row.updatedAt = previous.updatedAt
      if (header.origin !== undefined) row.origin = header.origin
      // 父子边：subagent 靠它挂到父会话下，而不是变成无法归属的孤儿。
      if (header.parentSession !== undefined) row.parentSessionId = header.parentSession
      if (header.delegationDepth !== undefined) row.delegationDepth = header.delegationDepth
      rows.push(row)
    }
    // 只追加**真正变了**的行。
    //
    // 原来这里无条件 appendMany(rows)，而 rows 包含全部会话，于是每轮刷新都把
    // 524 行完整重写一遍。实测文件因此长到 484 MB / 226 万行（重复 4321 倍），
    // 每次 readFile + JSON.parse 要 1.5 GB 以上，把 Node 的 4.2 GB 堆打爆，
    // journal 里留下 8 次 `FATAL ERROR: Reached heap limit`。
    //
    // 判断依据用"序列化后是否逐字相同"，而不是逐字段比较：索引行字段一直在
    // 增删（origin / parentSessionId / delegationDepth / preview …），逐字段比
    // 每加一个字段就要记得回来改一次，漏一个就会退化成全量写入。序列化比较
    // 天然跟着结构走，且这些行本来就要序列化，成本可以忽略。
    const changed = rows.filter(row => {
      const previous = existing.get(row.sessionId)
      if (previous === undefined) return true
      return serializeRow({ ...previous, indexedAt: 0 }) !== serializeRow({ ...row, indexedAt: 0 })
    })
    if (changed.length === 0) return
    await sessionIndex().appendMany(changed)
    // 压实：追加式写入仍会让文件随轮次变长（活跃会话每轮都会变，所以仍有增长，
    // 只是从"每轮 524 行"降到"每轮几条"）。行数超阈值时重写成一份干净索引。
    await sessionIndex().compact().catch(() => false)
    indexPrimed = true
  }

  const composeAgent = async (presetId: string | undefined): Promise<{
    agentPreset?: string
    setup?: (agentCtx: unknown) => Promise<void>
  }> => {
    const presets = ctx.agentPresets
    if (presets === undefined) return {}
    const resolved = await presets.resolve(presetId)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx: unknown) => {
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  const liveAgent = async (sessionId: string): Promise<AgentLike> => {
    const existing = ctx.agents.get(sessionId)
    if (existing !== undefined) return existing
    const pending = resuming.get(sessionId)
    if (pending) return (await pending).agent
    const operation = (async (): Promise<AgentHandleLike> => {
      const controller = sessionController()
      if (controller?.resolveAgent) {
        const result = await controller.resolveAgent(sessionId)
        if ('error' in result) throw result.error
        return { agent: result.agent, dispose: async () => {} }
      }
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
      let presetId: string | undefined
      let selected: Record<string, unknown> | undefined
      try {
        if (observation.header?.origin === 'subagent') throw new Error('owned subagent sessions cannot be independently resumed')
        presetId = observation.projections?.values.agentPreset
        selected = observation.projections?.values.modelSelection?.next ?? observation.projections?.values.modelSelection?.lastUsed
      } finally { observation[Symbol.dispose]() }
      const composition = await composeAgent(presetId)
      const agentOptions = selected ?? ctx.agentDefaultModel?.currentSelection()
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      })
      handles.set(sessionId, handle)
      return handle
    })()
    resuming.set(sessionId, operation)
    try { return (await operation).agent }
    finally { if (resuming.get(sessionId) === operation) resuming.delete(sessionId) }
  }

  const childTitleCache = new Map<string, string>()

  /**
   * 直接读会话日志里的 `session/title`，绕开 Host 的投影。
   *
   * ## 为什么不走 ctx.sessionQuery.readTitleSnapshots / readSession
   *
   * 实测（本机真实数据）：
   *
   * | 路径 | 单条耗时 |
   * |---|---|
   * | `readTitleSnapshots([id])` | **> 8000ms**（日志里刷满 `child title timed out`）|
   * | `readSession(id)` | **> 1500ms**（同样超时）|
   * | 直接读 `.zstd` + 多帧解压 | **21ms** |
   *
   * 差 400 倍。原因是那两个接口都走**投影存储**，而投影要重放整个事件流；
   * 上游注释也写了「projection store serializes snapshot reads」。我们只
   * 需要标题这一个字段，没必要为它付全量投影的代价。
   *
   * ## 多帧 zstd
   *
   * 会话日志是**增量追加的多帧 zstd 流**（实测这一份有 361 帧）。
   * `zlib.zstdDecompressSync()` 只解**第一帧**就返回（这份只出 294 字节，
   * 完整内容是 1162817 字节）。所以要按 magic `28 b5 2f fd` 切开逐帧解。
   */
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const inflateSessionLog = (buf: Buffer): Buffer => {
    if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf
    const chunks: Buffer[] = []
    let pos = 0
    while (pos < buf.length - 3) {
      if (!buf.subarray(pos, pos + 4).equals(MAGIC)) { pos += 1; continue }
      const next = buf.indexOf(MAGIC, pos + 4)
      const end = next === -1 ? buf.length : next
      try { chunks.push(zstdDecompressSync(buf.subarray(pos, end))) } catch { /* 坏帧跳过 */ }
      pos = end
    }
    return Buffer.concat(chunks)
  }

  /** 在解出的 JSONL 里找 `session/title`，找不到就用第一条真实用户消息。 */
  const titleFromLog = (text: string): string | undefined => {
    let fallback: string | undefined
    for (const line of text.split('\n', 400)) {
      if (line.length === 0) continue
      if (line.includes('"session/title"')) {
        try {
          const value = (JSON.parse(line) as { data?: { title?: unknown } }).data?.title
          if (typeof value === 'string' && value.trim().length > 0) return value.trim()
        } catch { /* 坏行跳过 */ }
      }
      if (fallback === undefined && line.includes('"user/message"')) {
        try {
          const preview = latestUserPreview([JSON.parse(line) as never], { maxChars: 40 })
          if (preview !== undefined && preview.length > 0) fallback = preview
        } catch { /* Skip truncated log records. */ }
      }
    }
    return fallback
  }

  /** 子会话日志路径：`$DSH_HOME/sessions/<workspace>/<id>/session.v4.jsonl.zstd`。 */
  const findSessionLog = (sessionId: string, cwd: string | undefined): string | undefined => {
    const home = dshHome()
    if (home === undefined) return undefined
    const root = join(home, 'sessions')
    const candidates: string[] = []
    if (cwd !== undefined && cwd.length > 0) {
      // 目录名规则：绝对路径把 `/` 和 `.` 换成 `-`，两端各补一个 `--`
      const slug = `--${cwd.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-')}--`
      candidates.push(join(root, slug, sessionId, 'session.v4.jsonl.zstd'))
      candidates.push(join(root, slug, 'session-' + sessionId, 'session.v4.jsonl.zstd'))
    }
    for (const candidate of candidates) {
      try { if (statSync(candidate).isFile()) return candidate } catch { /* 继续找 */ }
    }
    // 兜底：直接遍历（只在路径规则对不上时走，慢但正确）
    try {
      for (const dir of readdirSync(root)) {
        const direct = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
        try { if (statSync(direct).isFile()) return direct } catch { /* 下一个 */ }
        const prefixed = join(root, dir, 'session-' + sessionId, 'session.v4.jsonl.zstd')
        try { if (statSync(prefixed).isFile()) return prefixed } catch { /* 下一个 */ }
      }
    } catch { /* 目录不存在 */ }
    return undefined
  }

  const fillChildTitles = async (kids: SessionIndexRow[]): Promise<void> => {
    const pending = kids.filter(kid => {
      if (kid.title !== undefined && kid.title.length > 0) return false
      const cached = childTitleCache.get(kid.sessionId)
      if (cached !== undefined) {
        kid.title = cached
        return false
      }
      return true
    })
    if (pending.length === 0) return
    const deadline = Date.now() + 12_000
    const queue = [...pending]

    const worker = async (): Promise<void> => {
      for (;;) {
        if (Date.now() > deadline) return
        const kid = queue.shift()
        if (kid === undefined) return
        try {
          const file = findSessionLog(kid.sessionId, kid.cwd)
          if (file === undefined) continue
          const text = inflateSessionLog(readFileSync(file)).toString('utf8')
          const title = titleFromLog(text)
          if (title === undefined || title.length === 0) continue
          kid.title = title
          childTitleCache.set(kid.sessionId, title)
          // 写回索引：追加式文件，新行覆盖旧行，下次不必再读日志
          await sessionIndex().appendMany([{ ...kid, title }]).catch(() => undefined)
        } catch {
          // 标题是展示信息，读不到不影响这条子任务本身
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
  }

  const sendError = (channel: Channel, error: ErrorMessage): void => {
    jsonLine(channel, error)
  }

  const sessionAction = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    if (!sessionId) throw new Error('session action requires a sessionId')
    const controller = sessionController()
    const registry = ctx.workspaceRegistry
    let result: Record<string, unknown> = {}
    switch (message.type) {
      case 'session/rename':
        if (!controller?.rename) break
        if (typeof message.title !== 'string' || !message.title.trim()) throw new Error('title must not be empty')
        result = await controller.rename({ sessionId, title: message.title.trim() })
        titleCache.delete(sessionId)
        break
      case 'session/fork':
        if (!controller?.fork) break
        result = { newSessionId: (await controller.fork({ sessionId })).sessionId }
        break
      case 'session/archive':
        if (!registry?.archiveSession) break
        await registry.archiveSession(sessionId)
        break
      case 'session/restore':
        if (!registry?.unarchiveSession) break
        await registry.unarchiveSession(sessionId)
        break
      case 'session/compact': {
        // 手动触发上下文压缩（等价于 dsh 的 `/compact`）。
        //
        // dshell 的 TUI 是硬编码 switch 的命令分发器，`/compact` 原来不在其中，
        // 命令掉进 default 被当成 "unknown command" 丢掉——即使压缩后端
        // （compaction-basic）其实已经由 preset 挂在会话上了。这里补上入口。
        const live = await liveAgent(sessionId)
        // 走 commands 服务执行 `/compact`，而不是自己去 ctx 上找 compaction。
        //
        // 这条路才是权威的：`dsh-command-compact` 把 `/compact` 注册进 commands
        // 服务，处理时用**它自己**的 ctx（`inject = ["commands", "compaction"]`）
        // 调 `ctx.compaction.compactNow(invocation.agent, ...)`。
        //
        // 自己去找 `ctx.get('compaction')` 走不通：`BasicCompactionEngine` 由
        // preset fiber 提供，实测在 host ctx / agent.ctx / agent.scope.ctx /
        // agent.loopCtx 上全都拿不到（strict 与非 strict 都是 undefined）。
        // 而 commands 是 host 平面的服务，dshell 插件拿得到；命令的实现细节
        // （包括它怎么拿到 compaction）留在内核里，不归我们操心。
        //
        // 用 `get` 而不是把 'commands' 加进模块级 inject：inject 是硬依赖，
        // 声明了内核就必须解析到，否则整个插件起不来。但命令服务在精简 profile
        // 里可能没有，dshell 不该因此整体不可用。
        const commands = (typeof (ctx as { get?: (n: string) => unknown }).get === 'function'
          ? (ctx as { get: (n: string) => unknown }).get('commands')
          : undefined) as CommandsServiceLike | undefined
        if (commands === undefined || typeof commands.execute !== 'function') {
          sendError(channel, {
            type: 'error',
            code: 'CAPABILITY_MISSING',
            message: '这个 Host 没有命令服务，无法执行 /compact',
          })
          return
        }
        const controller = new AbortController()
        try {
          const execution = await commands.execute(live, '/compact', [], controller.signal)
          if (execution === undefined) {
            sendError(channel, {
              type: 'error',
              code: 'COMPACT_FAILED',
              message: 'Host 没有识别 /compact 命令（command-compact 未挂载）',
            })
            return
          }
          // 命令的结果是给人看的一句话，比如 "Compacted 12 messages, freed ~18k tokens."
          // 直接把它转给前端，不在这里重复解释。
          const text = typeof execution.text === 'string' ? execution.text : ''
          jsonLine(channel, {
            type: 'session-compacted',
            sessionId,
            ...(text.length > 0 ? { text } : {}),
          })
        } catch (error) {
          sendError(channel, {
            type: 'error',
            code: 'COMPACT_FAILED',
            message: error instanceof Error ? error.message : '压缩失败',
          })
        }
        return
      }
      case 'session/pin':
        if (!registry?.pinSession || !registry.unpinSession) break
        await (message.pinned === false ? registry.unpinSession(sessionId) : registry.pinSession(sessionId))
        break
      default:
        sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'physical deletion is unavailable; archive the session instead' })
        return
    }
    if (message.type === 'session/pin') result = { ...result, pinned: message.pinned !== false }
    if (message.type === 'session/archive') result = { ...result, archived: true }
    if (message.type === 'session/restore') result = { ...result, archived: false }
    const supported = message.type === 'session/rename' ? controller?.rename
      : message.type === 'session/fork' ? controller?.fork
      : message.type === 'session/archive' ? registry?.archiveSession
      : message.type === 'session/restore' ? registry?.unarchiveSession : registry?.pinSession
    if (!supported) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'Host does not support this session action' })
      return
    }
    sessionCache.clear()
    jsonLine(channel, { type: 'session-updated', sessionId, action: String(message.type).slice(8), ...result })
  }

  const sessionController = (): SessionControllerLike | undefined => {
    const lookup = ctx.get?.('sessionController')
    return lookup as SessionControllerLike | undefined
  }

  const configEditor = (): ConfigEditorLike | undefined => {
    const lookup = ctx.get?.('configEditor') as ConfigEditorLike | undefined
    return typeof lookup?.configuration === 'function' ? lookup : undefined
  }

  const presetRows = (): readonly ConfigRowLike[] =>
    (configEditor()?.configuration?.() ?? []).filter((row) => row.entry.options.name === AGENT_PRESET_PLUGIN)

  const presetField = (config: unknown, field: string): string | undefined => {
    if (config === null || typeof config !== 'object') return undefined
    const value = (config as Record<string, unknown>)[field]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  const presetPlugins = (config: unknown): AgentPresetSummary['plugins'] => {
    if (config === null || typeof config !== 'object') return []
    const rows = (config as { plugins?: unknown }).plugins
    if (!Array.isArray(rows)) return []
    const plugins: AgentPresetSummary['plugins'] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const record = row as { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown }
      if (typeof record.name !== 'string' || record.name.length === 0) continue
      plugins.push({
        ...(typeof record.id === 'string' ? { id: record.id } : {}),
        name: record.name,
        ...(record.disabled === true ? { disabled: true } : {}),
        ...(record.config !== null && typeof record.config === 'object'
          ? { config: record.config as Record<string, unknown> }
          : {}),
      })
    }
    return plugins
  }

  const selectedPresetId = (): string | undefined => {
    const read = (field?: { get?(): unknown }): string | undefined => {
      const value = field?.get?.()
      return typeof value === 'string' && value.length > 0 ? value : undefined
    }
    return read(ctx.agentPresets?.config?.selectedDefault) ?? read(ctx.agentPresets?.config?.default)
  }

  const agentRoster = (): AgentRosterMessage => {
    const presets: AgentPresetSummary[] = presetRows().map((row) => {
      const config = row.entry.options.config
      const name = presetField(config, 'name')
      const description = presetField(config, 'description')
      const order = (config as { order?: unknown } | undefined)?.order
      return {
        id: presetField(config, 'id') ?? row.entry.options.id,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(typeof order === 'number' ? { order } : {}),
        plugins: presetPlugins(config),
        overridden: Object.keys(row.override ?? {}).length > 0,
      }
    })
    presets.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
    const defaultId = selectedPresetId()
    return { type: 'agents/roster', presets, ...(defaultId === undefined ? {} : { defaultId }) }
  }

  /**
   * Add each route's baseURL and a 6-character key hint to the catalog, so
   * several relays of the same vendor stay distinguishable in the picker.
   * The full secret never crosses the socket.
   */
  const annotateCatalogRoutes = async (catalog: ModelCatalog): Promise<void> => {
    const rows = new Map(providerRows().map((row) => [row.id, row]))
    const resolveRef = credentialResolve()
    await Promise.all(catalog.groups.map(async (group) => {
      const row = rows.get(group.id)
      if (row === undefined) return
      if (row.baseURL !== undefined) group.baseURL = row.baseURL
      if (row.apiKeyEnv === undefined || resolveRef === undefined) return
      try {
        const resolved = await resolveRef.resolve(row.apiKeyEnv)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (typeof value === 'string' && value.length > 0) {
          group.keyHint = `${value.slice(0, 6)}…`
        }
      } catch {
        // A hint is cosmetic; an unresolvable ref simply shows none.
      }
    }))
  }

  const forwardModelCatalog = async (channel: Channel): Promise<void> => {
    const controller = sessionController()
    if (controller === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host mounts no session controller, so it cannot list models',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    const catalog = await controller.modelCatalog()
    await annotateCatalogRoutes(catalog)
    jsonLine(channel, { type: 'model-catalog', catalog })
  }

  const parseSelection = (message: Record<string, unknown>): ModelSelection | undefined => {
    const provider = typeof message.provider === 'string' ? message.provider.trim() : ''
    const model = typeof message.model === 'string' ? message.model.trim() : ''
    if (provider.length === 0 || model.length === 0) return undefined
    const effort = typeof message.reasoningEffort === 'string' && message.reasoningEffort.length > 0
      ? message.reasoningEffort
      : undefined
    return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  }

  const selectModel = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    const selection = parseSelection(message)
    if (sessionId.length === 0 || selection === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'model/select needs sessionId, provider and model',
      })
      return
    }
    const controller = sessionController()
    if (controller === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host mounts no session controller, so it cannot switch models',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    const { selected } = await controller.selectModel({ sessionId, ...selection })
    jsonLine(channel, { type: 'model-selected', sessionId, selected })
  }

  const setDefaultModel = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const selection = parseSelection(message)
    if (selection === undefined) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'model/default needs provider and model' })
      return
    }
    const defaults = ctx.agentDefaultModel
    if (defaults?.saveSelection === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host cannot save a default model',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    await defaults.saveSelection(selection)
    jsonLine(channel, { type: 'model-selected', selected: selection, savedAsDefault: true })
  }

  /**
   * Providers live in a patch file, not in the session store. Prefer the
   * home-level patch (it outranks every profile), then the active profile's
   * own patch. The TUI never writes this file directly: the Host owns the
   * path so a client cannot be pointed at an arbitrary file.
   */
  const dshHome = (): string | undefined => {
    const provided = ctx.get?.('dshHomePath')
    if (typeof provided === 'string' && provided.length > 0) return provided
    const env = process.env.DSH_HOME
    if (env !== undefined && env.length > 0) return env
    const home = process.env.HOME
    return home === undefined || home.length === 0 ? undefined : join(home, '.dsh')
  }

  const skillRegistry = (): SkillsRegistryLike | undefined => ctx.get?.('skills') as SkillsRegistryLike | undefined
  /** Read one credential reference through the Host store (picker hints). */
  const credentialResolve = ():
    | { resolve(ref: string): Promise<{ value?: string } | string | undefined> }
    | undefined => {
    const service = ctx.get?.('credentials') as { resolve?: unknown } | undefined
    const resolve = service?.resolve
    if (typeof resolve !== 'function') return undefined
    return { resolve: (ref: string) => resolve.call(service, ref) as Promise<{ value?: string } | string | undefined> }
  }

  /** The Host's credential store: `set` writes ~/.dsh/.credentials.yaml. */
  const credentialStore = (): { set(ref: string, value: string): Promise<void>; unset(ref: string): Promise<void> } | undefined => {
    const service = ctx.get?.('credentials') as { set?: (ref: string, value: string) => Promise<void>; unset?: (ref: string) => Promise<void> } | undefined
    if (typeof service?.set !== 'function' || typeof service.unset !== 'function') return undefined
    return { set: (ref, value) => service.set!(ref, value), unset: ref => service.unset!(ref) }
  }

  const hubDirs = resolveHubDirs({
    configured: config.skillHub,
    env: process.env.DSHELL_SKILL_HUB,
    dshHome: dshHome() ?? join(process.env.HOME ?? '.', '.dsh'),
  })

  // The catalog cache is invalidated before every `/skills` read, so a hub
  // edited while no watcher is attached (a directory created after boot, a
  // network mount) still shows up without restarting the Host.
  let invalidateSkillCatalog: (() => void) | undefined

  {
    const registry = skillRegistry()
    if (registry?.registerProvider !== undefined) {
      try {
        registry.registerProvider(() => createBundledProvider())
      } catch {
        // Keep the Host usable when an older registry cannot mount providers.
      }
      // Create the shelves up front: `fs.watch` cannot watch a path that does
      // not exist yet, and a hub that only starts watching after a restart is
      // exactly the surprise this feature is meant to remove.
      for (const dir of hubDirs) {
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          // A read-only or missing parent is reported by the empty catalog.
        }
      }
      try {
        registry.registerProvider((control) => {
          invalidateSkillCatalog = () => control.invalidate()
          const provider = createHubProvider(hubDirs)
          const watchers = watchSkillDirs(hubDirs, () => control.invalidate())
          if (watchers.length > 0) ctx.on?.('dispose', () => watchers.forEach((watcher) => watcher.close()))
          return provider
        })
      } catch {
        // An incompatible skills service must not stop the Host from booting;
        // the welcome simply omits the capability and /skills explains why.
      }
    }
  }

  /** The agent whose scope owns this session's catalog, when it can be resumed. */
  const skillScope = async (rawSessionId: unknown): Promise<object | undefined> => {
    const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined
    if (sessionId === undefined) return undefined
    try {
      const agent = await liveAgent(sessionId)
      return agent
    } catch (error) {
      console.error('[dshell-host] skill scope failed:', error)
      // A catalog read must not fail because the session cannot resume; the
      // global layer (hub and deployment providers) is still worth showing.
      return undefined
    }
  }

  const listSkills = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const registry = skillRegistry()
    if (registry === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'SKILLS_UNAVAILABLE',
        message: 'this Host has no skills registry',
        action: 'Load the bundled skill providers (dsh-skill / dsh-skill-filesystem) in the profile, then restart the Host.',
      })
      return
    }
    const cwd = typeof message.cwd === 'string' && message.cwd.length > 0 ? message.cwd : undefined
    // Skill providers may live in the agent's own scope (the Web profile mounts
    // local discovery behind the preset), so read the catalog the way the model
    // does: through the session's agent. Resuming it is the same work opening
    // the session in the Web UI does, and it is cached by the Host.
    const scope = await skillScope(message.sessionId)
    let skills: SkillEntry[]
    try {
      invalidateSkillCatalog?.()
      const summaries = await registry.list({ ...(cwd === undefined ? {} : { cwd }), ...(scope === undefined ? {} : { scope }) })
      skills = summaries.map(toSkillEntry)
    } catch (error) {
      sendError(channel, {
        type: 'error',
        code: 'SKILLS_FAILED',
        message: errorText(error),
        action: 'Run /skills again; if it keeps failing the skill providers are unhealthy.',
      })
      return
    }
    jsonLine(channel, {
      type: 'skills',
      ...(cwd === undefined ? {} : { cwd }),
      ...(scope === undefined ? {} : { scoped: true }),
      hub: hubDirs,
      skills,
    })
  }

  const getSkill = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const registry = skillRegistry()
    const name = typeof message.name === 'string' ? message.name.trim() : ''
    if (registry === undefined || name.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'SKILLS_UNAVAILABLE',
        message: name.length === 0 ? 'skills/get needs a name' : 'this Host has no skills registry',
        action: 'Run /skills to see the available skills.',
      })
      return
    }
    const cwd = typeof message.cwd === 'string' && message.cwd.length > 0 ? message.cwd : undefined
    const scope = await skillScope(message.sessionId)
    try {
      const skill = await registry.get(name, { ...(cwd === undefined ? {} : { cwd }), ...(scope === undefined ? {} : { scope }) })
      if (skill === undefined) {
        sendError(channel, {
          type: 'error',
          code: 'SKILL_MISSING',
          message: `skill "${name}" is not loadable`,
          action: 'It may have been removed since the catalog was read; run /skills again.',
        })
        return
      }
      jsonLine(channel, { type: 'skill', name: skill.name, content: skill.content })
    } catch (error) {
      sendError(channel, {
        type: 'error',
        code: 'SKILLS_FAILED',
        message: errorText(error),
        action: 'Run /skills again; if it keeps failing the skill providers are unhealthy.',
      })
    }
  }

  const providerFileCandidates = (): string[] => {
    const home = dshHome()
    if (home === undefined) return []
    const candidates: string[] = []
    candidates.push(join(home, 'cordis.patch.yml'))
    const profile = process.env.DSH_PROFILE
    if (profile !== undefined && profile.length > 0) {
      candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'))
    }
    const owned = configEditor()?.documentPath
    if (owned !== undefined && !candidates.includes(owned)) candidates.push(owned)
    return candidates.filter((path) => existsSync(path))
  }

  const providerFile = (): string | undefined => {
    const owned = configEditor()?.documentPath
    const candidates = providerFileCandidates()
    // Home patches outrank profiles. configEditor may own a profile that has
    // no llm-pi-ai row (nested includes are independently owned).
    const home = dshHome()
    const homePatch = home === undefined ? undefined : join(home, 'cordis.patch.yml')
    if (homePatch !== undefined && candidates.includes(homePatch) && hasProviderConfig(safeRead(homePatch))) return homePatch
    if (owned && providerOwner()) return owned
    return candidates.find((path) => hasProviderConfig(safeRead(path))) ?? candidates[0] ?? owned
  }

  const providerOwner = (): ConfigRowLike | undefined => {
    const rows = configEditor()?.configuration?.().filter(row =>
      row.entry.options.id === 'llm-pi-ai' || row.entry.options.name === '@deepseek-ai/dsh-llm-pi-ai') ?? []
    if (rows.length > 1) throw new Error('multiple addressable provider owners; select the profile explicitly')
    return rows[0]
  }
  const providerText = (file: string): string => {
    const owner = providerOwner()
    if (configEditor()?.documentPath === file && owner) {
      return stringify([{ id: owner.entry.options.id, name: owner.entry.options.name, config: owner.entry.options.config ?? {} }])
    }
    return safeRead(file)
  }
  const providerRows = (): ProviderEntry[] => {
    const file = providerFile()
    return file === undefined ? [] : readProviderEntries(providerText(file))
  }
  const providerSource = () => {
    const owner = configEditor()?.documentPath === providerFile() ? providerOwner() : undefined
    return owner === undefined
      ? { kind: 'file' as const, layer: 'entry' as const, inherited: false, overridden: false }
      : {
          kind: 'config-editor' as const,
          layer: 'entry' as const,
          inherited: Object.keys(owner.inherited ?? {}).length > 0,
          overridden: Object.keys(owner.override ?? {}).length > 0,
        }
  }

  /**
   * Persist a rewrite only when the re-parsed file still says exactly what was
   * intended. A near-miss (indentation drift, quoting slip) refuses the write
   * and leaves the file untouched.
   */
  const persistProviders = async (channel: Channel, file: string, after: string, expected: ProviderEntry[], before = providerText(file)): Promise<boolean> => {
    if (JSON.stringify(providerSignature(expected)) !== JSON.stringify(providerSignature(readProviderEntries(after)))) {
      sendError(channel, { type: 'error', code: 'INTERNAL', message: 'edited configuration does not match the requested providers' })
      return false
    }
    const editor = configEditor()
    const row = providerOwner()
    if (editor?.edit && editor.documentPath === file && row) {
      const extract = (text: string): Record<string, unknown> | undefined => {
        const value = parseDocument(text).toJS()
        const visit = (node: unknown): Record<string, unknown> | undefined => {
          if (Array.isArray(node)) { for (const item of node) { const found = visit(item); if (found) return found }; return }
          if (!node || typeof node !== 'object') return
          const obj = node as Record<string, unknown>
          if (obj.id === 'llm-pi-ai' || obj.name === '@deepseek-ai/dsh-llm-pi-ai') return (obj.config as Record<string, unknown>)?.providers as Record<string, unknown>
          for (const [key, value] of Object.entries(obj)) if (key !== 'config') { const found = visit(value); if (found) return found }
        }
        return visit(value)
      }
      const providers = extract(after)
      if (!providers) throw new Error('configuration source has no addressable providers')
      try {
        await editor.edit(row.entry, current => {
          const previous = parseDocument(before).toJS()[0]?.config ?? {}
          if (!isDeepStrictEqual(current, previous)) throw new Error('configuration changed; reload providers and retry')
          return { ...current, providers }
        })
      } catch (error) {
        if (/configuration changed; reload providers and retry/i.test(errorText(error))) {
          sendError(channel, { type: 'error', code: 'CONFIG_CONFLICT', message: errorText(error) })
          return false
        }
        throw error
      }
      return true
    }
    // Fallback for Hosts without configEditor: serialize dshell writers and detect external edits.
    const lock = file + '.dshell-lock'
    let release: (() => void) | undefined
    const temporary = file + '.dshell-' + randomUUID()
    try {
      release = acquireFileLock(lock)
      if (safeRead(file) !== before) {
        sendError(channel, { type: 'error', code: 'CONFIG_CONFLICT', message: 'configuration changed; reload providers and retry' })
        return false
      }
      writeFileSync(temporary, after, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      return true
    } finally {
      release?.()
      try { unlinkSync(temporary) } catch {}
    }
  }

  const providerWritable = (file: string): boolean => {
    if (configEditor()?.documentPath === file && configEditor()?.edit && providerOwner()) return true
    try {
      accessSync(file, fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  }

  const listProviders = (channel: Channel): void => {
    const file = providerFile()
    if (file === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host found no cordis.patch.yml to read providers from',
        action: 'Add provider rows to $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    jsonLine(channel, {
      type: 'provider-list',
      file,
      writable: providerWritable(file),
      source: providerSource(),
      providers: providerRows(),
    })
  }

  const saveProvider = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const changes = typeof message.changes === 'object' && message.changes !== null
      ? message.changes as Record<string, unknown>
      : {}
    const apiKey = typeof message.apiKey === 'string' && message.apiKey.trim().length > 0 ? message.apiKey.trim() : undefined
    const fields = Object.keys(changes).filter(isProviderField)
    if (providerId.length === 0 || (fields.length === 0 && apiKey === undefined)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'provider/save needs providerId and at least one field or key' })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: file === undefined ? 'this Host found no provider configuration' : `${file} is not writable` })
      return
    }
    const before = providerText(file)
    const detail = readProviderDetail(before, providerId)
    let ref: string | undefined
    let ownerPrefix: string | undefined
    const store = apiKey === undefined ? undefined : credentialStore()
    if (apiKey !== undefined && store === undefined) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'this Host has no credential store' })
      return
    }
    let after = before
    try {
      for (const field of fields) {
        if (field === 'apiKeyEnv' && apiKey !== undefined) continue
        const raw = typeof changes[field] === 'string' ? changes[field] as string : ''
        const value = raw.trim()
        if (field === 'baseURL' && value.length > 0 && !/^https?:\/\/[^\s]+$/.test(value)) throw new ProviderEditError('BAD_FIELD', 'baseURL must be an absolute http(s) URL')
        if (field === 'apiKeyEnv' && value.length > 0 && !/^[A-Z][A-Z0-9_]*$/.test(value)) throw new ProviderEditError('BAD_FIELD', 'apiKeyEnv must be an upper-case environment variable name')
        after = value.length === 0 ? clearProviderField(after, providerId, field) : setProviderField(after, providerId, field, value)
      }
      if (apiKey !== undefined) {
        ownerPrefix = 'DSHELL_' + createHash('sha256').update(resolve(file) + '\0' + providerId).digest('hex').slice(0, 20).toUpperCase() + '_'
        ref = ownerPrefix + randomUUID().replaceAll('-', '').toUpperCase() + '_API_KEY'
        await store!.set(ref, apiKey)
        after = setProviderField(after, providerId, 'apiKeyEnv', ref)
        if (!fields.includes('apiKeyEnv')) fields.push('apiKeyEnv')
      }
    } catch (error) {
      if (ref !== undefined) await store?.unset(ref).catch(() => undefined)
      if (error instanceof ProviderEditError) { sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error.message }); return }
      throw error
    }
    let committed = false
    try {
      committed = after === before || await persistProviders(channel, file, after, readProviderEntries(after), before)
      if (!committed) return
    } finally {
      if (!committed && ref !== undefined) await store?.unset(ref).catch(() => undefined)
    }
    if (ownerPrefix !== undefined && detail.apiKeyEnv?.startsWith(ownerPrefix) && detail.apiKeyEnv !== ref
      && !readProviderEntries(after).some(row => row.id !== providerId && row.apiKeyEnv === detail.apiKeyEnv)) {
      await store?.unset(detail.apiKeyEnv).catch(() => undefined)
    }
    jsonLine(channel, { type: 'provider-saved', file, providerId, fields, ...(ref === undefined ? {} : { ref }), source: providerSource(), providers: providerRows() })
  }

  const updateProvider = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const field = typeof message.field === 'string' ? message.field : ''
    const value = typeof message.value === 'string' ? message.value : ''
    if (providerId.length === 0 || !isProviderField(field)) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'provider/update needs providerId and one of baseURL, apiKeyEnv, displayName, api',
      })
      return
    }
    const file = providerFile()
    if (file === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host found no cordis.patch.yml to write providers to',
        action: 'Create $DSH_HOME/cordis.patch.yml with an llm-pi-ai providers block.',
      })
      return
    }
    if (!providerWritable(file)) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: `${file} is not writable`,
        action: 'Fix the file permissions or edit the provider row by hand.',
      })
      return
    }
    if (field === 'baseURL' && !/^https?:\/\/[^\s]+$/.test(value.trim())) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'baseURL must be an absolute http(s) URL',
      })
      return
    }
    if (field === 'apiKeyEnv' && !/^[A-Z][A-Z0-9_]*$/.test(value.trim())) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'apiKeyEnv must be an upper-case environment variable name',
      })
      return
    }
    const before = providerText(file)
    let after: string
    try {
      after = setProviderField(before, providerId, field, value)
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error.message })
        return
      }
      throw error
    }
    if (after !== before) {
      const expected = providerRows().map((row) => {
        if (row.id !== providerId) return row
        const edited: ProviderEntry = { ...row }
        if (value.trim().length === 0) delete edited[field]
        else edited[field] = value.trim()
        return edited
      })
      if (!await persistProviders(channel, file, after, expected, before)) return
    }
    jsonLine(channel, {
      type: 'provider-updated',
      file,
      providerId,
      field,
      value: value.trim(),
      providers: providerRows(),
    })
  }

  /** The Host's LLM surface; `discoverModels` interrogates an upstream listing. */
  const llmDiscovery = (): {
    discoverModels(ns: string, request: { provider?: string; baseURL?: string; api?: string; apiKey?: string }): Promise<
      { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]
    >
  } | undefined => {
    const service = ctx.get?.('llm') as
      | { discoverModels?: (ns: string, request: { provider?: string; baseURL?: string; api?: string; apiKey?: string }) => Promise<unknown> }
      | undefined
    if (typeof service?.discoverModels !== 'function') return undefined
    return { discoverModels: (ns, request) => service.discoverModels?.(ns, request) as Promise<never[]> }
  }

  /**
   * Store a raw API key (`sk-…`) for one provider: the secret goes to the
   * Host's credential store and `apiKeyEnv` in the patch file is pointed at
   * the reference that reads it back. The secret itself never lands in YAML.
   */
  const storeProviderKey = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const value = typeof message.value === 'string' ? message.value.trim() : ''
    const store = credentialStore()
    if (providerId.length === 0 || value.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'provider/api-key needs providerId and the key value',
      })
      return
    }
    if (store === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no credential store',
        action: 'Set apiKeyEnv to a name resolved from the launch environment instead.',
      })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined
          ? 'this Host found no cordis.patch.yml to write providers to'
          : `${file} is not writable`,
      })
      return
    }
    const before = providerText(file)
    const detail = readProviderDetail(before, providerId) // validate owner before storing anything
    const owner = createHash('sha256').update(resolve(file) + '\0' + providerId).digest('hex').slice(0, 20).toUpperCase()
    const ref = 'DSHELL_' + owner + '_' + randomUUID().replaceAll('-', '').toUpperCase() + '_API_KEY'
    const after = setProviderField(before, providerId, 'apiKeyEnv', ref)
    const expected = readProviderEntries(before).map(row => row.id === providerId ? { ...row, apiKeyEnv: ref } : row)
    await store.set(ref, value)
    let committed = false
    try {
      committed = after === before || await persistProviders(channel, file, after, expected, before)
      if (!committed) return
    } finally {
      if (!committed) await store.unset(ref)
    }
    // Only retire an earlier dshell-owned version after its replacement is durable.
    if (detail.apiKeyEnv?.startsWith('DSHELL_' + owner + '_') && !readProviderEntries(after).some(row => row.id !== providerId && row.apiKeyEnv === detail.apiKeyEnv)) {
      await store.unset(detail.apiKeyEnv).catch(() => undefined)
    }
    jsonLine(channel, {
      type: 'provider-key-stored',
      credentialsFile: '~/.dsh/.credentials.yaml',
      ref,
      file,
      providerId,
      providers: providerRows(),
    })
  }

  /**
   * Ask an upstream which models it serves (`GET {baseURL}/models`, or the
   * Anthropic spelling). Discovery is adoption, not sync: the reply is
   * candidate ids for the draft — `cordis.patch.yml` stays authoritative.
   */
  const discoverProviderModels = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const baseURL = typeof message.baseURL === 'string' ? message.baseURL.trim() : ''
    const api = typeof message.api === 'string' && message.api.length > 0 ? message.api : undefined
    const apiKey = typeof message.apiKey === 'string' && message.apiKey.length > 0 ? message.apiKey : undefined
    const llm = llmDiscovery()
    if (baseURL.length === 0 || !/^https?:\/\/[^\s]+$/.test(baseURL)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'provider/discover needs an absolute http(s) baseURL' })
      return
    }
    if (llm === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host exposes no model discovery',
        action: 'Enter model ids by hand.',
      })
      return
    }
    try {
      const discovered = await llm.discoverModels('llm-pi-ai', { baseURL, ...(api === undefined ? {} : { api }), ...(apiKey === undefined ? {} : { apiKey }) })
      const models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] = []
      for (const model of discovered) {
        if (typeof model?.id !== 'string' || model.id.length === 0) continue
        models.push({
          id: model.id,
          ...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {}),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        })
      }
      jsonLine(channel, { type: 'provider-discovered', models })
    } catch (error) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Diff one configured provider's model list against its upstream listing. */
  const syncPlan = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const llm = llmDiscovery()
    if (providerId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'provider/sync-plan needs providerId' })
      return
    }
    if (llm === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host exposes no model discovery',
        action: 'Edit the models list by hand.',
      })
      return
    }
    const file = providerFile()
    if (file === undefined) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'this Host found no cordis.patch.yml to read providers from' })
      return
    }
    const detail = readProviderDetail(providerText(file), providerId)
    if (detail.baseURL === undefined) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: `provider ${providerId} declares no baseURL to list models from` })
      return
    }
    try {
      const discovered = await llm.discoverModels('llm-pi-ai', {
        provider: providerId,
        baseURL: detail.baseURL,
        ...(detail.api === undefined ? {} : { api: detail.api }),
      })
      const upstream = new Set(discovered.map((model) => model.id))
      const declared = new Set(detail.modelIds)
      const added = [...upstream].filter((id) => !declared.has(id)).sort()
      const removed = detail.modelIds.filter((id) => !upstream.has(id))
      jsonLine(channel, { type: 'provider-sync-plan', providerId, added, removed, kept: declared.size - removed.length })
    } catch (error) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Apply a sync: adopt new ids, optionally drop the gone ones. */
  const syncApply = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const add = Array.isArray(message.add) ? message.add.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const remove = Array.isArray(message.remove) ? message.remove.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const file = providerFile()
    if (providerId.length === 0 || (add.length === 0 && remove.length === 0)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'provider/sync-apply needs providerId and something to change' })
      return
    }
    if (file === undefined || !providerWritable(file)) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined ? 'this Host found no cordis.patch.yml to write providers to' : `${file} is not writable`,
      })
      return
    }
    const before = providerText(file)
    let after: string
    try {
      after = syncProviderModels(before, providerId, add, remove)
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error.message })
        return
      }
      throw error
    }
    const expected = providerRows().map(row => row.id !== providerId ? row : { ...row, models: readProviderDetail(after, providerId).modelIds.length })
    if (after !== before && !await persistProviders(channel, file, after, expected, before)) return
    jsonLine(channel, { type: 'provider-sync-applied', file, providerId, providers: providerRows() })
  }

  const createProvider = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const baseURL = typeof message.baseURL === 'string' ? message.baseURL.trim() : ''
    const apiKeyEnv = typeof message.apiKeyEnv === 'string' ? message.apiKeyEnv.trim() : ''
    const displayName = typeof message.displayName === 'string' ? message.displayName.trim() : ''
    const api = typeof message.api === 'string' ? message.api.trim() : ''
    const models = Array.isArray(message.models)
      ? message.models
          .filter((model): model is string => typeof model === 'string')
          .map((model) => model.trim())
          .filter((model) => model.length > 0)
      : []
    if (providerId.length === 0 || baseURL.length === 0 || models.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'provider/create needs providerId, baseURL and at least one model id',
      })
      return
    }
    if (!/^https?:\/\/[^\s]+$/.test(baseURL)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'baseURL must be an absolute http(s) URL' })
      return
    }
    if (apiKeyEnv.length > 0 && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'apiKeyEnv must be an upper-case environment variable name' })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined ? 'this Host found no cordis.patch.yml' : `${file} is not writable`,
        action: 'Create or fix $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    const before = providerText(file)
    let after: string
    try {
      after = addProvider(before, {
        id: providerId,
        baseURL,
        models,
        ...(api.length === 0 ? {} : { api }),
        ...(apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
        ...(displayName.length === 0 ? {} : { displayName }),
      })
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error.message })
        return
      }
      throw error
    }
    const entry: ProviderEntry = {
      id: providerId,
      baseURL,
      models: models.length,
      ...(api.length === 0 ? {} : { api }),
      ...(apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
      ...(displayName.length === 0 ? {} : { displayName }),
    }
    if (!await persistProviders(channel, file, after, [...providerRows(), entry], before)) return
    jsonLine(channel, { type: 'provider-created', file, providerId, providers: providerRows() })
  }

  const deleteProvider = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    if (providerId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'provider/delete needs providerId' })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined ? 'this Host found no cordis.patch.yml' : `${file} is not writable`,
        action: 'Create or fix $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    const before = providerText(file)
    let after: string
    try {
      after = removeProvider(before, providerId)
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: error.message })
        return
      }
      throw error
    }
    const expected = providerRows().filter((row) => row.id !== providerId)
    if (!await persistProviders(channel, file, after, expected, before)) return
    jsonLine(channel, { type: 'provider-deleted', file, providerId, providers: providerRows() })
  }

  const restartHost = async (channel: Channel): Promise<void> => {
    if (process.versions.electron !== undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'the Host runs inside Electron, so it cannot re-exec itself',
        action: 'Quit and reopen the desktop app.',
      })
      return
    }
    const argv = process.argv.slice(1)
    if (argv.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'the Host cannot infer how it was launched',
        action: 'Restart the Host by hand.',
      })
      return
    }
    try {
      accessSync(process.execPath, fsConstants.X_OK)
    } catch {
      sendError(channel, {
        type: 'error',
        code: 'INTERNAL',
        message: `could not re-exec the Host: ${process.execPath} is not executable`,
        action: 'Restart the Host by hand.',
      })
      return
    }
    jsonLine(channel, { type: 'host-restarting', pid: process.pid, argv })
    // Close BEFORE spawning the replacement: Node's server.close() removes
    // the socket file at this path, so closing after the spawn races the
    // replacement's own bind and can delete its freshly-created socket
    // (verified on Node 24). Closing first leaves the child a free path;
    // a spawn failure past this point is logged and surfaced by the CLI's
    // reconnect timeout instead of a half-dead Host.
    await close().catch(() => {})
    try {
      const child = spawn(process.execPath, argv, {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: process.env,
      })
      child.unref()
    } catch (error) {
      console.error(`[dshell-host] could not re-exec the Host: ${errorText(error)}`)
    }
    process.exit(0)
  }

  const historyCuts = new Map<Channel, Map<string, number>>()

  const watch = (channel: Channel, sessionId: string): Set<string> => {
    let sessions = watched.get(channel)
    if (sessions === undefined) {
      sessions = new Set()
      watched.set(channel, sessions)
    }
    sessions.add(sessionId)
    return sessions
  }

  const unwatch = (channel: Channel, sessionId?: string): void => {
    if (sessionId === undefined) {
      watched.delete(channel)
      return
    }
    const sessions = watched.get(channel)
    if (sessions === undefined) return
    sessions.delete(sessionId)
    if (sessions.size === 0) watched.delete(channel)
  }

  const watchersFor = (sessionId: string): Channel[] => {
    const result: Channel[] = []
    for (const [channel, sessions] of watched) {
      if (channel.alive && sessions.has(sessionId)) result.push(channel)
    }
    return result
  }

  const broadcast = (sessionId: string, message: unknown): void => {
    for (const watcher of watchersFor(sessionId)) jsonLine(watcher, message)
  }

  const approvals = new ApprovalCoordinator({
    watchers: (sessionId) => watchersFor(sessionId).length,
    broadcast,
  })

  /**
   * The Host's `ask_user_question` blocks inside a `user-questions/request`
   * waterfall until an answerer returns. The Web UI is that answerer in a
   * browser; in a terminal Host nobody was — so the tool failed immediately
   * with `NO_PROVIDER` and the overlay never appeared. This plugin answers for
   * sessions a TUI client is watching and passes everything else on.
   */
  interface PendingQuestion {
    sessionId: string
    callId: string
    questions: AskedQuestion[]
    message: QuestionRequestMessage
    agent?: AgentLike
    claim: AbortController
    claimHeld: boolean
    otherDone: boolean
    // The Host tool reads `.answers` off the waterfall's return value.
    resolve: (result: { answers: QuestionAnswer[] }) => void
    reject: (error: unknown) => void
    close: (reason: 'answered' | 'aborted' | 'detached') => void
  }

  const questionRequests = new Map<string, PendingQuestion>()
  /** Asks already settled, so a second window's answer is rejected, not steered. */
  const settledAsks = new Set<string>()
  /** `ask_user_question` calls in the durable log without a result yet. */
  const askCalls = new Map<string, { callId: string; ids: string }[]>()

  const questionIds = (questions: readonly { id: string }[]): string => questions.map((question) => question.id).join('\u0000')

  /** Remember logged ask calls so a legacy request can borrow its real callId. */
  const noteAskCall = (sessionId: string, event: SessionEvent): void => {
    const data = (event.data ?? {}) as Record<string, any>
    if (event.type === 'tool/call' && data.name === 'ask_user_question' && typeof data.callId === 'string') {
      let args: Record<string, any> = {}
      try {
        args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : ((data.arguments ?? {}) as Record<string, any>)
      } catch {
        args = {}
      }
      const questions = Array.isArray(args.questions) ? (args.questions as { id?: unknown }[]) : []
      const list = askCalls.get(sessionId) ?? []
      list.push({ callId: data.callId, ids: questionIds(questions.map((question) => ({ id: String(question.id ?? '') }))) })
      askCalls.set(sessionId, list)
      return
    }
    if (event.type === 'tool/result') {
      const message = (data.message ?? {}) as Record<string, any>
      if (typeof message.toolCallId !== 'string') return
      const list = askCalls.get(sessionId)
      if (list === undefined) return
      const next = list.filter((entry) => entry.callId !== message.toolCallId)
      if (next.length === 0) askCalls.delete(sessionId)
      else askCalls.set(sessionId, next)
    }
  }

  /** Pop the newest logged ask whose questions match; the case is what pairs them. */
  const claimAskCall = (sessionId: string, ids: string): string | undefined => {
    const list = askCalls.get(sessionId) ?? []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]!
      if (entry.ids !== ids) continue
      list.splice(index, 1)
      if (list.length === 0) askCalls.delete(sessionId)
      return entry.callId
    }
    return undefined
  }

  /** Settle one live request once: resolve, reject, and close the client overlay. */
  const settleQuestion = (
    callId: string,
    reason: 'answered' | 'aborted' | 'detached',
    answers?: QuestionAnswer[],
    error?: unknown,
  ): boolean => {
    const pending = questionRequests.get(callId)
    if (pending === undefined) return false
    questionRequests.delete(callId)
    // 同一会话可能同时挂多条提问，所以只在最后一条也结束时才把会话移出集合，
    // 否则早退一条就会让列表误报「没人等了」。
    if (![...questionRequests.values()].some((entry) => entry.sessionId === pending.sessionId)) {
      waitingQuestion.delete(pending.sessionId)
    }
    settledAsks.add(callId)
    if (settledAsks.size > 200) {
      const oldest = settledAsks.values().next().value
      if (oldest !== undefined) settledAsks.delete(oldest)
    }
    pending.close(reason)
    if (reason === 'answered') pending.resolve({ answers: answers ?? [] })
    else pending.reject(error ?? new Error(`stopped waiting for the answer (${reason})`))
    return true
  }

  const validAnswers = (questions: readonly AskedQuestion[], answers: readonly QuestionAnswer[]): boolean => {
    if (answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length) return false
    return questions.every(question => {
      const answer = answers.find(a => a.id === question.id)
      if (!answer || new Set(answer.selected).size !== answer.selected.length) return false
      if (!question.multiSelect && answer.selected.length > 1) return false
      const labels = new Set(question.options?.map(option => option.label) ?? [])
      return answer.selected.every(label => labels.has(label))
        && (answer.selected.length > 0 || Boolean(answer.custom?.trim()))
    })
  }
  const questionService = () => ctx.get?.('userQuestions') as {
    answer?(agent: AgentLike, callId: string, answer: { answers: QuestionAnswer[] }): boolean
    attachWait?(agent: AgentLike, callId: string, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
  } | undefined

  const holdQuestion = (entry: PendingQuestion): void => {
    const service = questionService()
    if (!entry.message.timed || entry.claimHeld || !entry.agent || !service?.attachWait
      || watchersFor(entry.sessionId).length === 0) return
    const claim = new AbortController()
    entry.claim = claim
    entry.claimHeld = true
    void (async () => {
      try {
        for await (const frame of service.attachWait!(entry.agent!, entry.callId, claim.signal)) {
          if (claim.signal.aborted) break
          entry.message.timeoutMs = frame.remainingMs
        }
      } catch { /* the owner's request signal settles the question */ }
      finally { if (entry.claim === claim) entry.claimHeld = false }
    })()
  }

  const handleQuestion = async (
    request: {
      questions: AskedQuestion[]
      agent?: AgentLike
      signal?: AbortSignal
      wait?: { callId?: string; timed?: boolean }
    },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const sessionId = request.agent?.session?.id
    // No TUI is looking at this session: let the Web answerer have it.
    if (sessionId === undefined || watchersFor(sessionId).length === 0) return await next()
    const ids = questionIds(request.questions)
    // A timed ask names its call; a legacy one borrows the logged call. If the
    // log has not reached us yet, the id only has to be unique: the answer is
    // delivered through this waterfall, not keyed by it anywhere else.
    const callId = request.wait?.callId ?? claimAskCall(sessionId, ids) ?? `ask-${randomUUID()}`
    if (questionRequests.has(callId)) return await next()

    const message: QuestionRequestMessage = {
      type: 'question/request',
      sessionId,
      callId,
      questions: request.questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.intent === undefined ? {} : { intent: { ...question.intent } }),
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map((option) => ({ ...option })) }),
      })),
      timed: request.wait?.timed === true,
    }
    return await new Promise<{ answers: QuestionAnswer[] }>((resolve, reject) => {
      const signal = request.signal
      const onAbort = (): void => {
        settleQuestion(callId, 'aborted', undefined, signal?.reason)
      }
      const claim = new AbortController()
      const questionEntry: PendingQuestion = {
        message, agent: request.agent, claim, claimHeld: false, otherDone: false,
        sessionId,
        callId,
        questions: message.questions,
        resolve,
        reject,
        close: (reason) => {
          signal?.removeEventListener('abort', onAbort)
          questionEntry.claim.abort()
          broadcast(sessionId, {
            type: 'question/closed',
            sessionId,
            callId,
            reason,
          } satisfies QuestionClosedMessage)
        },
      }
      questionRequests.set(callId, questionEntry)
      // 与审批同理：只要这条提问还挂着，列表就应把该会话标成「等人回答」。
      waitingQuestion.add(questionEntry.sessionId)
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort)
      broadcast(sessionId, message)
      const entry = questionRequests.get(callId)!
      holdQuestion(entry)
      // Let other frontends answer concurrently; unavailable/error cannot beat a live TUI.
      void Promise.resolve().then(next).then(result => {
        const value = result as { answers?: QuestionAnswer[] } | undefined
        if (Array.isArray(value?.answers) && validAnswers(message.questions, value.answers)) {
          settleQuestion(callId, 'answered', value.answers)
        } else entry.otherDone = true
      }, () => { entry.otherDone = true }).finally(() => {
        if (entry.otherDone && watchersFor(sessionId).length === 0 && !entry.claimHeld) {
          settleQuestion(callId, 'detached', undefined, new Error('no answerer remains'))
        }
      })
    })
  }

  // Agent-scoped waterfalls only reach global listeners, like approvals.
  const disposeQuestion = ctx.on('user-questions/request', handleQuestion as never, { global: true, prepend: true })

  /** Refuse an answer whose request already settled (a second TUI window). */
  const lateQuestionAnswer = (channel: Channel, callId: string): boolean => {
    if (!settledAsks.has(callId)) return false
    sendError(channel, {
      type: 'error',
      code: 'QUESTION_NOT_PENDING',
      message: `question ${callId} was already answered`,
    })
    return true
  }

  const attach = async (channel: Channel, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'attach requires a sessionId',
      })
      return
    }

    if (!channel.alive) return
    // Subscribe before reading: an event emitted between the read and the
    // subscription would otherwise be lost. The client buffers messages
    // until `attached`, then dedupes them by seq.
    watch(channel, sessionId)
    let snapshot: { session: SessionHeader; events: SessionEvent[] }
    let hasMore = false
    let modelSelection: ModelSelection | undefined
    let modelSelectionLastUsed: ModelSelection | undefined
    try {
      const controller = sessionController()
      if (controller?.follow && controller.page) {
        const opening = await openHistory(controller, sessionId, AbortSignal.timeout(10_000))
        const openingEvents = historyEvents(opening)
        snapshot = { session: opening.header, events: openingEvents.slice(-500) }
        const projection = opening.projections?.values?.modelSelection as { next?: unknown; lastUsed?: unknown } | undefined
        const selection = openingEvents.reduce(advanceModelSelection, {} as ModelSelectionState)
        modelSelection = readModelSelection(projection?.next ?? projection?.lastUsed) ?? selection.pending ?? selection.lastUsed
        modelSelectionLastUsed = readModelSelection(projection?.lastUsed) ?? selection.lastUsed
        historyCuts.get(channel)?.set(sessionId, opening.cursor)
        if (!historyCuts.has(channel)) historyCuts.set(channel, new Map([[sessionId, opening.cursor]]))
        // The owner budgets messages, which can contain thousands of tool or
        // telemetry events. Bound our transport in events as well.
        hasMore = opening.hasMore || openingEvents.length > snapshot.events.length
      } else {
        const all = await ctx.sessionQuery.readSession(sessionId)
        snapshot = { session: all.session, events: all.events.slice(-500) }
        const selection = all.events.reduce(advanceModelSelection, {} as ModelSelectionState)
        modelSelection = selection.pending ?? selection.lastUsed
        modelSelectionLastUsed = selection.lastUsed
        hasMore = all.events.length > 500
      }
    } catch (error) {
      unwatch(channel, sessionId)
      throw error
    }
    for (const pending of questionRequests.values()) if (pending.sessionId === sessionId) holdQuestion(pending)
    const status = ctx.agents.get(sessionId)?.status ?? (openTurn(snapshot.events) ? 'running' : 'idle')
    jsonLine(channel, {
      type: 'attached', sessionId, header: snapshot.session,
      cursor: historyCuts.get(channel)?.get(sessionId) ?? snapshot.events.at(-1)?.seq ?? -1,
      events: snapshot.events, hasMore, status,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(modelSelectionLastUsed === undefined ? {} : { modelSelectionLastUsed }),
      approvals: approvals.snapshot(sessionId),
      questions: [...questionRequests.values()].filter(p => p.sessionId === sessionId).map(p => p.message),
    })
    jsonLine(channel, { type: 'status', sessionId, status })
  }

  /** True when the newest turn event in a snapshot is a `turn/start`. */
  const openTurn = (events: readonly SessionEvent[]): boolean => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index]?.type
      if (type === 'turn/end' || type === 'turn/failed') return false
      if (type === 'turn/start') return true
    }
    return false
  }

  const history = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'session/history requires a sessionId' })
      return
    }
    const limit = typeof message.limit === 'number' && Number.isFinite(message.limit)
      ? Math.min(200, Math.max(1, Math.floor(message.limit))) : 50
    const before = typeof message.before === 'number' && Number.isSafeInteger(message.before) ? message.before : undefined
    const controller = sessionController()
    const throughSeq = historyCuts.get(channel)?.get(message.sessionId)
    let events: SessionEvent[], hasMore: boolean
    if (controller?.page && throughSeq !== undefined) {
      const page = await controller.page({ address: { kind: 'session', sessionId: message.sessionId }, throughSeq,
        ...(before === undefined ? {} : { beforeSeq: before }), maxMessages: limit }, AbortSignal.timeout(10_000))
      const pageEvents = historyEvents(page)
      events = pageEvents.slice(-limit)
      hasMore = page.hasMore || pageEvents.length > events.length
    } else {
      const snapshot = await ctx.sessionQuery.readSession(message.sessionId)
      const eligible = before === undefined ? snapshot.events : snapshot.events.filter(event => event.seq < before)
      events = eligible.slice(-limit)
      hasMore = eligible.length > events.length
    }
    const reply: HistoryMessage = { type: 'history', sessionId: message.sessionId, events,
      cursor: events[0]?.seq ?? -1, hasMore }
    jsonLine(channel, reply)
  }

  const createWorkspace = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry',
      })
      return
    }
    if (typeof message.path !== 'string' || message.path.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'workspace/create requires a path' })
      return
    }
    await registry.create(message.path, typeof message.title === 'string' ? message.title : undefined)
    jsonLine(channel, { type: 'workspaces', workspaces: workspaceList() })
  }

  const createSession = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry, so dshell cannot create a session',
        action: 'Create the session in the Web UI, then run dshell list.',
      })
      return
    }

    const controller = sessionController()
    if (controller?.create) {
      // 先确保 cwd 对应的 workspace 已注册，再把 workspaceId 交给 controller。
      //
      // 不这么做的话，`controller.create({ cwd })` 会**只建会话、不注册
      // workspace**：内核里 `const cwd = workspace?.path ?? request.cwd`，
      // 而 `if (workspace !== void 0) workspace.attachSession(...)` 在只传
      // cwd 时整段跳过。后果是新目录永远不进 workspace.json，此后任何按
      // workspace 过滤的列表（TUI 的 refreshSessions(workspaceId)）都会把
      // 这条会话静默 `continue` 掉——用户看到的就是"会话又没了"，但磁盘上
      // 文件完好无损。
      //
      // 注册之后一律传 workspaceId，让内核走"找得到 workspace"的分支，
      // 顺便由它做 attachSession。
      let targetWorkspaceId = typeof message.workspaceId === 'string' && message.workspaceId.length > 0
        ? message.workspaceId
        : undefined
      if (targetWorkspaceId === undefined) {
        const cwd = typeof message.cwd === 'string' && message.cwd.length > 0 ? message.cwd : process.cwd()
        const workspace = await registry.create(cwd)
        targetWorkspaceId = workspace.id
      }
      const created = await controller.create({ workspaceId: targetWorkspaceId })
      const snapshot = await ctx.sessionQuery.readSession(created.sessionId)
      // 立刻把新会话写进轻索引。
      //
      // 不这么做的话，列表走索引路径时**看不见这条新会话**——索引只在
      // `listSessionsFresh` 跑完后异步刷新（index.ts:1048），而那是几十秒
      // 一次的全量枚举。实测：新建一条会话并发起任务后，连续采样 15 秒，
      // `list` 里始终是 `(missing)`，手机上就是"刚建的会话半天不出现"。
      //
      // 这里写一行只有几十字节，比等一次全量枚举便宜得多。
      void sessionIndex().appendMany([{
        sessionId: created.sessionId,
        ...(snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd }),
        ...(snapshot.session.createdAt === undefined ? {} : { createdAt: snapshot.session.createdAt }),
        ...(typeof message.workspaceId === 'string' ? { workspaceId: message.workspaceId } : {}),
      }]).catch(() => undefined)
      jsonLine(channel, { type: 'session-created', sessionId: created.sessionId, header: snapshot.session, ...(typeof message.workspaceId === 'string' ? { workspaceId: message.workspaceId } : {}) })
      return
    }
    let workspace: WorkspaceLike | undefined
    if (typeof message.workspaceId === 'string' && message.workspaceId.length > 0) {
      workspace = registry.get(message.workspaceId)
      if (workspace === undefined) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: `unknown workspace: ${message.workspaceId}` })
        return
      }
    } else {
      const cwd = typeof message.cwd === 'string' && message.cwd.length > 0
        ? message.cwd
        : process.cwd()
      workspace = await registry.create(cwd, typeof message.title === 'string' ? message.title : undefined)
    }

    const composition = await composeAgent(undefined)
    const agentOptions = ctx.agentDefaultModel?.currentSelection()
    const sessionId = `session-${randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: workspace.path,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    })
    handles.set(sessionId, handle)
    await workspace.attachSession?.(sessionId).catch(() => undefined)
    watch(channel, sessionId)
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const reply: SessionCreatedMessage = {
      type: 'session-created',
      sessionId,
      header: snapshot.session,
      workspaceId: workspace.id,
    }
    jsonLine(channel, reply)
  }

  const prompt = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires a sessionId',
      })
      return
    }
    const rawContent = Array.isArray(message.content)
      ? message.content
      : typeof message.text === 'string' ? [{ type: 'text', text: message.text }] : []
    const content: PromptContentPart[] = []
    for (const raw of rawContent) {
      if (typeof raw !== 'object' || raw === null) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'prompt content parts must be objects' })
        return
      }
      const part = raw as Record<string, unknown>
      if (part.type === 'text' && typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text })
        continue
      }
      if (part.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(part.mediaType)) && typeof part.data === 'string') {
        content.push({
          type: 'image',
          mediaType: part.mediaType as Extract<PromptContentPart, { type: 'image' }>['mediaType'],
          data: part.data,
          ...(typeof part.name === 'string' ? { name: part.name } : {}),
        })
        continue
      }
      if (part.type === 'file' && typeof part.receiptId === 'string' && part.receiptId.length > 0) {
        content.push({ type: 'file', receiptId: part.receiptId })
        continue
      }
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: `unsupported prompt content part: ${String(part.type)}` })
      return
    }
    if (content.length === 0 || !content.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires text or an attachment',
      })
      return
    }
    const mode = message.mode === undefined ? 'queue' : message.mode
    if (mode !== 'queue' && mode !== 'steer') {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: `unsupported prompt mode: ${String(message.mode)}`,
      })
      return
    }

    if (!channel.alive) return
    const agent = await liveAgent(message.sessionId)
    if (!channel.alive) return
    watch(channel, message.sessionId)
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `dshell-${randomUUID()}`

    if (message.requireIdle === true) {
      const snapshot = agent.status === undefined ? await ctx.sessionQuery.readSession(message.sessionId) : undefined
      if (agent.status === 'running' || deferredFlights.has(message.sessionId) || deferredQueue.has(message.sessionId) || (snapshot && openTurn(snapshot.events)) || (agent.inbox?.nextTurn.length ?? 0) > 0 || (agent.inbox?.nextStep.length ?? 0) > 0) {
        sendError(channel, { type: 'error', code: 'SESSION_ACTIVE', message: 'print requires an idle session; use --new or wait for the current turn' })
        return
      }
    }
    const controller = sessionController()
    if (content.some(part => part.type !== 'text') && controller?.prompt === undefined) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'this Host cannot admit image or file prompt content' })
      return
    }
    // ── 严格排队：回合还开着就先扣下 ──
    //
    // `mode: 'steer'`（"插一句"）不排队——它的语义本来就是立刻插进当前回合，
    // 那个不受影响。只有 `queue` 需要等到回合结束。
    if (mode === 'queue' && (agent.status === 'running' || deferredFlights.has(message.sessionId) || deferredQueue.has(message.sessionId))) {
      const list = deferredQueue.get(message.sessionId) ?? []
      list.push({ requestId, content, sessionId: message.sessionId, channel })
      deferredQueue.set(message.sessionId, list)
      jsonLine(channel, { type: 'accepted', sessionId: message.sessionId, requestId, mode, deferred: true })
      return
    }

    if (message.requireIdle === true) activePrompt.set(message.sessionId, requestId)
    const flight = { started: false }
    if (mode === 'queue') deferredFlights.set(message.sessionId, flight)
    try {
      if (controller?.prompt) {
        await controller.prompt({ sessionId: message.sessionId, requestId, mode, content }, new AbortController().signal)
      } else {
        const text = content.filter((part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n')
        const userMessage: UserMessageLike = { id: requestId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } }
        if (mode === 'steer') agent.steer(userMessage)
        else agent.followup(userMessage)
      }
    } catch (error) {
      if (deferredFlights.get(message.sessionId) === flight) deferredFlights.delete(message.sessionId)
      if (activePrompt.get(message.sessionId) === requestId) activePrompt.delete(message.sessionId)
      throw error
    }
    jsonLine(channel, { type: 'accepted', sessionId: message.sessionId, requestId, mode })
  }

  /**
   * Abort the live subagents of one session: a cancelled turn stops its own
   * tool calls, but a child spawned earlier (or holding a lease) can outlive
   * it. Children are the sessions whose header says `origin: subagent` with
   * this session as the parent.
   */
  const cancelSubagents = async (sessionId: string): Promise<number> => {
    try {
      const records = await withTimeout(ctx.sessionQuery.listSessions(), SESSION_LIST_TIMEOUT_MS, 'session list')
      let cancelled = 0
      for (const record of records ?? []) {
        if (record.header.origin !== 'subagent' || record.header.parentSession !== sessionId) continue
        if (!record.live) continue
        const child = ctx.agents.get(record.header.id)
        if (child === undefined) continue
        child.cancel({ kind: 'user' })
        cancelled += 1
      }
      return cancelled
    } catch {
      // A session-list hiccup must not block the parent's own cancel.
      return 0
    }
  }

  const cancel = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'session/cancel requires a sessionId' })
      return
    }
    // Stop the parent's turn first — the user is watching it stop. The
    // subagent sweep can wait behind the session list without delaying it.
    const agent = ctx.agents.get(message.sessionId)
    if (typeof message.requestId === 'string' && activePrompt.get(message.sessionId) !== message.requestId) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'the requested prompt does not own the active turn' })
      return
    }
    if (message.continueQueued === true && message.killSubagents === true) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'cannot continue the queue while stopping the whole session' })
      return
    }
    if (agent !== undefined) {
      if (message.continueQueued === true) {
        const controller = sessionController()
        if (controller?.cancel) await controller.cancel({ sessionId: message.sessionId })
        else agent.cancel({ kind: 'user' }, { keepInbox: true })
        // Cancellation parks retained work. Re-enqueue the last item at the
        // same tail position to wake the driver, preserving every identity,
        // attachment and FIFO position. A wake after abort is latched by the
        // owner until the old turn converges; no polling or new prompt is needed.
        const inbox = agent.inbox
        const queued = inbox?.nextTurn.at(-1)
        const next = queued ?? inbox?.nextStep.at(-1)
        if (next !== undefined && inbox?.remove(next.id) !== false) {
          if (queued !== undefined) agent.followup(next)
          else agent.steer(next)
        }
      } else agent.cancel({ kind: 'user' })
    }
    const subagents = message.killSubagents === true ? await cancelSubagents(message.sessionId) : 0
    // 终止之后，排队的消息该不该继续跑？
    //
    // 旧行为是"终止 = 连排队一起清掉"：用户按了停止，队列里那条既没发出去、
    // 也不报错，气泡在界面上永远挂着——这就是"终止之后排队的消息发不出去"。
    //
    // 现在的默认：**保留**。`continueQueued === false` 才是显式要求清空。
    // 注意这里的延迟队列要一并处理，否则终止后它会永远卡在插件侧。
    const cancelSid = message.sessionId
    if (message.continueQueued === false) {
      deferredQueue.delete(cancelSid)
    } else {
      queueMicrotask(() => { void flushDeferred(cancelSid) })
    }
    jsonLine(channel, {
      type: 'cancelled',
      sessionId: message.sessionId,
      ...(subagents > 0 ? { subagentsCancelled: subagents } : {}),
      ...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
    })
  }

  const queuedMessage = (agent: AgentLike, requestId: string): UserMessageLike | undefined => {
    const inbox = agent.inbox
    if (inbox === undefined) return undefined
    return [...inbox.nextTurn, ...inbox.nextStep].find((message) => message.id === requestId)
  }

  const queueEdit = (channel: Channel, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string' || typeof message.text !== 'string') {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'queue/edit needs sessionId, requestId and text' })
      return
    }
    if (message.text.trim().length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'a queued prompt cannot be empty' })
      return
    }
    const deferred = deferredQueue.get(message.sessionId)?.find(entry => entry.requestId === message.requestId)
    if (deferred !== undefined) {
      deferred.content = [{ type: 'text', text: message.text }]
      jsonLine(channel, { type: 'queue-updated', sessionId: message.sessionId, requestId: message.requestId, action: 'edit' })
      return
    }
    const agent = ctx.agents.get(message.sessionId)
    const pending = agent === undefined ? undefined : queuedMessage(agent, message.requestId)
    if (agent === undefined || agent.inbox === undefined || pending === undefined) {
      sendError(channel, { type: 'error', code: 'QUEUE_ITEM_NOT_FOUND', message: 'that prompt is no longer queued' })
      return
    }
    agent.inbox.replace(message.requestId, { ...pending, content: [{ type: 'text', text: message.text }] })
    jsonLine(channel, { type: 'queue-updated', sessionId: message.sessionId, requestId: message.requestId, action: 'edit' })
  }

  const queueRemove = (channel: Channel, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string') {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'queue/remove needs a sessionId and requestId' })
      return
    }
    // 先查插件侧的延迟队列。严格排队生效后，用户刚发的消息**就待在这里**，
    // 而不再进内核 inbox——只查内核必然 QUEUE_ITEM_NOT_FOUND，
    // 这正是"排队撤回永远失败"的原因。
    const deferred = deferredQueue.get(message.sessionId)
    if (deferred !== undefined) {
      const index = deferred.findIndex((entry) => entry.requestId === message.requestId)
      if (index >= 0) {
        deferred.splice(index, 1)
        if (deferred.length === 0) deferredQueue.delete(message.sessionId)
        jsonLine(channel, {
          type: 'queue-updated',
          sessionId: message.sessionId,
          requestId: message.requestId,
          action: 'remove',
        })
        return
      }
    }
    const agent = ctx.agents.get(message.sessionId)
    const pending = agent === undefined ? undefined : queuedMessage(agent, message.requestId)
    if (agent === undefined || agent.inbox === undefined || pending === undefined) {
      sendError(channel, { type: 'error', code: 'QUEUE_ITEM_NOT_FOUND', message: 'that prompt is no longer queued' })
      return
    }
    agent.inbox.remove(message.requestId)
    jsonLine(channel, { type: 'queue-updated', sessionId: message.sessionId, requestId: message.requestId, action: 'remove' })
  }

  const answerApproval = (channel: Channel, message: Record<string, unknown>): void => {
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'approval/answer requires requestId' })
      return
    }
    if (message.outcome !== 'allowed-once' && message.outcome !== 'rejected') {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'approval outcome must be allowed-once or rejected' })
      return
    }
    // Requests remain answerable even before the client watches their session.
    const known = pendingApprovalInfo.get(message.requestId)
    const sessionId = known?.sessionId ?? approvals.sessionOf(message.requestId)
    if (sessionId === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'APPROVAL_NOT_PENDING',
        message: `approval "${message.requestId}" is not pending`,
      })
      return
    }
    // 不再要求本端先 watch：用户在手机上作答时，正是"没点进去"的状态。
    // 作答权限由 requestId 本身保证（只有收到列表的那一端才知道它）。
    // 这里只要求它确实还是待决的，避免对已过期的请求作答。
    if (approvals.has(message.requestId)) {
      approvals.answer(message.requestId, message.outcome)
      return
    }
    // The request may have settled between the metadata lookup and the answer.
    sendError(channel, {
      type: 'error',
      code: 'APPROVAL_NOT_PENDING',
      message: `approval "${message.requestId}" is no longer pending`,
    })
  }

  /**
   * Answer a pending `ask_user_question`. The Host's UserQuestionService
   * settles the waiting tool call when it sees a steered user message whose
   * source kind is `user-question-reply`, so the plugin uses exactly that
   * channel — the same one the Web UI's late answers take.
   */
  const answerQuestion = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires a sessionId' })
      return
    }
    if (typeof message.callId !== 'string' || message.callId.length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires a callId' })
      return
    }
    if (!Array.isArray(message.answers)) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires an answers array' })
      return
    }
    const answers: { id: string; selected: string[]; custom?: string }[] = []
    for (const raw of message.answers) {
      if (typeof raw !== 'object' || raw === null) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'each answer must be an object' })
        return
      }
      const answer = raw as Record<string, unknown>
      if (typeof answer.id !== 'string' || !Array.isArray(answer.selected)) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'each answer requires id and selected' })
        return
      }
      const selected = answer.selected.filter((item): item is string => typeof item === 'string')
      const custom = typeof answer.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom : undefined
      answers.push({ id: answer.id, selected, ...(custom === undefined ? {} : { custom }) })
    }

    if (!channel.alive) return
    const pending = questionRequests.get(message.callId)
    if (pending) {
      if (pending.sessionId !== message.sessionId || !watched.get(channel)?.has(message.sessionId) || !validAnswers(pending.questions, answers)) {
        sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'answer does not match the pending session and complete question batch' })
        return
      }
      settleQuestion(message.callId, 'answered', answers)
    } else {
      if (lateQuestionAnswer(channel, message.callId)) return
      const owner = questionService()
      if (!owner?.answer) {
        sendError(channel, { type: 'error', code: 'QUESTION_NOT_PENDING', message: 'this question has no live request or continued-question owner' })
        return
      }
      const agent = await liveAgent(message.sessionId)
      if (!owner.answer(agent, message.callId, { answers })) {
        sendError(channel, { type: 'error', code: 'QUESTION_NOT_PENDING', message: 'question is no longer answerable' })
        return
      }
    }
    jsonLine(channel, {
      type: 'question-answered',
      sessionId: message.sessionId,
      callId: message.callId,
    })
  }

  const dispatch = async (channel: Channel, message: Record<string, unknown>): Promise<void> => {
    try {
      switch (message.type) {
        case 'hello': {
          if (message.protocol !== PROTOCOL_VERSION) {
            sendError(channel, {
              type: 'error',
              code: 'PROTOCOL_MISMATCH',
              message: `protocol ${String(message.protocol)} is not supported; expected ${PROTOCOL_VERSION}`,
              action: 'Update the dshell CLI or the dshell-host plugin so both use protocol 2.',
            })
            return
          }
          jsonLine(channel, {
            type: 'welcome',
            protocol: PROTOCOL_VERSION,
            pluginVersion: packageVersion(),
            dshVersion: inferDshVersion(),
            capabilities: (CAPABILITIES as readonly Capability[]).filter((capability) => {
              if (capability === 'models') return sessionController() !== undefined
              if (capability === 'prompt-content') return sessionController()?.prompt !== undefined
              if (capability === 'providers') return providerFile() !== undefined
              if (capability === 'provider-key') return credentialStore() !== undefined && providerFile() !== undefined
              if (capability === 'provider-discover') return llmDiscovery() !== undefined
              if (capability === 'agents') return configEditor() !== undefined
              if (capability === 'session-rename') return sessionController()?.rename !== undefined
              if (capability === 'session-fork') return sessionController()?.fork !== undefined
              if (capability === 'session-archive') return ctx.workspaceRegistry?.archiveSession !== undefined && ctx.workspaceRegistry?.unarchiveSession !== undefined
              if (capability === 'session-pin') return ctx.workspaceRegistry?.pinSession !== undefined && ctx.workspaceRegistry?.unpinSession !== undefined
              if (capability === 'skills') return skillRegistry() !== undefined
              return true
            }),
            socketPath,
            // Keep the handshake O(1). Session enumeration can block on a
            // shared DSH home (other live Hosts, locked stores); clients issue
            // an explicit `list` after connecting, where a slow path can be
            // reported without making the whole Host look absent.
            sessions: [],
            workspaces: workspaceList(),
          })
          // 状态订阅者连上就该看到当前状态，不该等它自己发 state。
          // 放在 welcome 之后异步推：握手必须 O(1)，而 listSessions 可能慢。
          if (channel.clientKind === 'pet') {
            void sendPetState(channel)
          }
          return
        }
        case 'ping':
          jsonLine(channel, { type: 'pong', time: Date.now() })
          return
        case 'list':
        case 'session/list': {
          const rows = await listSessions(
            typeof message.workspaceId === 'string' ? message.workspaceId : undefined,
            message.includeArchived === true,
          )
          // 查不到发 error 帧，**不发空 sessions**。
          //
          // 空 `sessions` 的意思是"这台机器上没有会话"，客户端会据此把首页清空；
          // 而真实情况只是这次查询超时了。两种情况必须让客户端能分清，
          // 否则用户看到的就是"任务全没了"，然后过一会儿又自己回来。
          if (rows === null) {
            sendError(channel, {
              type: 'error',
              code: 'SESSION_LIST_TIMEOUT',
              message: `session list did not finish in time; sessions were not cleared`,
            })
            return
          }
          jsonLine(channel, { type: 'sessions', sessions: rows })
          return
        }
        /**
         * `session/children`：按父会话查它的子 agent。
         *
         * 这是竞品都有、而 dshell 原来缺的一块。Claude Code 把子会话存成
         * `<session>/subagents/*.jsonl`（父目录在，子会话就一定在），Codex 用
         * `thread_spawn_edges(parent_thread_id, child_thread_id)` 建边。dshell
         * 原来 266 份子会话是平铺的，既列不出、也归不到任何父会话。
         *
         * 现在索引里记了 `parentSessionId`，这条请求就能把"孤儿"变成
         * "可查询的归属关系"。只读索引，不碰日志。
         */
        case 'session/children': {
          if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
            sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'sessionId is required' })
            return
          }
          const parentId = String(message.sessionId)
          const rows = await sessionIndex().rowsOf()
          let kids = [...rows.values()].filter(row => row.parentSessionId === parentId)
          // 索引是**派生数据**，可能还没建立（刚启动、刚清过、或索引写入是
          // fire-and-forget 异步的）。这时直接问一次会话记录，别让用户看到
          // "这个会话没有子任务"——那是把"不知道"撒谎成"没有"。
          if (kids.length === 0 && ctx.sessionQuery.listSessions !== undefined) {
            const records = await withTimeout(
              ctx.sessionQuery.listSessions(),
              SESSION_LIST_TIMEOUT_MS,
              'children fallback',
            )
            if (records !== undefined) {
              kids = records
                .filter(record => record.header.origin === 'subagent'
                  && record.header.parentSession === parentId)
                .map((record) => {
                  const row: SessionIndexRow = {
                    sessionId: String(record.header.id),
                    origin: 'subagent',
                    parentSessionId: parentId,
                  }
                  if (record.header.title !== undefined) row.title = record.header.title
                  if (record.header.cwd !== undefined) row.cwd = record.header.cwd
                  if (record.header.createdAt !== undefined) row.createdAt = record.header.createdAt
                  if (record.header.delegationDepth !== undefined) row.delegationDepth = record.header.delegationDepth
                  return row
                })
            }
          }
          // Fill missing child titles from logs before returning the requested family.
          await fillChildTitles(kids)
          const children = kids
            .map(row => ({
              sessionId: row.sessionId,
              ...(row.title === undefined ? {} : { title: row.title }),
              ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
              ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
              ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
              ...(row.delegationDepth === undefined ? {} : { delegationDepth: row.delegationDepth }),
            }))
          jsonLine(channel, { type: 'session-children', sessionId: message.sessionId, children })
          return
        }
        /**
         * `session/index-stats`：轻索引与保留期的只读报表。
         *
         * 只报告、不删除。清理仍然要用户明确决定——这一点与 dsh 上游
         * 自己的态度一致（"清理已存储检查点属于带外维护"）。
         */
        case 'session/index-stats': {
          const rows = await sessionIndex().rowsOf()
          const all = [...rows.values()]
          const subagents = all.filter(row => isSubagentRow(row))
          const main = all.filter(row => !isSubagentRow(row))
          const orphans = subagents.filter(row => {
            const parent = row.parentSessionId
            return parent === undefined || !rows.has(parent)
          })
          const expired = cleanupDays === undefined
            ? []
            : all.filter(row => isExpired(row, cleanupDays))
          jsonLine(channel, {
            type: 'session-index-stats',
            indexed: all.length,
            mainSessions: main.length,
            subagents: subagents.length,
            orphanSubagents: orphans.length,
            ...(cleanupDays === undefined ? {} : { cleanupPeriodDays: cleanupDays }),
            expired: expired.length,
            ...(cleanupDays === undefined ? {} : { expiredSample: expired.slice(0, 20).map(row => row.sessionId) }),
          })
          return
        }
        case 'workspaces':
          jsonLine(channel, { type: 'workspaces', workspaces: workspaceList() })
          return
        /**
         * `state`：给状态订阅者（宠物）的聚合视图。
         *
         * 为什么在服务端算：一个挂件只需要"现在在干什么"，但如果让客户端
         * 自己算，它就得订阅几十条会话的原始事件流。服务端本来就有这些数据，
         * 折叠一次比让每个客户端各折叠一次便宜得多。
         *
         * 相位由 `listSessions` 的 running / needsInput 直接得出——这是 Host
         * 已经算好的投影，不需要我们再扫事件。
         */
        case 'state':
          await sendPetState(channel)
          return
        case 'workspace/create':
          await createWorkspace(channel, message)
          return
        case 'session/create':
          await createSession(channel, message)
          return
        case 'session/history':
          await history(channel, message)
          return
        case 'attach':
          await attach(channel, message.sessionId)
          return
        case 'watch':
          if (typeof message.sessionId === 'string') watch(channel, message.sessionId)
          return
        case 'unwatch':
          unwatch(channel, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          return
        case 'detach':
          unwatch(channel, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          jsonLine(channel, {
            type: 'detached',
            ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
          })
          return
        case 'prompt':
          await prompt(channel, message)
          return
        case 'session/delete':
        case 'session/rename':
        case 'session/archive':
        case 'session/restore':
        case 'session/pin':
        case 'session/fork':
        case 'session/compact':
          await sessionAction(channel, message)
          return
        case 'session/cancel':
          await cancel(channel, message)
          return
        case 'queue/edit':
          queueEdit(channel, message)
          return
        case 'queue/remove':
          queueRemove(channel, message)
          return
        case 'approval/answer':
          answerApproval(channel, message)
          return
        case 'question/answer':
          await answerQuestion(channel, message)
          return
        case 'model/catalog':
          await forwardModelCatalog(channel)
          return
        case 'model/select':
          await selectModel(channel, message)
          return
        case 'model/default':
          await setDefaultModel(channel, message)
          return
        case 'skills/list':
          await listSkills(channel, message)
          return
        case 'skills/get':
          await getSkill(channel, message)
          return
        case 'provider/list':
          listProviders(channel)
          return
        case 'agents/list':
          jsonLine(channel, agentRoster())
          return
        case 'provider/update':
          await updateProvider(channel, message)
          return
        case 'provider/save':
          await saveProvider(channel, message)
          return
        case 'provider/api-key':
          await storeProviderKey(channel, message)
          return
        case 'provider/discover':
          await discoverProviderModels(channel, message)
          return
        case 'provider/sync-plan':
          await syncPlan(channel, message)
          return
        case 'provider/sync-apply':
          await syncApply(channel, message)
          return
        case 'provider/create':
          await createProvider(channel, message)
          return
        case 'provider/delete':
          await deleteProvider(channel, message)
          return
        case 'host/restart':
          await restartHost(channel)
          return
        default:
          sendError(channel, {
            type: 'error',
            code: 'BAD_REQUEST',
            message: `unknown message type: ${String(message.type)}`,
          })
      }
    } catch (error) {
      sendError(channel, mappedError(error))
    }
  }

  const handleLine = async (channel: Channel, line: string): Promise<void> => {
    if (Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024) {
      channel.close()
      return
    }
    let message: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a message object')
      message = value as Record<string, unknown>
      if (typeof message.type !== 'string') throw new Error('expected a message type')
      if (message.rpcId !== undefined && (typeof message.rpcId !== 'string' || message.rpcId.length < 1 || message.rpcId.length > 128)) throw new Error('invalid RPC identity')
    } catch (error) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: errorText(error) })
      return
    }
    await rpcContext.run({ channel, rpcId: message.rpcId as string | undefined }, () => dispatch(channel, message))
  }

  const enqueue = (channel: Channel, line: string): void => {
    const previous = queues.get(channel) ?? Promise.resolve()
    const next = previous
      .then(() => handleLine(channel, line))
      .catch((error: unknown) => sendError(channel, mappedError(error)))
    queues.set(channel, next)
    void next.finally(() => {
      if (queues.get(channel) === next) queues.delete(channel)
    })
  }

  /**
   * 一条连接断开后的清理。
   *
   * 与传输无关：从客户端集合、订阅表、历史游标、串行队列里移除，然后重新
   * 评估审批与人提问的等待者。CLI 断开和手机断开走的是同一条路径——
   * 这正是"多端同步"能成立的前提：中枢不知道也不关心你从哪种传输来的。
   */
  const cleanupChannel = (channel: Channel): void => {
    clients.delete(channel)
    historyCuts.delete(channel)
    unwatch(channel)
    queues.delete(channel)
    approvals.watchersChanged()
    for (const [callId, pending] of questionRequests) {
      if (watchersFor(pending.sessionId).length > 0) continue
      pending.claim.abort()
      pending.claimHeld = false
      if (pending.otherDone && !pending.message.timed) settleQuestion(callId, 'detached', undefined, new Error('the dshell client disconnected before answering'))
    }
  }

  /** 把一条新通道接入中枢：登记、给读写回调、断开时清理。 */
  const registerChannel = (channel: Channel): void => {
    clients.add(channel)
    if (channel instanceof WebSocketChannel) {
      // WS 客户端要声明自己是 app 还是 pet；中枢据此决定推送视图
      channel.onHello = (kind) => {
        channel.clientKind = kind
      }
    }
    // 由通道实现自己解析行；中枢只收到完整的行
    channel.onLine = (line: string) => enqueue(channel, line)
    channel.onClose = () => cleanupChannel(channel)
  }

  /** CLI：unix socket。行为与改造前一致。 */
  const server = createServer((socket) => {
    registerChannel(new UnixSocketChannel(socket))
  })

  server.on('error', (error) => {
    console.error(`[dshell-host] socket error: ${errorText(error)}`)
  })

  /**
   * WebSocket 入口：手机 App 与桌面宠物。
   *
   * **它与 unix socket 共享同一个中枢**——同一个 `clients`、同一张 `watched`、
   * 同一个 `ApprovalCoordinator`。这是"多端同步"的全部秘密：中枢不区分
   * 客户端从哪种传输来，只按订阅表广播。
   *
   * 鉴权在 upgrade 阶段做：连接建立时就校验 token，未通过直接 401 断开，
   * 不留一个"连上了但什么都不能做"的半死连接。
   */
  /**
   * 校验一条 WS 升级请求。
   *
   * token 可以走 `Authorization: Bearer` 或 `?token=`——后者是为了兼容
   * Android 客户端现有的连接方式，它一直用 URL 传。
   */
  const authorizeWs = (req: { headers: Record<string, string | string[] | undefined>; url?: string }): { ok: true; kind: 'app' | 'pet' } | { ok: false; status: number } => {
    const header = req.headers.authorization
    let token = ''
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim()
    } else {
      try {
        token = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('token') ?? ''
      } catch {
        token = ''
      }
    }
    if (devices.verify(token) === undefined) return { ok: false, status: 401 }
    const kind = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('client') === 'pet' ? 'pet' : 'app'
    return { ok: true, kind }
  }

  const wsServer: HttpServer | undefined = config.wsPort === undefined
    ? undefined
    : createHttpServer((req, res) => {
        const sendJson = (status: number, value: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        }
        if (req.url?.startsWith('/api/health')) {
          sendJson(200, { ok: true, plugin: 'dshell-host', protocol: PROTOCOL_VERSION })
          return
        }
        /**
         * 签发配对码。**只开给回环地址**——否则局域网里任何能访问端口的人
         * 都能自助配对，token 就形同虚设。本机用户（含 SSH 登录）随时能取，
         * 不必重启 Host。
         */
        if (req.url?.startsWith('/api/pair/code') === true && req.method === 'POST') {
          const remote = req.socket.remoteAddress ?? ''
          const fromLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
          if (!fromLoopback) {
            sendJson(403, { error: 'LOOPBACK_ONLY' })
            return
          }
          const code = pairCodes.issue()
          console.error(`[dshell-host] 配对码 ${code}（5 分钟内有效）`)
          sendJson(200, { code, expiresAt: Date.now() + 5 * 60 * 1000 })
          return
        }
        /** 用配对码换长期 token。码用掉即删，一个码换不出两份凭据。 */
        if (req.url?.startsWith('/api/pair/claim') === true && req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            let body: { code?: unknown; name?: unknown }
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown; name?: unknown }
            } catch {
              sendJson(400, { error: 'BAD_CODE' })
              return
            }
            if (!pairCodes.claim(String(body.code ?? '').trim().toUpperCase())) {
              sendJson(404, { error: 'CODE_NOT_FOUND_OR_EXPIRED' })
              return
            }
            const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'client'
            const token = devices.issue(name)
            /**
             * 回带 `server` 段：App 用它显示"已连接到哪台机器"并在换机时提醒。
             * `fingerprint` 取设备表文件的持久标识——同一台机器重装 dsh 后会变，
             * 正是 App 需要的"这还是不是原来那台"的判断依据。
             */
            sendJson(201, {
              deviceId: DeviceStore.hash(token).slice(0, 16),
              token,
              server: { name: hostName(), fingerprint: devices.fingerprint },
            })
            console.error(`[dshell-host] 已配对 ${name}`)
          })
          return
        }
        sendJson(404, { error: 'NOT_FOUND' })
      })

  wsServer?.on('upgrade', (req, socket) => {
    const authorized = authorizeWs(req)
    if (!authorized.ok) {
      // 401 而不是静默关闭：客户端要能区分"token 失效"和"网络不通"
      socket.write(`HTTP/1.1 ${authorized.status} Unauthorized\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    if (!acceptUpgrade(req, socket)) return
    const channel = new WebSocketChannel(socket)
    channel.clientKind = authorized.kind
    registerChannel(channel)
  })

  wsServer?.on('error', (error: NodeJS.ErrnoException) => {
    // 端口冲突不该拖垮整个 dsh：显式报错并只关掉这个入口
    if (error.code === 'EADDRINUSE') {
      console.error(`[dshell-host] WebSocket 端口 ${String(config.wsPort)} 已被占用，对外服务未启用。`)
      return
    }
    console.error(`[dshell-host] WebSocket error: ${errorText(error)}`)
  })

  if (wsServer !== undefined) {
    wsServer.listen(config.wsPort, config.wsHost ?? '0.0.0.0', () => {
      console.error(`[dshell-host] WebSocket 已监听 ws://${config.wsHost ?? '0.0.0.0'}:${String(config.wsPort)}/ws`)
    })
  }

  const disposeSessionEvent = ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
    noteAskCall(session.id, event)
    const data = (event.data ?? {}) as Record<string, any>
    if (event.type === 'user/message') {
      const message = data.message ?? data
      const id = message.source?.rpcId ?? message.id
      if (typeof id === 'string') activePrompt.set(session.id, id)
      previewCache.delete(session.id)
    }
    if (event.type === 'turn/start') {
      const flight = deferredFlights.get(session.id)
      if (flight !== undefined) flight.started = true
    }
    if (event.type === 'turn/end' || event.type === 'turn/failed') {
      activePrompt.delete(session.id)
      const flight = deferredFlights.get(session.id)
      if (flight === undefined || flight.started) {
        deferredFlights.delete(session.id)
        queueMicrotask(() => { void flushDeferred(session.id) })
      }
    }
    broadcast(session.id, { type: 'event', sessionId: session.id, event })
  })

  const disposeAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }: {
    agent: AgentLike
    frame: unknown
  }) => {
    broadcast(agent.id, { type: 'stream', sessionId: agent.id, frame })
  })

  const disposeAgentStatus = ctx.on('agent/status', ({ agent, status }: {
    agent: AgentLike
    status: string
  }) => {
    broadcast(agent.id, { type: 'status', sessionId: agent.id, status })
  })

  const handleApproval = async (request: ApprovalRequestLike, next: () => Promise<string>): Promise<string> => {
    const sessionId = request.agent.session.id
    const requestId = `approval-${randomUUID()}`
    const requestMessage: ApprovalRequestMessage = {
      type: 'approval-request',
      sessionId,
      requestId,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      expiresAt: Date.now() + approvalTimeoutMs,
    }
    // `begin` 会一直阻塞到这个审批有结论。在这段时间里，这个会话就是
    // 「有人在等用户」——列表必须能看见它，手机首页才画得出"待审批"。
    waitingApproval.add(sessionId)
    pendingApprovalInfo.set(requestId, {
      sessionId,
      ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      expiresAt: requestMessage.expiresAt,
    })
    try {
      return await approvals.begin({
        requestId,
        sessionId,
        timeoutMs: approvalTimeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        message: requestMessage,
        next,
      })
    } finally {
      pendingApprovalInfo.delete(requestId)
      if (![...pendingApprovalInfo.values()].some(info => info.sessionId === sessionId)) waitingApproval.delete(sessionId)
    }
  }

  // Agent-scoped waterfalls filter ordinary listeners by context. A global
  // listener is the supported way for the Host plugin to observe approvals
  // for every Agent it owns without duplicating the Web answerer.
  const disposeApproval = ctx.on('approval/request', handleApproval, { global: true, prepend: true })

  try {
    await listen(server, socketPath)
    chmodSync(socketPath, 0o600)
  } catch (error) {
    disposeSessionEvent()
    disposeAssistantStream()
    disposeAgentStatus()
    disposeApproval()
    disposeQuestion()
    closing = true
    for (const timer of deferredTimers.values()) clearTimeout(timer)
    for (const peer of [...clients]) peer.close()
    approvals.dispose()
    if (wsServer !== undefined) {
      wsServer.closeAllConnections()
      await new Promise<void>(resolve => wsServer.close(() => resolve()))
    }
    await closeServer(server)
    throw error
  }

  console.error(`[dshell-host] listening on ${socketPath}`)

  // Identity of the socket file this instance bound. close() only unlinks
  // the path while it still points at this file, so a replacement Host
  // (host/restart) that already re-bound the path can never have its socket
  // removed by the old process shutting down (DS-009).
  const boundIno: number | undefined = (() => {
    try {
      return statSync(socketPath).ino
    } catch {
      return undefined
    }
  })()

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    for (const timer of deferredTimers.values()) clearTimeout(timer)
    deferredTimers.clear()
    deferredFlights.clear()
    deferredQueue.clear()
    disposeSessionEvent()
    disposeAssistantStream()
    disposeAgentStatus()
    disposeApproval()
    disposeQuestion()
    for (const callId of [...questionRequests.keys()]) {
      settleQuestion(callId, 'detached', undefined, new Error('the dshell Host stopped before the user answered'))
    }
    approvals.dispose()
    // End (don't destroy) the clients so final frames — approval-resolved on
    // shutdown, host-restarting — flush before the connection drops; a
    // stalled peer gets destroyed once closeServer's bound gives up.
    const live = [...clients]
    // Channel.close() 负责先发关闭帧再断开；CLI 的 socket 实现等价于原来的 end()+destroy()
    for (const peer of live) peer.close()
    clients.clear()
    watched.clear()
    await closeServer(server)
    // WS 监听必须一起关：否则卸载插件（或测试结束）后端口仍被占着，
    // 进程也退不出去——这是个真实的句柄泄漏，不是测试环境特有的。
    if (wsServer !== undefined) {
      wsServer.closeAllConnections()
      await new Promise<void>((resolve) => wsServer.close(() => resolve()))
    }
    for (const handle of handles.values()) {
      await handle.dispose().catch(() => {})
    }
    handles.clear()
    try {
      const currentIno = statSync(socketPath).ino
      if (boundIno === undefined || currentIno === boundIno) unlinkSync(socketPath)
    } catch {
      // Already gone.
    }
  }

  /**
   * 启动预热：后台先跑一次会话列表。
   *
   * 冷启动那一次要 14~15 秒（枚举一个 266MB / 1034 文件的 DSH home），
   * 正好卡在 15 秒预算边缘。若不预热，**第一个连上来的客户端**必然吃满
   * 这 15 秒——App 冷启动就是白屏，宠物刚连上也是空的。
   *
   * 放在这里异步跑、不 await：握手和监听不该等它。预热失败也无所谓，
   * 下一次真实请求会自己重试。
   *
   * **延迟一拍再跑**：`apply()` 返回后调用方往往紧接着准备数据（测试里
   * 就是先 makeSession 再发 list）。若在这里同步抢跑，预热会把"还没有
   * 会话"的空结果写进缓存，之后的请求全被这个空缓存挡住。
   * 等一拍让调用方先把上下文就位，预热才有意义。
   */
  /**
   * 启动时把索引填起来。
   *
   * 索引空 = 列表走慢路径（14 秒级），所以启动后主动跑一次，让之后的列表
   * 直接命中索引。失败不重试：索引仍然会在下一次慢查询时被写满。
   */
  const primeSessionIndex = async (): Promise<void> => {
    if (priming !== undefined) return priming
    const run = (async () => {
      try {
        await sessionIndex().read()
        // 索引已经有内容就不必再跑一次慢查询；后台刷新会补齐增量。
        const rows = await sessionIndex().rowsOf()
        if (rows.size > 0) {
          indexPrimed = true
        } else {
          await listSessionsFresh(undefined, false)
        }
        // 索引就位后再补登记孤儿 workspace：这一步依赖索引里的 cwd，
        // 而且要等目录真的被扫到才有意义。历史 bug 留下的那些目录
        // （建了会话却没进注册表）就是靠这里一次性接回来的。
        await adoptOrphanWorkspaces().catch(() => 0)
      } catch {
        // 预热是尽力而为；失败时列表会在下次请求时自己回源。
      } finally {
        priming = undefined
      }
    })()
    priming = run
    return run
  }

  if (config.warmSessionList !== false) {
    const warm = setTimeout(() => {
      void primeSessionIndex().catch(() => undefined)
    }, 2_000)
    warm.unref?.()
  }

  ctx.effect(() => () => close())
}
