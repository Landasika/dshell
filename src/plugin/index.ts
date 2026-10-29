import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  type ProviderEntry,
  type SkillEntry,
  type ApprovalRequestMessage,
  type Capability,
  type ErrorMessage,
  type HistoryMessage,
  type ModelCatalog,
  type ModelSelection,
  type SessionCreatedMessage,
  type SessionEvent,
  type SessionHeader,
  type SessionSummary,
  type WorkspaceSummary,
} from '../protocol/index.js'
import { resolveSocketPath } from '../shared/paths.js'
import { ApprovalCoordinator } from './approval.js'
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
  isProviderField,
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
  source: { kind: 'user' } | { kind: 'user-question-reply'; callId: string; outcome: 'answered' }
}

interface InboxLike {
  nextTurn: readonly UserMessageLike[]
  nextStep: readonly UserMessageLike[]
  remove(id: string): void
  replace(id: string, message: UserMessageLike): void
}

interface AgentLike {
  id: string
  session: { id: string }
  followup(message: UserMessageLike): void
  steer(message: UserMessageLike): void
  cancel(cause: { kind: 'user' }): void
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
}

interface AgentDefaultModelLike {
  currentSelection(): Record<string, unknown>
  saveSelection?(selection: ModelSelection): Promise<void>
}

interface SessionControllerLike {
  modelCatalog(): Promise<ModelCatalog>
  selectModel(request: ModelSelection & { sessionId: string }): Promise<{ selected: ModelSelection }>
  list?(
    request: { cursor?: string },
    signal: AbortSignal,
  ): Promise<{ items: readonly { sessionId: string; updatedAt: number }[] }>
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
  if (/already owned by an active write/i.test(message)) {
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

function jsonLine(socket: Socket, message: unknown): void {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The peer may reset between the writable check and the write.
  }
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

function canConnect(socketPath: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      settle(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      settle(false)
    })
    socket.connect(socketPath)
  })
}

async function prepareSocketPath(socketPath: string): Promise<void> {
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
    if (await canConnect(socketPath)) {
      throw new Error(`another dshell host is already listening on ${socketPath}`)
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

  const clients = new Set<Socket>()
  const watched = new Map<Socket, Set<string>>()
  const handles = new Map<string, AgentHandleLike>()
  const resuming = new Map<string, Promise<AgentHandleLike>>()
  const queues = new WeakMap<Socket, Promise<void>>()
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
  const titleCache = new Map<string, { at: number; title: string }>()
  const SESSION_LIST_TIMEOUT_MS = 15_000
  const SESSION_CACHE_MS = 4_000

  const listSessions = async (workspaceId?: string): Promise<SessionSummary[]> => {
    const cacheKey = workspaceId ?? ''
    const cached = sessionCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < SESSION_CACHE_MS) return cached.sessions
    const records = await withTimeout(ctx.sessionQuery.listSessions(), SESSION_LIST_TIMEOUT_MS, 'session list')
    if (records === undefined) return []
    // The durable activity time comes from the Host's session list projection;
    // without it the picker falls back to the creation time.
    const activity = new Map<string, number>()
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
      .filter((record) => record.header.origin !== 'subagent' && record.header.parentSession === undefined)
      .map((record) => ({ record, workspace: workspaceOf(record) }))
      .filter((entry) => workspaceId === undefined || entry.workspace?.id === workspaceId)
      .sort((left, right) => lastActivity(right.record) - lastActivity(left.record))

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

    const sessions = visible.map(({ record, workspace }) => {
      const title = titles.get(record.header.id) ?? record.header.title
      return {
        sessionId: record.header.id,
        ...(title === undefined || title.length === 0 ? {} : { title }),
        cwd: record.header.cwd,
        createdAt: record.header.createdAt,
        ...(activity.has(record.header.id) ? { updatedAt: activity.get(record.header.id) } : {}),
        live: record.live,
        persisted: record.persisted,
        formatStatus: record.formatStatus,
        ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        // A resident agent is not the same thing as a running turn; the turn
        // state lives in the event log, which this list does not read.
        status: record.live ? 'live' : 'idle',
      }
    })
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
    if (pending !== undefined) return (await pending).agent

    const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
    let presetId: string | undefined
    let sessionModel: Record<string, unknown> | undefined
    try {
      presetId = observation.projections?.values.agentPreset
      sessionModel = observation.projections?.values.modelSelection?.lastUsed
    } finally {
      observation[Symbol.dispose]()
    }
    const composition = await composeAgent(presetId)
    const agentOptions = sessionModel ?? ctx.agentDefaultModel?.currentSelection()

    const resume = ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    })
      .then((handle) => {
        handles.set(sessionId, handle)
        return handle
      })
      .finally(() => {
        resuming.delete(sessionId)
      })
    resuming.set(sessionId, resume)
    return (await resume).agent
  }

  const sendError = (socket: Socket, error: ErrorMessage): void => {
    jsonLine(socket, error)
  }

  const sessionController = (): SessionControllerLike | undefined => {
    const lookup = ctx.get?.('sessionController')
    return lookup as SessionControllerLike | undefined
  }

  const forwardModelCatalog = async (socket: Socket): Promise<void> => {
    const controller = sessionController()
    if (controller === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host mounts no session controller, so it cannot list models',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    const catalog = await controller.modelCatalog()
    jsonLine(socket, { type: 'model-catalog', catalog })
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

  const selectModel = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    const selection = parseSelection(message)
    if (sessionId.length === 0 || selection === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'model/select needs sessionId, provider and model',
      })
      return
    }
    const controller = sessionController()
    if (controller === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host mounts no session controller, so it cannot switch models',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    const { selected } = await controller.selectModel({ sessionId, ...selection })
    jsonLine(socket, { type: 'model-selected', sessionId, selected, savedAsDefault: true })
  }

  const setDefaultModel = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const selection = parseSelection(message)
    if (selection === undefined) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'model/default needs provider and model' })
      return
    }
    const defaults = ctx.agentDefaultModel
    if (defaults?.saveSelection === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host cannot save a default model',
        action: 'Update the DSH Host, or select the model in the Web UI.',
      })
      return
    }
    await defaults.saveSelection(selection)
    jsonLine(socket, { type: 'model-selected', selected: selection, savedAsDefault: true })
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

  const listSkills = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = skillRegistry()
    if (registry === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'SKILLS_UNAVAILABLE',
        message: 'this Host has no skills registry',
        action: 'Load the bundled skill providers (dsh-skill / dsh-skill-filesystem) in the profile, then restart the Host.',
      })
      return
    }
    const cwd = typeof message.cwd === 'string' && message.cwd.length > 0 ? message.cwd : undefined
    let skills: SkillEntry[]
    try {
      invalidateSkillCatalog?.()
      const summaries = await registry.list(cwd === undefined ? {} : { cwd })
      skills = summaries.map(toSkillEntry)
    } catch (error) {
      sendError(socket, {
        type: 'error',
        code: 'SKILLS_FAILED',
        message: errorText(error),
        action: 'Run /skills again; if it keeps failing the skill providers are unhealthy.',
      })
      return
    }
    jsonLine(socket, { type: 'skills', ...(cwd === undefined ? {} : { cwd }), hub: hubDirs, skills })
  }

  const getSkill = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = skillRegistry()
    const name = typeof message.name === 'string' ? message.name.trim() : ''
    if (registry === undefined || name.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'SKILLS_UNAVAILABLE',
        message: name.length === 0 ? 'skills/get needs a name' : 'this Host has no skills registry',
        action: 'Run /skills to see the available skills.',
      })
      return
    }
    const cwd = typeof message.cwd === 'string' && message.cwd.length > 0 ? message.cwd : undefined
    try {
      const skill = await registry.get(name, cwd === undefined ? {} : { cwd })
      if (skill === undefined) {
        sendError(socket, {
          type: 'error',
          code: 'SKILL_MISSING',
          message: `skill "${name}" is not loadable`,
          action: 'It may have been removed since the catalog was read; run /skills again.',
        })
        return
      }
      jsonLine(socket, { type: 'skill', name: skill.name, content: skill.content })
    } catch (error) {
      sendError(socket, {
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
    const candidates = [join(home, 'cordis.patch.yml')]
    const profile = process.env.DSH_PROFILE
    if (profile !== undefined && profile.length > 0) {
      candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'))
    }
    return candidates.filter((path) => existsSync(path))
  }

  const providerFile = (): string | undefined => {
    const candidates = providerFileCandidates()
    // A file that declares no providers cannot be the one the Host routes.
    return candidates.find((path) => readProviders(safeRead(path)).length > 0) ?? candidates[0]
  }

  const providerRows = (): ProviderEntry[] => {
    const file = providerFile()
    return file === undefined ? [] : readProviderEntries(safeRead(file))
  }

  /**
   * Persist a rewrite only when the re-parsed file still says exactly what was
   * intended. A near-miss (indentation drift, quoting slip) refuses the write
   * and leaves the file untouched.
   */
  const persistProviders = (socket: Socket, file: string, after: string, expected: ProviderEntry[]): boolean => {
    if (JSON.stringify(providerSignature(expected)) !== JSON.stringify(providerSignature(readProviderEntries(after)))) {
      sendError(socket, {
        type: 'error',
        code: 'INTERNAL',
        message: 'refusing to write: the edited patch file no longer parses to the expected providers',
        action: 'Edit the provider rows in cordis.patch.yml by hand.',
      })
      return false
    }
    const temporary = `${file}.dshell-tmp`
    writeFileSync(temporary, after, { mode: 0o600 })
    renameSync(temporary, file)
    return true
  }

  const providerWritable = (file: string): boolean => {
    try {
      accessSync(file, fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  }

  const listProviders = (socket: Socket): void => {
    const file = providerFile()
    if (file === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host found no cordis.patch.yml to read providers from',
        action: 'Add provider rows to $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    jsonLine(socket, {
      type: 'provider-list',
      file,
      writable: providerWritable(file),
      providers: providerRows(),
    })
  }

  const updateProvider = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const field = typeof message.field === 'string' ? message.field : ''
    const value = typeof message.value === 'string' ? message.value : ''
    if (providerId.length === 0 || !isProviderField(field)) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'provider/update needs providerId and one of baseURL, apiKeyEnv, displayName',
      })
      return
    }
    const file = providerFile()
    if (file === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host found no cordis.patch.yml to write providers to',
        action: 'Create $DSH_HOME/cordis.patch.yml with an llm-pi-ai providers block.',
      })
      return
    }
    if (!providerWritable(file)) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: `${file} is not writable`,
        action: 'Fix the file permissions or edit the provider row by hand.',
      })
      return
    }
    if (field === 'baseURL' && !/^https?:\/\/[^\s]+$/.test(value.trim())) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'baseURL must be an absolute http(s) URL',
      })
      return
    }
    if (field === 'apiKeyEnv' && !/^[A-Z][A-Z0-9_]*$/.test(value.trim())) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'apiKeyEnv must be an upper-case environment variable name',
      })
      return
    }
    const before = safeRead(file)
    let after: string
    try {
      after = setProviderField(before, providerId, field, value)
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: error.message })
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
      if (!persistProviders(socket, file, after, expected)) return
    }
    jsonLine(socket, {
      type: 'provider-updated',
      file,
      providerId,
      field,
      value: value.trim(),
      providers: providerRows(),
    })
  }

  const createProvider = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    const baseURL = typeof message.baseURL === 'string' ? message.baseURL.trim() : ''
    const apiKeyEnv = typeof message.apiKeyEnv === 'string' ? message.apiKeyEnv.trim() : ''
    const displayName = typeof message.displayName === 'string' ? message.displayName.trim() : ''
    const models = Array.isArray(message.models)
      ? message.models
          .filter((model): model is string => typeof model === 'string')
          .map((model) => model.trim())
          .filter((model) => model.length > 0)
      : []
    if (providerId.length === 0 || baseURL.length === 0 || models.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'provider/create needs providerId, baseURL and at least one model id',
      })
      return
    }
    if (!/^https?:\/\/[^\s]+$/.test(baseURL)) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'baseURL must be an absolute http(s) URL' })
      return
    }
    if (apiKeyEnv.length > 0 && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'apiKeyEnv must be an upper-case environment variable name' })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined ? 'this Host found no cordis.patch.yml' : `${file} is not writable`,
        action: 'Create or fix $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    const before = safeRead(file)
    let after: string
    try {
      after = addProvider(before, {
        id: providerId,
        baseURL,
        models,
        ...(apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
        ...(displayName.length === 0 ? {} : { displayName }),
      })
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: error.message })
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
    if (!persistProviders(socket, file, after, [...providerRows(), entry])) return
    jsonLine(socket, { type: 'provider-created', file, providerId, providers: providerRows() })
  }

  const deleteProvider = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const providerId = typeof message.providerId === 'string' ? message.providerId.trim() : ''
    if (providerId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'provider/delete needs providerId' })
      return
    }
    const file = providerFile()
    if (file === undefined || !providerWritable(file)) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: file === undefined ? 'this Host found no cordis.patch.yml' : `${file} is not writable`,
        action: 'Create or fix $DSH_HOME/cordis.patch.yml, then restart the Host.',
      })
      return
    }
    const before = safeRead(file)
    let after: string
    try {
      after = removeProvider(before, providerId)
    } catch (error) {
      if (error instanceof ProviderEditError) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: error.message })
        return
      }
      throw error
    }
    const expected = providerRows().filter((row) => row.id !== providerId)
    if (!persistProviders(socket, file, after, expected)) return
    jsonLine(socket, { type: 'provider-deleted', file, providerId, providers: providerRows() })
  }

  const restartHost = async (socket: Socket): Promise<void> => {
    if (process.versions.electron !== undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'the Host runs inside Electron, so it cannot re-exec itself',
        action: 'Quit and reopen the desktop app.',
      })
      return
    }
    const argv = process.argv.slice(1)
    if (argv.length === 0) {
      sendError(socket, {
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
      sendError(socket, {
        type: 'error',
        code: 'INTERNAL',
        message: `could not re-exec the Host: ${process.execPath} is not executable`,
        action: 'Restart the Host by hand.',
      })
      return
    }
    jsonLine(socket, { type: 'host-restarting', pid: process.pid, argv })
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

  const watch = (socket: Socket, sessionId: string): Set<string> => {
    let sessions = watched.get(socket)
    if (sessions === undefined) {
      sessions = new Set()
      watched.set(socket, sessions)
    }
    sessions.add(sessionId)
    return sessions
  }

  const unwatch = (socket: Socket, sessionId?: string): void => {
    if (sessionId === undefined) {
      watched.delete(socket)
      return
    }
    const sessions = watched.get(socket)
    if (sessions === undefined) return
    sessions.delete(sessionId)
    if (sessions.size === 0) watched.delete(socket)
  }

  const watchersFor = (sessionId: string): Socket[] => {
    const result: Socket[] = []
    for (const [socket, sessions] of watched) {
      if (!socket.destroyed && sessions.has(sessionId)) result.push(socket)
    }
    return result
  }

  const broadcast = (sessionId: string, message: unknown): void => {
    for (const socket of watchersFor(sessionId)) jsonLine(socket, message)
  }

  const approvals = new ApprovalCoordinator({
    watchers: (sessionId) => watchersFor(sessionId).length,
    broadcast,
  })

  const attach = async (socket: Socket, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'attach requires a sessionId',
      })
      return
    }

    if (socket.destroyed) return
    // Subscribe before reading: an event emitted between the read and the
    // subscription would otherwise be lost. The client buffers messages
    // until `attached`, then dedupes them by seq.
    watch(socket, sessionId)
    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(sessionId)
    } catch (error) {
      unwatch(socket, sessionId)
      throw error
    }
    jsonLine(socket, {
      type: 'attached',
      sessionId,
      header: snapshot.session,
      cursor: snapshot.events.at(-1)?.seq ?? -1,
      events: snapshot.events,
    })
    // Tell a late attacher whether a turn is already running; without this the
    // client assumes idle and Enter would queue instead of steering.
    jsonLine(socket, { type: 'status', sessionId, status: openTurn(snapshot.events) ? 'running' : 'idle' })
  }

  /** True when the newest turn event in a snapshot is a `turn/start`. */
  const openTurn = (events: readonly SessionEvent[]): boolean => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index]?.type
      if (type === 'turn/end') return false
      if (type === 'turn/start') return true
    }
    return false
  }

  const history = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'session/history requires a sessionId' })
      return
    }
    const snapshot = await ctx.sessionQuery.readSession(message.sessionId)
    const limit = typeof message.limit === 'number' && Number.isFinite(message.limit)
      ? Math.min(200, Math.max(1, Math.floor(message.limit)))
      : 50
    const before = typeof message.before === 'number' && Number.isFinite(message.before)
      ? message.before
      : undefined
    const end = before === undefined
      ? snapshot.events.length
      : snapshot.events.findIndex((event) => event.seq >= before)
    const safeEnd = end === -1 ? snapshot.events.length : end
    const start = Math.max(0, safeEnd - limit)
    const events = snapshot.events.slice(start, safeEnd)
    const reply: HistoryMessage = {
      type: 'history',
      sessionId: message.sessionId,
      events,
      cursor: events[0]?.seq ?? -1,
      hasMore: start > 0,
    }
    jsonLine(socket, reply)
  }

  const createWorkspace = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry',
      })
      return
    }
    if (typeof message.path !== 'string' || message.path.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'workspace/create requires a path' })
      return
    }
    await registry.create(message.path, typeof message.title === 'string' ? message.title : undefined)
    jsonLine(socket, { type: 'workspaces', workspaces: workspaceList() })
  }

  const createSession = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    const registry = ctx.workspaceRegistry
    if (registry === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'this Host has no workspace registry, so dshell cannot create a session',
        action: 'Create the session in the Web UI, then run dshell list.',
      })
      return
    }

    let workspace: WorkspaceLike | undefined
    if (typeof message.workspaceId === 'string' && message.workspaceId.length > 0) {
      workspace = registry.get(message.workspaceId)
      if (workspace === undefined) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: `unknown workspace: ${message.workspaceId}` })
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
    watch(socket, sessionId)
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const reply: SessionCreatedMessage = {
      type: 'session-created',
      sessionId,
      header: snapshot.session,
      workspaceId: workspace.id,
    }
    jsonLine(socket, reply)
  }

  const prompt = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires a sessionId',
      })
      return
    }
    if (typeof message.text !== 'string' || message.text.length === 0) {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'prompt requires non-empty text',
      })
      return
    }
    const mode = message.mode === undefined ? 'queue' : message.mode
    if (mode !== 'queue' && mode !== 'steer') {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: `unsupported prompt mode: ${String(message.mode)}`,
      })
      return
    }

    if (socket.destroyed) return
    const agent = await liveAgent(message.sessionId)
    if (socket.destroyed) return
    watch(socket, message.sessionId)
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `dshell-${randomUUID()}`

    // Acknowledge before waking the Agent: followup() may synchronously emit
    // turn/start, and the client should see `accepted` before those events.
    jsonLine(socket, {
      type: 'accepted',
      sessionId: message.sessionId,
      requestId,
      mode,
    })

    const userMessage: UserMessageLike = {
      id: requestId,
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }
    if (mode === 'steer') agent.steer(userMessage)
    else agent.followup(userMessage)
  }

  const cancel = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'session/cancel requires a sessionId' })
      return
    }
    const agent = ctx.agents.get(message.sessionId)
    if (agent !== undefined) agent.cancel({ kind: 'user' })
    jsonLine(socket, {
      type: 'cancelled',
      sessionId: message.sessionId,
      ...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
    })
  }

  const queuedMessage = (agent: AgentLike, requestId: string): UserMessageLike | undefined => {
    const inbox = agent.inbox
    if (inbox === undefined) return undefined
    return [...inbox.nextTurn, ...inbox.nextStep].find((message) => message.id === requestId)
  }

  const queueEdit = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string' || typeof message.text !== 'string') {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'queue/edit needs sessionId, requestId and text' })
      return
    }
    const agent = ctx.agents.get(message.sessionId)
    const pending = agent === undefined ? undefined : queuedMessage(agent, message.requestId)
    if (agent === undefined || agent.inbox === undefined || pending === undefined) {
      sendError(socket, { type: 'error', code: 'QUEUE_ITEM_NOT_FOUND', message: 'that prompt is no longer queued' })
      return
    }
    if (message.text.trim().length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'a queued prompt cannot be empty' })
      return
    }
    agent.inbox.replace(message.requestId, { ...pending, content: [{ type: 'text', text: message.text }] })
    jsonLine(socket, { type: 'queue-updated', sessionId: message.sessionId, requestId: message.requestId, action: 'edit' })
  }

  const queueRemove = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string') {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'queue/remove needs a sessionId and requestId' })
      return
    }
    const agent = ctx.agents.get(message.sessionId)
    const pending = agent === undefined ? undefined : queuedMessage(agent, message.requestId)
    if (agent === undefined || agent.inbox === undefined || pending === undefined) {
      sendError(socket, { type: 'error', code: 'QUEUE_ITEM_NOT_FOUND', message: 'that prompt is no longer queued' })
      return
    }
    agent.inbox.remove(message.requestId)
    jsonLine(socket, { type: 'queue-updated', sessionId: message.sessionId, requestId: message.requestId, action: 'remove' })
  }

  const answerApproval = (socket: Socket, message: Record<string, unknown>): void => {
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'approval/answer requires requestId' })
      return
    }
    if (message.outcome !== 'allowed-once' && message.outcome !== 'rejected') {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'approval outcome must be allowed-once or rejected' })
      return
    }
    const sessionId = approvals.sessionOf(message.requestId)
    if (sessionId === undefined) {
      sendError(socket, {
        type: 'error',
        code: 'APPROVAL_NOT_PENDING',
        message: `approval "${message.requestId}" is not pending`,
      })
      return
    }
    if (watched.get(socket)?.has(sessionId) !== true) {
      sendError(socket, {
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
  const answerQuestion = async (socket: Socket, message: Record<string, unknown>): Promise<void> => {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires a sessionId' })
      return
    }
    if (typeof message.callId !== 'string' || message.callId.length === 0) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires a callId' })
      return
    }
    if (!Array.isArray(message.answers)) {
      sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'question/answer requires an answers array' })
      return
    }
    const answers: { id: string; selected: string[]; custom?: string }[] = []
    for (const raw of message.answers) {
      if (typeof raw !== 'object' || raw === null) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'each answer must be an object' })
        return
      }
      const answer = raw as Record<string, unknown>
      if (typeof answer.id !== 'string' || !Array.isArray(answer.selected)) {
        sendError(socket, { type: 'error', code: 'BAD_REQUEST', message: 'each answer requires id and selected' })
        return
      }
      const selected = answer.selected.filter((item): item is string => typeof item === 'string')
      const custom = typeof answer.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom : undefined
      answers.push({ id: answer.id, selected, ...(custom === undefined ? {} : { custom }) })
    }

    if (socket.destroyed) return
    const agent = await liveAgent(message.sessionId)
    if (socket.destroyed) return
    watch(socket, message.sessionId)

    const reply: UserMessageLike = {
      id: `dshell-answer-${randomUUID()}`,
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'answer_to_pending_question',
            tool: 'ask_user_question',
            callId: message.callId,
            answers,
          }),
        },
      ],
      source: { kind: 'user-question-reply', callId: message.callId, outcome: 'answered' },
    }
    agent.steer(reply)
    jsonLine(socket, {
      type: 'question-answered',
      sessionId: message.sessionId,
      callId: message.callId,
    })
  }

  const handleLine = async (socket: Socket, line: string): Promise<void> => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      sendError(socket, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'message is not valid JSON',
      })
      return
    }

    try {
      switch (message.type) {
        case 'hello': {
          if (message.protocol !== PROTOCOL_VERSION) {
            sendError(socket, {
              type: 'error',
              code: 'PROTOCOL_MISMATCH',
              message: `protocol ${String(message.protocol)} is not supported; expected ${PROTOCOL_VERSION}`,
              action: 'Update the dshell CLI or the dshell-host plugin so both use protocol 2.',
            })
            return
          }
          jsonLine(socket, {
            type: 'welcome',
            protocol: PROTOCOL_VERSION,
            pluginVersion: packageVersion(),
            dshVersion: inferDshVersion(),
            capabilities: (CAPABILITIES as readonly Capability[]).filter((capability) => {
              if (capability === 'models') return sessionController() !== undefined
              if (capability === 'providers') return providerFile() !== undefined
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
          return
        }
        case 'ping':
          jsonLine(socket, { type: 'pong', time: Date.now() })
          return
        case 'list':
        case 'session/list':
          jsonLine(socket, {
            type: 'sessions',
            sessions: await listSessions(typeof message.workspaceId === 'string' ? message.workspaceId : undefined),
          })
          return
        case 'workspaces':
          jsonLine(socket, { type: 'workspaces', workspaces: workspaceList() })
          return
        case 'workspace/create':
          await createWorkspace(socket, message)
          return
        case 'session/create':
          await createSession(socket, message)
          return
        case 'session/history':
          await history(socket, message)
          return
        case 'attach':
          await attach(socket, message.sessionId)
          return
        case 'watch':
          if (typeof message.sessionId === 'string') watch(socket, message.sessionId)
          return
        case 'unwatch':
          unwatch(socket, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          return
        case 'detach':
          unwatch(socket, typeof message.sessionId === 'string' ? message.sessionId : undefined)
          jsonLine(socket, {
            type: 'detached',
            ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
          })
          return
        case 'prompt':
          await prompt(socket, message)
          return
        case 'session/cancel':
          cancel(socket, message)
          return
        case 'queue/edit':
          queueEdit(socket, message)
          return
        case 'queue/remove':
          queueRemove(socket, message)
          return
        case 'approval/answer':
          answerApproval(socket, message)
          return
        case 'question/answer':
          await answerQuestion(socket, message)
          return
        case 'model/catalog':
          await forwardModelCatalog(socket)
          return
        case 'model/select':
          await selectModel(socket, message)
          return
        case 'model/default':
          await setDefaultModel(socket, message)
          return
        case 'skills/list':
          await listSkills(socket, message)
          return
        case 'skills/get':
          await getSkill(socket, message)
          return
        case 'provider/list':
          listProviders(socket)
          return
        case 'provider/update':
          await updateProvider(socket, message)
          return
        case 'provider/create':
          await createProvider(socket, message)
          return
        case 'provider/delete':
          await deleteProvider(socket, message)
          return
        case 'host/restart':
          await restartHost(socket)
          return
        default:
          sendError(socket, {
            type: 'error',
            code: 'BAD_REQUEST',
            message: `unknown message type: ${String(message.type)}`,
          })
      }
    } catch (error) {
      sendError(socket, mappedError(error))
    }
  }

  const enqueue = (socket: Socket, line: string): void => {
    const previous = queues.get(socket) ?? Promise.resolve()
    const next = previous
      .then(() => handleLine(socket, line))
      .catch((error: unknown) => sendError(socket, mappedError(error)))
    queues.set(socket, next)
    void next.finally(() => {
      if (queues.get(socket) === next) queues.delete(socket)
    })
  }

  const cleanupSocket = (socket: Socket): void => {
    clients.delete(socket)
    unwatch(socket)
    queues.delete(socket)
    approvals.watchersChanged()
  }

  const server = createServer((socket) => {
    clients.add(socket)
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket })
    lines.on('error', () => cleanupSocket(socket))
    lines.on('line', (line) => {
      if (line.trim().length > 0) enqueue(socket, line)
    })
    socket.on('close', () => cleanupSocket(socket))
    socket.on('error', () => cleanupSocket(socket))
  })

  server.on('error', (error) => {
    console.error(`[dshell-host] socket error: ${errorText(error)}`)
  })

  const disposeSessionEvent = ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
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
    approvals.dispose()
    // End (don't destroy) the clients so final frames — approval-resolved on
    // shutdown, host-restarting — flush before the connection drops; a
    // stalled peer gets destroyed once closeServer's bound gives up.
    const live = [...clients]
    for (const socket of live) socket.end()
    clients.clear()
    watched.clear()
    await closeServer(server)
    for (const socket of live) {
      if (!socket.destroyed) socket.destroy()
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
