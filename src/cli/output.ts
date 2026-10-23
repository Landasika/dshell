import type { AttachedMessage, SessionEvent, SessionSummary, WorkspaceSummary } from '../protocol/index.js'

type JsonObject = Record<string, any>

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text?: string } => {
      return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
    })
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

function eventData(event: SessionEvent): JsonObject {
  return (event.data ?? {}) as JsonObject
}

function userText(data: JsonObject): { text: string; sourceKind: string } {
  const message = (data.message ?? data) as JsonObject
  return {
    text: textOfContent(message.content),
    sourceKind: String(message.source?.kind ?? ''),
  }
}

function isInjectedContext(text: string): boolean {
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('Current runtime context.') ||
    text.startsWith('Time sampled while preparing') ||
    text.startsWith('The approval policy changed') ||
    text.startsWith('Session context compacted')
  )
}

/** Print one durable session event in a terminal-friendly form. */
export function printEvent(event: SessionEvent, verbose = false): void {
  const data = eventData(event)

  switch (event.type) {
    case 'user/message': {
      const { text, sourceKind } = userText(data)
      if (sourceKind === 'user' && text.length > 0 && !isInjectedContext(text)) {
        console.log(`\n[user] ${text}`)
      } else if (verbose && text.length > 0) {
        console.log(`\n[context] ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      return
    }
    case 'assistant/message': {
      const message = (data.message ?? data) as JsonObject
      const text = textOfContent(message.content)
      if (text.length > 0) console.log(`\n[assistant] ${text}`)
      return
    }
    case 'tool/call': {
      const name = String(data.name ?? data.toolName ?? 'tool')
      const args = data.arguments ?? data.input ?? {}
      console.log(`\n[tool] ${name} ${JSON.stringify(args)}`)
      return
    }
    case 'tool/result': {
      const failed = data.isError === true
      console.log(`[tool-result] ${failed ? 'error' : 'ok'}`)
      return
    }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : []
      console.log('\n[todos]')
      for (const todo of todos as Array<{ content?: unknown; status?: unknown }>) {
        const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '
        console.log(`  [${mark}] ${String(todo.content ?? '')}`)
      }
      return
    }
    case 'approval/asked': {
      console.log(`\n[approval] ${String(data.toolName ?? 'tool')}${data.reason ? `: ${String(data.reason)}` : ''}`)
      return
    }
    case 'approval/decided': {
      console.log(`[approval-result] ${String(data.outcome ?? 'unknown')}`)
      return
    }
    case 'turn/end': {
      const reason = (data.reason ?? {}) as JsonObject
      if (reason.kind === 'completed') console.log('\n[turn] completed')
      else console.log(`\n[turn] ${String(reason.kind ?? 'ended')}${reason.error ? `: ${String(reason.error.message ?? reason.error)}` : ''}`)
      return
    }
    case 'turn/failed': {
      console.log(`\n[turn] failed: ${String(data.error?.message ?? data.error ?? 'unknown error')}`)
      return
    }
    default:
      if (verbose) console.log(`[event] ${event.type} seq=${event.seq}`)
  }
}

export function isTurnEnd(event: SessionEvent): boolean {
  return event.type === 'turn/end' || event.type === 'turn/failed'
}

export function turnFailed(event: SessionEvent): boolean {
  if (event.type === 'turn/failed') return true
  if (event.type !== 'turn/end') return false
  const reason = (eventData(event).reason ?? {}) as JsonObject
  return reason.kind !== 'completed'
}

export function printSessions(sessions: SessionSummary[]): void {
  if (sessions.length === 0) {
    console.log('No sessions. Create one in the dsh Web UI, then run `dshell list` again.')
    return
  }
  for (const session of sessions) {
    const live = session.live === true ? 'live' : 'cold'
    console.log(`${session.sessionId}  ${live.padEnd(4)}  ${session.cwd ?? ''}`)
  }
}

export function printWorkspaces(workspaces: WorkspaceSummary[]): void {
  if (workspaces.length === 0) {
    console.log('No workspaces. Create one with a session in the dsh Web UI, or run `dshell new <cwd>`.')
    return
  }
  for (const workspace of workspaces) {
    const count = workspace.sessionIds?.length ?? 0
    console.log(`${workspace.id}  ${String(count).padStart(2)} sessions  ${workspace.title}  ${workspace.path}`)
  }
}

export function printAttached(attached: AttachedMessage, verbose = false): void {
  console.log(
    `\n[attached] ${attached.sessionId} cursor=${attached.cursor} history=${attached.events.length}`,
  )
  for (const event of attached.events) printEvent(event, verbose)
}
