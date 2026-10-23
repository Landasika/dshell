import type { SessionEvent } from '../protocol/index.js'
import { renderDiff, renderMarkdown } from './markdown.js'
import { paint, type Theme } from './theme.js'
import { displayWidth, sanitizeText, truncate, wrapText } from './width.js'

type Json = Record<string, any>

export type BlockKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'todo'
  | 'turn'
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

function isInjectedContext(text: string): boolean {
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
export function buildBlocks(events: readonly SessionEvent[], verbose = false): Block[] {
  const blocks: Block[] = []
  const callBlocks = new Map<string, Block>()

  for (const event of events) {
    const data = dataOf(event)
    switch (event.type) {
      case 'user/message': {
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
          blocks.push({
            kind: 'reasoning',
            title: 'thinking',
            body: verbose ? reasoning : truncate(reasoning.replace(/\s+/g, ' '), 160),
          })
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
      case 'subagent/start':
      case 'subagent/end':
      case 'subagent/status': {
        const label = event.type === 'subagent/start' ? 'subagent started' : event.type === 'subagent/end' ? 'subagent finished' : 'subagent'
        const id = data.agentId ?? data.sessionId ?? data.id
        blocks.push({
          kind: 'notice',
          title: label,
          body: id === undefined ? truncate(JSON.stringify(data), 200) : String(id),
        })
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
      case 'turn/end':
      case 'turn/failed': {
        if (verbose) {
          const reason = (data.reason ?? {}) as Json
          const label = reason.kind === 'completed' ? 'turn completed' : `turn ${String(reason.kind ?? 'ended')}`
          blocks.push({ kind: 'turn', title: label, body: '' })
        }
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

  return blocks
}

export interface RenderOptions {
  maxToolLines?: number
  maxToolChars?: number
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
export function renderBlocks(
  blocks: readonly Block[],
  width: number,
  theme: Theme,
  options: RenderOptions = {},
): string[] {
  const out: string[] = []
  const separatorWidth = Math.max(4, Math.min(width, 24))
  for (const block of blocks) {
    if (out.length > 0) out.push('')
    switch (block.kind) {
      case 'user': {
        out.push(paint(theme, 'bold', paint(theme, 'cyan', 'you')))
        out.push(...renderBody(block, width, theme, options))
        break
      }
      case 'assistant': {
        out.push(paint(theme, 'bold', paint(theme, 'green', 'dshell')))
        out.push(...renderBody(block, width, theme, options))
        break
      }
      case 'reasoning': {
        const label = paint(theme, 'dim', `✻ ${block.title ?? 'thinking'}`)
        out.push(label)
        for (const line of wrapText(block.body, Math.max(1, width - 2))) {
          out.push(paint(theme, 'dim', `  ${line}`))
        }
        break
      }
      case 'tool': {
        const failed = block.failed === true
        const marker = failed ? '✗' : block.detail === undefined ? '▸' : '✓'
        const color = failed ? 'red' : block.detail === undefined ? 'yellow' : 'green'
        out.push(paint(theme, color, `${marker} ${block.title ?? block.toolName ?? 'tool'}`))
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
        out.push(paint(theme, 'dim', `· ${block.title ?? ''}${block.body.length > 0 ? ` ${block.body}` : ''}`))
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
    }
  }
  return out
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
