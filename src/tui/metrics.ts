/**
 * Presentation-side session projection.
 *
 * The durable event log stays the only truth. This module only reads that log
 * and derives the numbers a terminal footer needs: model, context occupancy,
 * per-content-type estimates, token usage, TPS samples, todos and the current
 * activity. It is pure so a reconnect renders exactly the same footer.
 */
import type { SessionView } from '../backend/index.js'
import type { SessionEvent } from '../protocol/index.js'
import { estimateSessionCost, type SessionCost } from './cost.js'
import type { ThemeStyle } from './theme.js'
import { summarizeTool } from './events.js'
import { displayWidth } from './width.js'

type Json = Record<string, unknown>

export type ActivityPhase = 'idle' | 'thinking' | 'streaming' | 'tool' | 'approval' | 'done'

export interface Activity {
  phase: ActivityPhase
  /** Human-readable verb for the activity line. */
  verb: string
  toolName?: string
  detail?: string
}

export interface TodoItem {
  content: string
  status: string
  activeForm?: string
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface ContextSegments {
  system: number
  prompt: number
  assistant: number
  thinking: number
  tools: number
}

export interface SessionMetrics {
  model?: string
  provider?: string
  contextWindow?: number
  usedTokens: number
  /** Estimated composition of the context; undefined when nothing is known. */
  segments?: ContextSegments
  lastUsage?: TokenUsage
  outputTokens: number
  turnStartedAt?: number
  lastTurnMs?: number
  todos: TodoItem[]
  activity: Activity
  /** Tokens estimated from the live process-local stream. */
  liveTokens: number
  contextPct?: number
  /** Session-cumulative totals and estimated CNY spend. */
  cost: SessionCost
  /** Subagents spawned from this session, oldest first. */
  agents: AgentInfo[]
  /** Background jobs (bash tool) registered in this session. */
  jobs: JobSummary
}

export interface JobSummary {
  running: number
  total: number
  failed: number
}

export interface AgentInfo {
  agentId: string
  label: string
  mode?: string
  /** Epoch ms from `childCreatedAt` or the event time. */
  startedAt?: number
  status: 'running' | 'done' | 'failed'
}

export interface TpsSample {
  at: number
  tps: number
}

const EMPTY_SEGMENTS: ContextSegments = {
  system: 0,
  prompt: 0,
  assistant: 0,
  thinking: 0,
  tools: 0,
}

export function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined
}

function pickNumber(source: Json | undefined, keys: readonly string[]): number | undefined {
  if (source === undefined) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.max(0, parsed)
    }
  }
  return undefined
}

export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  const source = asObject(raw)
  if (source === undefined) return undefined
  const input = pickNumber(source, ['inputTokens', 'input_tokens', 'input', 'promptTokens', 'prompt_tokens']) ?? 0
  const output = pickNumber(source, ['outputTokens', 'output_tokens', 'output', 'completionTokens', 'completion_tokens']) ?? 0
  const cacheRead = pickNumber(source, [
    'cacheReadTokens',
    'cache_read_tokens',
    'cacheReadInputTokens',
    'cache_read_input_tokens',
    'cacheRead',
  ]) ?? 0
  const cacheWrite = pickNumber(source, [
    'cacheWriteTokens',
    'cache_write_tokens',
    'cacheCreationInputTokens',
    'cache_creation_input_tokens',
    'cacheWrite',
  ]) ?? 0
  const total = pickNumber(source, ['totalTokens', 'total_tokens', 'total']) ?? input + output + cacheRead + cacheWrite
  if (input + output + cacheRead + cacheWrite + total === 0) return undefined
  return { input, output, cacheRead, cacheWrite, total }
}

/** Cheap token estimate for text that did not come with usage metadata. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(displayWidth(text) / 3.5))
}

function contentOf(message: Json): unknown[] {
  const content = message.content
  return Array.isArray(content) ? content : []
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    const item = asObject(part)
    if (item?.type === 'text' && typeof item.text === 'string') out += item.text
  }
  return out
}

function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    const item = asObject(part)
    if (item?.type === 'reasoning' && typeof item.text === 'string') out += item.text
  }
  return out
}

function messageOf(data: Json): Json {
  return asObject(data.message) ?? data
}

function eventTime(event: SessionEvent): number | undefined {
  const raw = event.time
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  // DSH logs use epoch milliseconds; tolerate seconds from older exports.
  return raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw
}

function readModel(event: SessionEvent, data: Json): { model?: string; provider?: string } {
  const out: { model?: string; provider?: string } = {}
  if (event.type === 'request/context') {
    if (typeof data.model === 'string') out.model = data.model
    if (typeof data.provider === 'string') out.provider = data.provider
    else {
      const provider = asObject(data.provider)
      if (typeof provider?.id === 'string') out.provider = provider.id
      else if (typeof provider?.name === 'string') out.provider = provider.name
    }
  }
  const header = asObject(data.header)
  const config = asObject(header?.config) ?? asObject(data.config)
  if (out.model === undefined && typeof config?.model === 'string') out.model = config.model
  if (out.provider === undefined && typeof config?.provider === 'string') out.provider = config.provider
  return out
}

function parseTodos(event: SessionEvent): TodoItem[] | undefined {
  if (event.type !== 'todo/write' && event.type !== 'todo/update') return undefined
  const data = asObject(event.data)
  const list = Array.isArray(data?.todos)
    ? data.todos
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(event.data)
        ? (event.data as unknown[])
        : undefined
  if (list === undefined) return undefined
  const todos: TodoItem[] = []
  for (const raw of list) {
    const item = asObject(raw)
    if (item === undefined) continue
    const content = item.content ?? item.text ?? item.title
    if (typeof content !== 'string' || content.trim().length === 0) continue
    const rawStatus = String(item.status ?? 'pending')
    const status = rawStatus === 'done' || rawStatus === 'complete'
      ? 'completed'
      : rawStatus === 'active' || rawStatus === 'running' || rawStatus === 'in-progress'
        ? 'in_progress'
        : rawStatus
    const activeForm = typeof item.activeForm === 'string' ? item.activeForm : undefined
    todos.push({ content: content.trim(), status, ...(activeForm === undefined ? {} : { activeForm }) })
  }
  return todos
}

function toolCallId(data: Json): string {
  const id = data.callId ?? data.toolCallId ?? data.id
  return typeof id === 'string' ? id : ''
}

/** Collect context composition estimates from the durable transcript. */
export function estimateSegments(events: readonly SessionEvent[]): ContextSegments {
  const segments: ContextSegments = { ...EMPTY_SEGMENTS }
  for (const event of events) {
    const data = asObject(event.data) ?? {}
    switch (event.type) {
      case 'system/message': {
        segments.system += estimateTokens(textOf(contentOf(messageOf(data))))
        break
      }
      case 'user/message': {
        const message = messageOf(data)
        const text = textOf(contentOf(message))
        const source = asObject(message.source)
        if (source?.kind === 'user') segments.prompt += estimateTokens(text)
        else segments.system += estimateTokens(text)
        break
      }
      case 'assistant/message': {
        const message = messageOf(data)
        const content = contentOf(message)
        segments.assistant += estimateTokens(textOf(content))
        segments.thinking += estimateTokens(reasoningOf(content))
        break
      }
      case 'tool/call': {
        const args = data.arguments ?? data.input
        segments.tools += estimateTokens(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
        break
      }
      case 'tool/result': {
        const message = messageOf(data)
        const output = textOf(contentOf(message))
        if (output.length > 0) segments.tools += estimateTokens(output)
        else if (typeof data.output === 'string') segments.tools += estimateTokens(data.output)
        break
      }
      default:
        break
    }
  }
  return segments
}

function sumSegments(segments: ContextSegments): number {
  return segments.system + segments.prompt + segments.assistant + segments.thinking + segments.tools
}

const VERBS: Record<string, string> = {
  bash: 'Running command',
  shell: 'Running command',
  read: 'Reading',
  write: 'Writing',
  edit: 'Editing',
  apply_patch: 'Editing',
  glob: 'Searching files',
  grep: 'Searching',
  web_search: 'Searching the web',
  web_fetch: 'Reading the web',
  task: 'Delegating',
  todo_write: 'Planning',
  ask_user_question: 'Asking',
}

/** Tool name → human verb for the live activity line. */
export function activityVerb(toolName: string | undefined): string {
  if (toolName === undefined || toolName.length === 0) return 'Working'
  return VERBS[toolName] ?? `Running ${toolName}`
}

function unmatchedToolCall(events: readonly SessionEvent[]): { name: string; detail: string } | undefined {
  const results = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = asObject(event.data) ?? {}
    const id = toolCallId(messageOf(data))
    if (id.length > 0) results.add(id)
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return undefined
    if (event?.type !== 'tool/call') continue
    const data = asObject(event.data) ?? {}
    const id = toolCallId(data)
    if (id.length > 0 && results.has(id)) continue
    const name = String(data.name ?? data.toolName ?? 'tool')
    return {
      name,
      detail: summarizeTool(name, data.arguments ?? data.input),
    }
  }
  return undefined
}

function deriveActivity(view: SessionView): Activity {
  if (view.pendingApproval !== undefined) {
    return {
      phase: 'approval',
      verb: 'Waiting for approval',
      toolName: view.pendingApproval.toolName,
      detail: view.pendingApproval.reason,
    }
  }
  if (view.status === 'running') {
    const call = unmatchedToolCall(view.events)
    if (call !== undefined) return { phase: 'tool', verb: activityVerb(call.name), toolName: call.name, detail: call.detail }
    if (view.streamText.trim().length > 0) return { phase: 'streaming', verb: 'Writing' }
    return { phase: 'thinking', verb: 'Thinking' }
  }
  // Idle. Only call it "done" when the last turn actually completed.
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') break
    if (event.type !== 'turn/end') continue
    const data = asObject(event.data) ?? {}
    const reason = asObject(data.reason) ?? {}
    if (reason.kind === 'completed') return { phase: 'done', verb: 'Ready' }
    return { phase: 'idle', verb: 'Ready' }
  }
  return { phase: 'idle', verb: 'Ready' }
}

function turnTiming(events: readonly SessionEvent[]): {
  turnStartedAt?: number
  lastTurnMs?: number
} {
  let startAt: number | undefined
  let lastTurnMs: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      startAt = eventTime(event)
      continue
    }
    if (event.type !== 'turn/end') continue
    const end = eventTime(event)
    if (startAt !== undefined && end !== undefined && end >= startAt) lastTurnMs = end - startAt
    startAt = undefined
  }
  return {
    ...(startAt === undefined ? {} : { turnStartedAt: startAt }),
    ...(lastTurnMs === undefined ? {} : { lastTurnMs }),
  }
}

/**
 * Project one SessionView into footer metrics. `now` is only used to clamp
 * impossible timings; the returned values are otherwise deterministic.
 */
export function collectMetrics(view: SessionView | undefined, now = Date.now()): SessionMetrics {
  if (view === undefined) {
    return {
      usedTokens: 0,
      outputTokens: 0,
      todos: [],
      activity: { phase: 'idle', verb: 'Ready' },
      liveTokens: 0,
      cost: estimateSessionCost([]),
      agents: [],
      jobs: { running: 0, total: 0, failed: 0 },
    }
  }
  let usedTokens = 0
  let lastUsage: TokenUsage | undefined
  let contextWindow: number | undefined
  let model: string | undefined
  let provider: string | undefined
  let todos: TodoItem[] = []
  const jobs: JobSummary = { running: 0, total: 0, failed: 0 }
  const liveJobs = new Set<string>()

  for (const event of view.events) {
    const data = asObject(event.data) ?? {}
    const route = readModel(event, data)
    if (route.model !== undefined) model = route.model
    if (route.provider !== undefined) provider = route.provider
    if (event.type === 'request/context') {
      const window = pickNumber(data, ['contextWindow', 'context_window', 'window'])
      if (window !== undefined && window > 0) contextWindow = window
    }
    if (event.type === 'assistant/message') {
      const message = messageOf(data)
      const usage = normalizeUsage(data.usage) ?? normalizeUsage(message.usage)
      if (usage !== undefined) {
        lastUsage = usage
        usedTokens = usage.total
      }
    }
    if (event.type === 'job/registered') {
      const jobId = String(data.jobId ?? '')
      if (jobId.length > 0 && !liveJobs.has(jobId)) {
        liveJobs.add(jobId)
        jobs.total += 1
        jobs.running += 1
      }
    } else if (event.type === 'job/settled') {
      const jobId = String(data.jobId ?? '')
      if (jobId.length > 0 && liveJobs.delete(jobId)) {
        jobs.running = Math.max(0, jobs.running - 1)
        if (String(data.status ?? 'completed') !== 'completed') jobs.failed += 1
      }
    }
    const nextTodos = parseTodos(event)
    if (nextTodos !== undefined) todos = nextTodos
  }

  const estimates = estimateSegments(view.events)
  const estimatedTotal = sumSegments(estimates)
  if (usedTokens <= 0) usedTokens = estimatedTotal
  // Local estimates are text-only. When the host reports a larger measured
  // occupancy (system prompt + tool schemas are not in the transcript), keep
  // the measured total but scale the composition to match it, so the legend
  // and the bar always agree.
  let segments = estimates
  if (usedTokens > 0 && estimatedTotal > 0 && usedTokens !== estimatedTotal) {
    const ratio = usedTokens / estimatedTotal
    const scaled: ContextSegments = {
      system: Math.round(estimates.system * ratio),
      prompt: Math.round(estimates.prompt * ratio),
      assistant: Math.round(estimates.assistant * ratio),
      thinking: Math.round(estimates.thinking * ratio),
      tools: Math.round(estimates.tools * ratio),
    }
    const diff = usedTokens - sumSegments(scaled)
    scaled.assistant = Math.max(0, scaled.assistant + diff)
    segments = scaled
  }
  const timing = turnTiming(view.events)
  const outputTokens = lastUsage?.output ?? 0
  const liveTokens = estimateTokens(view.streamText)
  const activity = deriveActivity(view)
  const cost = estimateSessionCost(view.events)
  const agents = collectAgents(view.events)
  const pct = contextWindow !== undefined && contextWindow > 0
    ? Math.max(0, (usedTokens / contextWindow) * 100)
    : undefined
  const started = timing.turnStartedAt
  if (started !== undefined && started > now) timing.turnStartedAt = now
  return {
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    usedTokens,
    ...(estimatedTotal > 0 ? { segments } : {}),
    ...(lastUsage === undefined ? {} : { lastUsage }),
    outputTokens,
    ...timing,
    todos,
    activity,
    liveTokens,
    ...(pct === undefined ? {} : { contextPct: pct }),
    cost,
    agents,
    jobs,
  }
}

/**
 * Subagent roster derived from durable events only: `subagent/catalog` opens a
 * row, and a spliced `subagent-settled` inbox item closes it. A child can also
 * arrive through `subagent/start` / `subagent/end` on hosts that emit them.
 */
export function collectAgents(events: readonly SessionEvent[]): AgentInfo[] {
  const agents = new Map<string, AgentInfo>()
  const row = (agentId: string, label: string, mode: string | undefined, startedAt: number | undefined): AgentInfo => {
    const existing = agents.get(agentId)
    if (existing !== undefined) {
      if (label.length > 0) existing.label = label
      if (mode !== undefined) existing.mode = mode
      if (startedAt !== undefined) existing.startedAt = startedAt
      return existing
    }
    const created: AgentInfo = { agentId, label: label.length > 0 ? label : agentId.slice(0, 8), status: 'running' }
    if (mode !== undefined) created.mode = mode
    if (startedAt !== undefined) created.startedAt = startedAt
    agents.set(agentId, created)
    return created
  }

  for (const event of events) {
    const data = asObject(event.data) ?? {}
    if (event.type === 'subagent/catalog') {
      const childId = typeof data.childId === 'string' ? data.childId : ''
      if (childId.length === 0) continue
      row(
        childId,
        typeof data.label === 'string' ? data.label : '',
        typeof data.mode === 'string' ? data.mode : undefined,
        pickNumber(data, ['childCreatedAt']) ?? event.time,
      )
      continue
    }
    if (event.type === 'subagent/start') {
      const id = typeof data.agentId === 'string' ? data.agentId : typeof data.sessionId === 'string' ? data.sessionId : ''
      if (id.length > 0) row(id, typeof data.label === 'string' ? data.label : '', undefined, event.time)
      continue
    }
    if (event.type === 'subagent/end' || event.type === 'subagent/status') {
      const id = typeof data.agentId === 'string' ? data.agentId : typeof data.sessionId === 'string' ? data.sessionId : ''
      const target = agents.get(id)
      if (target === undefined) continue
      if (event.type === 'subagent/end') target.status = data.status === 'failed' || data.status === 'cancelled' ? 'failed' : 'done'
      else if (data.status === 'failed') target.status = 'failed'
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(data.inserted) ? (data.inserted as Json[]) : []
      for (const item of inserted) {
        const source = asObject(item.source)
        if (source?.kind !== 'subagent-settled') continue
        const id = typeof source.senderSessionId === 'string' ? source.senderSessionId : ''
        const target = agents.get(id)
        if (target === undefined) continue
        const text = Array.isArray(item.content)
          ? (item.content as Json[]).map((part) => (typeof part.text === 'string' ? part.text : '')).join(' ')
          : ''
        target.status = /failed/i.test(text) ? 'failed' : 'done'
      }
    }
  }
  return [...agents.values()].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
}

/**
 * Feed the TPS sparkline. Samples are taken at most every 700 ms; the caller
 * passes the live token estimate and its previous sample.
 */
export function nextSpeedSample(
  samples: readonly TpsSample[],
  previous: { at: number; tokens: number } | undefined,
  now: number,
  tokens: number,
  minMs = 700,
): { samples: TpsSample[]; previous: { at: number; tokens: number } } {
  if (previous === undefined || tokens < previous.tokens) {
    return { samples: [...samples], previous: { at: now, tokens } }
  }
  const elapsed = now - previous.at
  if (elapsed < minMs) return { samples: [...samples], previous }
  if (tokens <= previous.tokens) return { samples: [...samples], previous: { at: now, tokens } }
  const tps = ((tokens - previous.tokens) / elapsed) * 1000
  const next = [...samples, { at: now, tps }].slice(-24)
  return { samples: next, previous: { at: now, tokens } }
}

/** Most recent sample, or the live estimate when no sample exists yet. */
export function currentTps(samples: readonly TpsSample[], liveTokens: number, elapsedMs: number): number {
  const last = samples.at(-1)
  if (last !== undefined) return last.tps
  if (elapsedMs > 500 && liveTokens > 0) return liveTokens / (elapsedMs / 1000)
  return 0
}

export function averageTps(samples: readonly TpsSample[], windowMs = 60_000, now = Date.now()): number {
  const window = samples.filter((sample) => now - sample.at <= windowMs)
  if (window.length === 0) return 0
  return window.reduce((sum, sample) => sum + sample.tps, 0) / window.length
}

/** `13k`, `1.2M`, `842` — compact token counts for one-line footers. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) {
    const value = tokens / 1_000
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}k`
  }
  const value = tokens / 1_000_000
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}M`
}

/** `0s`, `42s`, `3m 04s`, `1h 12m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return '0%'
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`
}

/** Shared pressure thresholds: comfortable, amber ≥ 80%, red ≥ 95%. */
export function pressureStyle(pct: number | undefined): ThemeStyle | undefined {
  if (pct === undefined) return undefined
  if (pct >= 95) return 'error'
  if (pct >= 80) return 'warning'
  return undefined
}

export function todoCounts(todos: readonly TodoItem[]): {
  total: number
  completed: number
  active?: TodoItem
} {
  let completed = 0
  let active: TodoItem | undefined
  for (const todo of todos) {
    if (todo.status === 'completed') completed += 1
    else if (todo.status === 'in_progress' && active === undefined) active = todo
  }
  return { total: todos.length, completed, ...(active === undefined ? {} : { active }) }
}
