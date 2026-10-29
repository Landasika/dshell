import type { AskedQuestion, SessionEvent } from '../protocol/index.js'
import { renderDiff, renderMarkdown } from './markdown.js'
import { BRAND_ICON, BRAND_NAME } from './brand.js'
import { paint, paintBand, type Theme } from './theme.js'
import { eventTime, formatDuration } from './metrics.js'
import { displayWidth, pad, sanitizeText, truncate, wrapText } from './width.js'

type Json = Record<string, any>

export type BlockKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'todo'
  | 'turn'
  | 'turnend'
  | 'notice'
  | 'error'

export interface Block {
  kind: BlockKind
  title?: string
  body: string
  callId?: string
  toolName?: string
  failed?: boolean
  detail?: string
  /** Expanded form (full reasoning); `body` holds the folded preview. */
  full?: string
  /** Right-aligned meta line under the header, e.g. token count. */
  meta?: string
  /** How many assistant steps were folded into this block. */
  steps?: number
  /** One-line call signature for a tool block, e.g. `Bash(ls -la)`. */
  headline?: string
}

/** Local `HH:MM`, the finish time shown next to a turn's duration. */
function clockLabel(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function shortAgent(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function dataOf(event: SessionEvent): Json {
  return (event.data ?? {}) as Json
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text?: string } => {
      return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
    })
    .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('')
}

function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text?: string } => {
      return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'reasoning'
    })
    .map((part) => part.text ?? '')
    .join('\n')
}

/** The latest turn's failure message, if the transcript ends in a failed turn. */
export function turnFailureMessage(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end' || event.type === 'turn/failed') {
      const reason = (dataOf(event).reason ?? {}) as Json
      const kind = String(reason.kind ?? '')
      if (event.type === 'turn/failed' || kind === 'error' || kind === 'failed') {
        const failure = (reason.error ?? reason.failure ?? {}) as Json
        return String(failure.message ?? failure.code ?? 'the turn failed')
      }
      return undefined
    }
    // A newer turn is in flight: an older failure is history, not status.
    if (event.type === 'turn/start' || event.type === 'step/start') return undefined
  }
  return undefined
}

export function isInjectedContext(text: string): boolean {
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('Current runtime context.') ||
    text.startsWith('Time sampled while preparing') ||
    text.startsWith('The approval policy changed') ||
    text.startsWith('Session context compacted') ||
    text.startsWith('Current DSH file policy:')
  )
}

function toolArguments(raw: unknown): Json {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Json
    } catch {
      return { input: raw }
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as Json) : {}
}

/** One-line summary of a tool call, tuned for the common DSH tools. */
export function summarizeTool(name: string, rawArguments: unknown): string {
  const args = toolArguments(rawArguments)
  if (name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    const description = typeof args.description === 'string' ? args.description : ''
    return truncate(description.length > 0 ? `${description} · ${command}` : command, 180)
  }
  if (name === 'write' || name === 'read' || name === 'edit' || name === 'apply_patch') {
    const path = typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : ''
    return truncate(path, 180)
  }
  const compact = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return truncate(compact, 180)
}

/** Claude-Code-style labels for the tools dshell knows by name. */
const TOOL_LABELS: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  read_image: 'Image',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Patch',
  grep: 'Grep',
  glob: 'Glob',
  task: 'Task',
  web_fetch: 'Fetch',
  web_search: 'Search',
  todo: 'Todo',
  ask_user_question: 'Ask',
  skill: 'Skill',
  subagent: 'Agent',
}

/** The single argument that identifies a call, the way Claude Code shows it. */
function primaryArgument(name: string, args: Record<string, unknown>): string {
  const pick = (keys: readonly string[]): string => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim().length > 0) return value
    }
    return ''
  }
  switch (name) {
    case 'bash':
      return pick(['command', 'cmd'])
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
    case 'apply_patch':
      return pick(['file_path', 'path', 'file'])
    case 'grep':
    case 'glob':
      return pick(['pattern', 'query', 'glob'])
    case 'web_fetch':
      return pick(['url'])
    case 'web_search':
      return pick(['query', 'q'])
    case 'task':
    case 'skill':
      return pick(['description', 'name', 'prompt'])
    case 'ask_user_question': {
      const first = Array.isArray(args.questions) ? (args.questions[0] as { question?: unknown }) : undefined
      return typeof first?.question === 'string' ? first.question : ''
    }
    case 'todo':
      return ''
    default: {
      const first = Object.values(args).find((value) => typeof value === 'string' && value.trim().length > 0)
      return typeof first === 'string' ? first : ''
    }
  }
}

/**
 * `Bash(ls -la)` — the one-line call signature shown while a tool is folded.
 * Long commands keep their head and end in an ellipsis at render time.
 */
export function toolSignature(name: string, rawArguments: unknown): string {
  const args = toolArguments(rawArguments)
  const label = TOOL_LABELS[name] ?? `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`
  const primary = primaryArgument(name, args).replace(/\s+/g, ' ').trim()
  if (primary.length === 0) return label
  return `${label}(${truncate(primary, 300)})`
}

function toolResultText(data: Json): string {
  const message = (data.message ?? data) as Json
  const text = contentText(message.content)
  if (text.length > 0) return text
  if (typeof data.output === 'string') return data.output
  if (typeof data.result === 'string') return data.result
  return ''
}

function todoBlock(data: Json): Block {
  const todos = Array.isArray(data.todos) ? data.todos : []
  const lines = todos.map((todo: Json) => {
    const status = String(todo.status ?? 'pending')
    const mark = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
    return `${mark} ${String(todo.content ?? '')}`
  })
  return { kind: 'todo', title: 'todos', body: lines.join('\n') }
}

/**
 * Convert durable session events into display blocks. This is a pure reducer:
 * the same history always renders the same transcript, which keeps a reconnect
 * from duplicating settled output.
 */
/** One `ask_user_question` call that is still waiting for answers. */
export interface PendingAsk {
  callId: string
  questions: AskedQuestion[]
}

function askedQuestions(argumentsJson: unknown): AskedQuestion[] {
  let args: Json
  try {
    args = typeof argumentsJson === 'string' ? (JSON.parse(argumentsJson) as Json) : (argumentsJson as Json)
  } catch {
    return []
  }
  if (!Array.isArray(args.questions)) return []
  const out: AskedQuestion[] = []
  for (const raw of args.questions) {
    if (typeof raw !== 'object' || raw === null) continue
    const question = raw as Json
    if (typeof question.id !== 'string' || typeof question.question !== 'string') continue
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): { label: string; description?: string }[] => {
          if (typeof option !== 'object' || option === null) return []
          const label = (option as Json).label
          if (typeof label !== 'string' || label.length === 0) return []
          const description = (option as Json).description
          return [{ label, ...(typeof description === 'string' ? { description } : {}) }]
        })
      : undefined
    const header = question.header
    const multi = question.multi_select ?? question.multiSelect
    out.push({
      id: question.id,
      question: question.question,
      ...(typeof header === 'string' && header.length > 0 ? { header } : {}),
      ...(multi === true ? { multiSelect: true } : {}),
      ...(options !== undefined && options.length > 0 ? { options } : {}),
    })
  }
  return out
}

/**
 * The newest `ask_user_question` call that is still answerable: the call has
 * no result yet, or its timed wait settled as `{pending: true}` (the question
 * stays open for a late answer). Aborted, answered, and already-replied calls
 * are skipped.
 */
export function pendingQuestions(events: readonly SessionEvent[]): PendingAsk | undefined {
  const open = new Map<string, AskedQuestion[]>()
  let newest = ''
  for (const event of events) {
    const data = dataOf(event) as Json
    if (event.type === 'tool/call' && String(data.name ?? '') === 'ask_user_question') {
      const callId = String(data.callId ?? data.toolCallId ?? '')
      if (callId.length === 0) continue
      open.set(callId, askedQuestions(data.arguments ?? data.input))
      newest = callId
      continue
    }
    if (event.type === 'tool/result') {
      const message = (data.message ?? data) as Json
      const callId = String(message.toolCallId ?? data.callId ?? data.toolCallId ?? '')
      if (callId.length === 0 || !open.has(callId)) continue
      if (message.isError === true || data.isError === true) {
        open.delete(callId)
        continue
      }
      // A timed wait that expired keeps the question answerable.
      const text = toolResultText(data)
      let pending = false
      try {
        pending = (JSON.parse(text) as Json).pending === true
      } catch {
        pending = false
      }
      if (!pending) open.delete(callId)
      continue
    }
    if (event.type === 'user/message') {
      const source = ((data.message ?? data) as Json).source as Json | undefined
      if (source?.kind === 'user-question-reply' && typeof source.callId === 'string') {
        open.delete(source.callId)
      }
    }
  }
  if (newest.length === 0 || !open.has(newest)) return undefined
  return { callId: newest, questions: open.get(newest) ?? [] }
}

export function buildBlocks(events: readonly SessionEvent[], verbose = false): Block[] {
  const blocks: Block[] = []
  const callBlocks = new Map<string, Block>()
  const agentBlocks = new Map<string, Block>()
  const reasoningByTurn = new Map<string, Block>()
  let userTurns = 0
  // Wall-clock start of the open turn, so the footer can report how long it ran.
  let turnStartedAt: number | undefined

  for (const event of events) {
    const data = dataOf(event)
    switch (event.type) {
      case 'user/message': {
        userTurns += 1
        const message = (data.message ?? data) as Json
        const text = contentText(message.content)
        if (message.source?.kind === 'user' && text.length > 0 && !isInjectedContext(text)) {
          blocks.push({ kind: 'user', title: 'you', body: text })
        } else if (verbose && text.length > 0) {
          blocks.push({ kind: 'notice', title: 'context', body: truncate(text.replace(/\s+/g, ' '), 200) })
        }
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? data) as Json
        const text = contentText(message.content)
        const reasoning = reasoningText(message.content)
        if (reasoning.length > 0) {
          // One collapsible thinking block per turn: an agentic turn can carry
          // dozens of assistant messages, and one rail each turns the
          // transcript into a wall of reasoning.
          const key = typeof data.turn === 'number' ? `t${data.turn}` : `u${userTurns}`
          const existing = reasoningByTurn.get(key)
          if (existing === undefined) {
            const block: Block = {
              kind: 'reasoning',
              title: 'thinking',
              body: verbose ? reasoning : '',
              full: reasoning,
              steps: 1,
            }
            reasoningByTurn.set(key, block)
            blocks.push(block)
          } else {
            existing.full = `${existing.full ?? existing.body}\n\n${reasoning}`
            existing.body = verbose ? existing.full : ''
            existing.steps = (existing.steps ?? 1) + 1
          }
        }
        if (text.length > 0) blocks.push({ kind: 'assistant', body: text })
        break
      }
      case 'tool/call': {
        const name = String(data.name ?? data.toolName ?? 'tool')
        const callId = String(data.callId ?? data.toolCallId ?? `${event.seq}`)
        const block: Block = {
          kind: 'tool',
          title: name,
          toolName: name,
          callId,
          body: summarizeTool(name, data.arguments ?? data.input),
          headline: toolSignature(name, data.arguments ?? data.input),
        }
        blocks.push(block)
        callBlocks.set(callId, block)
        break
      }
      case 'tool/result': {
        const message = (data.message ?? data) as Json
        const callId = String(
          message.toolCallId ??
            message.source?.callId ??
            data.callId ??
            data.toolCallId ??
            '',
        )
        const failed = message.isError === true || data.isError === true
        const output = toolResultText(data)
        const target = callBlocks.get(callId)
        if (target !== undefined) {
          target.failed = failed
          target.detail = output
        } else {
          blocks.push({
            kind: 'tool',
            title: 'tool result',
            callId,
            body: output,
            failed,
          })
        }
        break
      }
      case 'todo/write':
      case 'todo/update': {
        blocks.push(todoBlock(data))
        break
      }
      case 'subagent/catalog': {
        const childId = String(data.childId ?? '')
        const label = typeof data.label === 'string' && data.label.length > 0 ? data.label : childId
        blocks.push({
          kind: 'notice',
          title: '⇢ agent started',
          body: `${label} · ${shortAgent(childId)}`,
          callId: childId,
        })
        agentBlocks.set(childId, blocks[blocks.length - 1]!)
        break
      }
      case 'agent/inbox/spliced': {
        // Settlement notices arrive as spliced inbox items, not as subagent/*.
        const inserted = Array.isArray(data.inserted) ? (data.inserted as Json[]) : []
        for (const item of inserted) {
          const source = (item.source ?? {}) as Json
          if (source.kind !== 'subagent-settled') continue
          const childId = String(source.senderSessionId ?? '')
          const target = agentBlocks.get(childId)
          const text = contentText(item.content)
          const failed = /failed/i.test(text)
          if (target !== undefined) {
            target.title = failed ? '✗ agent failed' : '✓ agent finished'
            target.failed = failed
          }
        }
        break
      }
      case 'subagent/descriptor': {
        // The child session's own header descriptor: no row for the parent.
        if (verbose) blocks.push({ kind: 'notice', title: 'agent descriptor', body: truncate(JSON.stringify(data), 200) })
        break
      }
      case 'subagent/start':
      case 'subagent/end':
      case 'subagent/status': {
        const id = String(data.agentId ?? data.sessionId ?? data.id ?? '')
        const target = agentBlocks.get(id)
        const settled = event.type === 'subagent/end'
        const failed = data.status === 'failed' || data.status === 'cancelled'
        if (target !== undefined) {
          target.title = `${failed ? '✗' : settled ? '✓' : '⇢'} agent ${failed ? 'failed' : settled ? 'finished' : 'running'}`
          target.failed = failed
        } else if (verbose) {
          blocks.push({ kind: 'notice', title: `subagent ${event.type.split('/')[1] ?? 'event'}`, body: id })
        }
        break
      }
      case 'approval/asked': {
        if (verbose) {
          blocks.push({
            kind: 'notice',
            title: 'approval',
            body: `${String(data.toolName ?? 'tool')}${data.reason ? ` · ${String(data.reason)}` : ''}`,
          })
        }
        break
      }
      case 'approval/decided': {
        if (verbose) {
          blocks.push({ kind: 'notice', title: 'approval', body: String(data.outcome ?? 'decided') })
        }
        break
      }
      case 'turn/start': {
        turnStartedAt = eventTime(event)
        break
      }
      case 'turn/end':
      case 'turn/failed': {
        const reason = (data.reason ?? {}) as Json
        const kind = String(reason.kind ?? '')
        const failed = kind === 'error' || kind === 'failed' || event.type === 'turn/failed'
        if (failed) {
          // A failed turn otherwise leaves the transcript silent: the user
          // sees the prompt and then nothing. Always surface the reason.
          const failure = (reason.error ?? reason.failure ?? {}) as Json
          const message = String(failure.message ?? failure.code ?? 'the Host ended the turn with an error')
          blocks.push({ kind: 'error', title: 'turn failed', body: truncate(message, 400) })
        }
        const endedAt = eventTime(event)
        if (turnStartedAt !== undefined && endedAt !== undefined && endedAt >= turnStartedAt) {
          const verb = failed ? 'Failed after' : kind === 'cancelled' ? 'Stopped after' : 'Worked for'
          const title = `${verb} ${formatDuration(endedAt - turnStartedAt)} · done ${clockLabel(endedAt)}`
          blocks.push({ kind: 'turnend', title, body: '' })
        }
        turnStartedAt = undefined
        break
      }
      case 'system/message': {
        if (verbose) {
          const text = contentText((data.message ?? data).content)
          if (text.length > 0) blocks.push({ kind: 'notice', title: 'system', body: truncate(text, 300) })
        }
        break
      }
      case 'error': {
        blocks.push({ kind: 'error', title: 'error', body: String(data.message ?? data.error ?? 'unknown error') })
        break
      }
      default:
        if (verbose) {
          blocks.push({ kind: 'notice', title: event.type, body: truncate(JSON.stringify(data), 240) })
        }
    }
  }

  // A spawn call and its catalog row describe the same event; when the roster
  // exists, the agent card replaces the generic tool card.
  if (agentBlocks.size > 0) {
    return blocks.filter((block) => !(block.kind === 'tool' && block.toolName === 'subagent'))
  }
  return blocks
}

export interface RenderOptions {
  maxToolLines?: number
  maxToolChars?: number
  /** Show each tool call's argument summary and output inline (Ctrl-O). */
  expandTools?: boolean
  /** Width a user-message band should span (defaults to the wrap width). */
  surfaceWidth?: number
}

function renderBody(
  block: Block,
  width: number,
  theme: Theme,
  options: RenderOptions,
): string[] {
  const maxToolLines = options.maxToolLines ?? 12
  const maxToolChars = options.maxToolChars ?? 1600
  const isTool = block.kind === 'tool'
  const raw = sanitizeText(block.kind === 'user' || block.kind === 'assistant' ? block.body : block.body)
  const limited = isTool && raw.length > maxToolChars
    ? `${raw.slice(0, maxToolChars)}\n… output truncated (${raw.length - maxToolChars} chars)`
    : raw
  const lines = block.kind === 'user' || block.kind === 'assistant'
    ? renderMarkdown(limited, width, theme)
    : /^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m.test(limited)
      ? renderDiff(limited, width, theme)
      : wrapText(limited, width)
  if (!isTool || lines.length <= maxToolLines) return lines
  return [...lines.slice(0, maxToolLines), paint(theme, 'dim', `… +${lines.length - maxToolLines} lines`)]
}

/** Render display blocks to lines with labels, gutters and colors. */
/** One rendered block and the transcript rows it occupies. */
export interface BlockRange {
  block: Block
  /** First row (inclusive). */
  start: number
  /** Last row (exclusive). */
  end: number
}

export interface RenderedBlocks {
  lines: string[]
  ranges: BlockRange[]
}

export function renderBlocks(
  blocks: readonly Block[],
  width: number,
  theme: Theme,
  options: RenderOptions = {},
): string[] {
  return renderBlocksWithRanges(blocks, width, theme, options).lines
}

/**
 * Render blocks and report where each one landed, so the UI can move a
 * selection from block to block without re-measuring the transcript.
 */
export function renderBlocksWithRanges(
  blocks: readonly Block[],
  width: number,
  theme: Theme,
  options: RenderOptions = {},
): RenderedBlocks {
  const out: string[] = []
  const ranges: BlockRange[] = []
  const separatorWidth = Math.max(4, Math.min(width, 24))
  let assistantLabelShown = false
  for (const block of blocks) {
    if (block.kind === 'user') assistantLabelShown = false
    if (out.length > 0) out.push('')
    const start = out.length
    switch (block.kind) {
      case 'user': {
        // Quote-style prompt on a light-grey bubble: `> hello`, continuation
        // lines aligned under the marker and the band spanning the transcript.
        const bandWidth = Math.max(width, options.surfaceWidth ?? width)
        const body = renderBody(block, Math.max(8, width - 4), theme, options)
        body.forEach((line, index) => {
          const row = pad(`${index === 0 ? '> ' : '  '}${line}`, bandWidth)
          out.push(paintBand(theme, theme.bgUser, theme.userText, row))
        })
        break
      }
      case 'assistant': {
        // One attribution per turn: only the first assistant block after a user
        // prompt carries the `dshell` header, later steps stay label-free.
        if (!assistantLabelShown) {
          out.push(`${paint(theme, 'accent', BRAND_ICON)} ${paint(theme, 'bold', paint(theme, 'accentSoft', BRAND_NAME))}`)
          assistantLabelShown = true
        }
        out.push(...renderBody(block, width, theme, options))
        break
      }
      case 'reasoning': {
        // Folded to one header per turn. Ctrl-O rebuilds the blocks with the
        // full text in `body`, so the rail only appears when expanded.
        const full = block.full ?? block.body
        const head = `${paint(theme, 'info', '⚓')} ${paint(theme, 'dim', block.title ?? 'thinking')}`
        const tokens = Math.max(1, Math.round(full.length / 4))
        const steps = block.steps ?? 1
        const parts = [`${tokens} tok`]
        if (steps > 1) parts.push(`${steps} steps`)
        parts.push(block.body.length > 0 ? 'ctrl+o fold' : 'ctrl+o expand')
        out.push(`${head} ${paint(theme, 'dim', `· ${parts.join(' · ')}`)}`)
        if (block.body.length > 0) {
          for (const line of block.body.split('\n')) {
            for (const wrapped of wrapText(line, Math.max(1, width - 2))) {
              out.push(paint(theme, 'dim', `│ ${wrapped}`))
            }
          }
        }
        break
      }
      case 'tool': {
        // Folded to one line like Claude Code: the call and its arguments, with
        // the output left for Ctrl-O or the Enter detail panel. A failure keeps
        // a short excerpt so the reason is visible without expanding.
        const failed = block.failed === true
        const marker = failed ? '✗' : block.detail === undefined ? '▸' : '✓'
        const color = failed ? 'red' : block.detail === undefined ? 'yellow' : 'green'
        const label =
          block.headline ?? `${block.title ?? block.toolName ?? 'tool'}${block.body.length > 0 ? ` · ${block.body}` : ''}`
        out.push(truncate(`${paint(theme, color, `${marker} ${label}`)}`, width))
        if (options.expandTools === true) {
          if (block.body.length > 0) {
            for (const line of wrapText(block.body, Math.max(1, width - 2))) {
              out.push(paint(theme, 'dim', `  ${line}`))
            }
          }
          if (block.detail !== undefined && block.detail.length > 0) {
            for (const line of renderBody({ ...block, body: block.detail }, width, theme, options)) {
              out.push(line)
            }
          }
        } else if (failed && block.detail !== undefined && block.detail.length > 0) {
          for (const line of block.detail.split('\n').slice(0, 2)) {
            out.push(paint(theme, 'red', truncate(`  ${line}`, width)))
          }
        }
        break
      }
      case 'todo': {
        out.push(paint(theme, 'bold', `☐ ${block.title ?? 'todos'}`))
        for (const line of wrapText(block.body, Math.max(1, width - 2))) {
          out.push(`  ${line}`)
        }
        break
      }
      case 'notice': {
        const title = block.title ?? ''
        if (title.startsWith('⇢') || title.startsWith('✓') || title.startsWith('✗')) {
          const style = block.failed === true || title.startsWith('✗') ? 'red' : title.startsWith('✓') ? 'green' : 'magenta'
          out.push(`${paint(theme, style, title)} ${paint(theme, 'dim', block.body)}`)
        } else {
          out.push(paint(theme, 'dim', `· ${title}${block.body.length > 0 ? ` ${block.body}` : ''}`))
        }
        break
      }
      case 'error': {
        out.push(paint(theme, 'red', `! ${block.title ?? 'error'}: ${block.body}`))
        break
      }
      case 'turn': {
        out.push(paint(theme, 'dim', paint(theme, 'gray', '─'.repeat(separatorWidth))))
        if (block.title !== undefined) out.push(paint(theme, 'dim', block.title))
        break
      }
      case 'turnend': {
        out.push(`${paint(theme, 'accentSoft', '✻')} ${paint(theme, 'dim', block.title ?? '')}`)
        break
      }
    }
    ranges.push({ block, start, end: out.length })
  }
  return { lines: out, ranges }
}

/** Build and render in one call; useful for tests and one-shot output. */
export function renderTranscript(
  events: readonly SessionEvent[],
  width: number,
  theme: Theme,
  verbose = false,
  options: RenderOptions = {},
): string[] {
  return renderBlocks(buildBlocks(events, verbose), width, theme, options)
}

export function blockHeight(lines: readonly string[], width: number): number {
  return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, width))), 0)
}
