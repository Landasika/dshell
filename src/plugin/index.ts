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
  openSync,
  closeSync,
} from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'

import { UnixSocketChannel, type Channel } from './channel.js'
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
import { latestUserPreview } from '../shared/session-events.js'
import { advanceModelSelection, readModelSelection, type ModelSelectionState } from '../shared/model-selection.js'
import { DeviceStore, PairCodes, hostName } from './devices.js'
import { ApprovalCoordinator } from './approval.js'
import { openHistory, historyEvents, type HarnessHistoryOwner } from './harness-history.js'
import {
  HUB_PROVIDER,
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
    signal: AbortSignal,
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
    [row.id, row.displayName ?? '', row.baseURL ?? '', row.apiKeyEnv ?? '', String(row.models)].join('\u0000'))
}

function readProviderEntries(text: string): ProviderEntry[] {
  return readProviders(text).map((record) => ({
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.baseURL === undefined ? {} : { baseURL: record.baseURL }),
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
  const pendingInput = new Map<string, { at: number; value: 'approval' | 'question' | undefined }>()
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
      if (!channel.alive) return
      const sessions = rows.slice(0, 30).map((row) => ({
        id: row.sessionId,
        title: row.title ?? '',
        phase: phaseOf(row),
        updatedAt: row.updatedAt ?? row.createdAt ?? 0,
        preview: row.preview ?? '',
      }))
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

  const SESSION_LIST_TIMEOUT_MS = 15_000
  const SESSION_CACHE_MS = 4_000
  const PREVIEW_CACHE_MS = 300_000
  const PREVIEW_ROWS = 24
  const PREVIEW_BUDGET_MS = 1_500

  const listSessions = async (workspaceId?: string, includeArchived = false): Promise<SessionSummary[]> => {
    const cacheKey = `${workspaceId ?? ''}:${includeArchived ? 'archived' : 'active'}`
    const cached = sessionCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < SESSION_CACHE_MS) return cached.sessions
    const records = await withTimeout(ctx.sessionQuery.listSessions(), SESSION_LIST_TIMEOUT_MS, 'session list')
    if (records === undefined) return []
    const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    const pinned = new Set(ctx.workspaceRegistry?.pinnedSessionIds ?? [])
    // The durable activity time comes from the Host's session list projection;
    // without it the picker falls back to the creation time.
    const activity = new Map<string, number>()
    const runningIds = new Set<string>()
    const controller = sessionController()
    if (controller?.list !== undefined) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 4_000)
      try {
        const listed = await controller.list({}, abort.signal)
        for (const item of listed.items ?? []) {
          if (typeof item?.sessionId === 'string' && typeof item.updatedAt === 'number') {
            activity.set(item.sessionId, item.updatedAt)
          }
          if (typeof item?.sessionId === 'string' && item.running === true) {
            runningIds.add(item.sessionId)
          }
        }
      } catch {
        // Activity is presentation metadata; a slow or missing projection must
        // not keep the picker from showing the sessions.
      } finally {
        clearTimeout(timer)
      }
    }
    const lastActivity = (record: SessionRecordLike): number =>
      activity.get(record.header.id) ?? record.header.createdAt ?? 0
    const workspaces = workspaceList()
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
    const workspaceOf = (record: SessionRecordLike): WorkspaceSummary | undefined =>
      record.header.cwd === undefined ? undefined : workspaceByPath.get(record.header.cwd)
    const visible = records
      .filter(record => includeArchived || !archived.has(record.header.id))
      .filter((record) => record.header.origin !== 'subagent' && record.header.parentSession === undefined)
      .map((record) => ({ record, workspace: workspaceOf(record) }))
      .filter((entry) => workspaceId === undefined || entry.workspace?.id === workspaceId)
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
        ...(runningIds.has(record.header.id) ? { running: true } : {}),
        // A resident agent is not the same thing as a running turn; the turn
        // state lives in the event log, which this list does not read.
        status: runningIds.has(record.header.id) ? 'running' : record.live ? 'live' : 'idle',
      }
    })
    // "Needs input" comes from the durable tail of the running sessions only
    // (an idle turn cannot hold a live approval or question): an unanswered
    // approval/asked or a dangling ask_user_question call inside the open turn.
    const needsInputOf = (sessionId: string): Promise<'approval' | 'question' | undefined> => {
      const pending = pendingInput.get(sessionId)
      if (pending !== undefined && Date.now() - pending.at < SESSION_CACHE_MS) return Promise.resolve(pending.value)
      return withTimeout(ctx.sessionQuery.readSession(sessionId), 2_000, 'session tail').then((snapshot) => {
        const events = snapshot?.events ?? []
        let askTool: string | undefined
        let approval: 'approval' | undefined
        for (let index = Math.max(0, events.length - 300); index < events.length; index += 1) {
          const event = events[index]
          if (event === undefined) continue
          const type = event.type
          if (type === 'tool/call') {
            const name = (event.data as { name?: unknown } | null)?.name
            if (name === 'ask_user_question') askTool = String((event.data as { callId?: unknown } | null)?.callId ?? '')
          } else if (type === 'tool/result') {
            const callId = String(((event.data as { message?: { toolCallId?: unknown } } | null)?.message ?? {}).toolCallId ?? '')
            if (askTool !== undefined && (callId.length === 0 || callId === askTool)) askTool = undefined
          } else if (type === 'approval/asked') {
            approval = 'approval'
          } else if (type === 'approval/decided' || type === 'turn/end' || type === 'turn/failed') {
            approval = undefined
            askTool = undefined
          }
        }
        const value = askTool !== undefined ? 'question' : approval
        pendingInput.set(sessionId, { at: Date.now(), value })
        return value
      }).catch(() => undefined)
    }
    await Promise.all(sessions.map(async (session) => {
      if (session.running !== true) return
      const needs = await needsInputOf(session.sessionId)
      if (needs !== undefined) session.needsInput = needs
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
    sessionCache.set(cacheKey, { at: Date.now(), sessions })
    return sessions
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
    const profile = process.env.DSH_PROFILE
    if (profile !== undefined && profile.length > 0) {
      candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'))
    }
    candidates.push(join(home, 'cordis.patch.yml'))
    return candidates.filter((path) => existsSync(path))
  }

  const providerFile = (): string | undefined => {
    const owned = configEditor()?.documentPath
    if (owned) return owned
    const candidates = providerFileCandidates()
    // A file that declares no providers cannot be the one the Host routes.
    return candidates.find((path) => readProviders(safeRead(path)).length > 0) ?? candidates[0]
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
    const owner = providerOwner()
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
    let fd: number | undefined
    const temporary = file + '.dshell-' + randomUUID()
    try {
      fd = openSync(lock, 'wx', 0o600)
      if (safeRead(file) !== before) {
        sendError(channel, { type: 'error', code: 'CONFIG_CONFLICT', message: 'configuration changed; reload providers and retry' })
        return false
      }
      writeFileSync(temporary, after, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      return true
    } finally {
      if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock) } catch {} }
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
        message: 'provider/update needs providerId and one of baseURL, apiKeyEnv, displayName',
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
      const created = await controller.create({
        ...(typeof message.workspaceId === 'string' ? { workspaceId: message.workspaceId } : { cwd: typeof message.cwd === 'string' ? message.cwd : process.cwd() }),
      })
      const snapshot = await ctx.sessionQuery.readSession(created.sessionId)
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
      if (agent.status === 'running' || (snapshot && openTurn(snapshot.events)) || (agent.inbox?.nextTurn.length ?? 0) > 0 || (agent.inbox?.nextStep.length ?? 0) > 0) {
        sendError(channel, { type: 'error', code: 'SESSION_ACTIVE', message: 'print requires an idle session; use --new or wait for the current turn' })
        return
      }
    }
    const controller = sessionController()
    if (content.some(part => part.type !== 'text') && controller?.prompt === undefined) {
      sendError(channel, { type: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'this Host cannot admit image or file prompt content' })
      return
    }
    if (message.requireIdle === true) activePrompt.set(message.sessionId, requestId)
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
    const agent = ctx.agents.get(message.sessionId)
    const pending = agent === undefined ? undefined : queuedMessage(agent, message.requestId)
    if (agent === undefined || agent.inbox === undefined || pending === undefined) {
      sendError(channel, { type: 'error', code: 'QUEUE_ITEM_NOT_FOUND', message: 'that prompt is no longer queued' })
      return
    }
    if (message.text.trim().length === 0) {
      sendError(channel, { type: 'error', code: 'BAD_REQUEST', message: 'a queued prompt cannot be empty' })
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
    const sessionId = approvals.sessionOf(message.requestId)
    if (sessionId === undefined) {
      sendError(channel, {
        type: 'error',
        code: 'APPROVAL_NOT_PENDING',
        message: `approval "${message.requestId}" is not pending`,
      })
      return
    }
    if (watched.get(channel)?.has(sessionId) !== true) {
      sendError(channel, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'this client is not watching the approval session',
      })
      return
    }
    approvals.answer(message.requestId, message.outcome)
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
        case 'session/list':
          jsonLine(channel, {
            type: 'sessions',
            sessions: await listSessions(typeof message.workspaceId === 'string' ? message.workspaceId : undefined, message.includeArchived === true),
          })
          return
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
    if (event.type === 'turn/end' || event.type === 'turn/failed') activePrompt.delete(session.id)
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
    return await approvals.begin({
      requestId,
      sessionId,
      timeoutMs: approvalTimeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      message: requestMessage,
      next,
    })
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

  ctx.effect(() => () => close())
}
