/** Pure slash-command and @file completion for the TUI composer. */

export interface CommandSpec {
  name: string
  description: string
  /** Enter inserts a trailing space instead of executing immediately. */
  needsArgument?: boolean
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: '/help', description: 'show keys and commands' },
  { name: '/sessions', description: 'switch session' },
  { name: '/workspaces', description: 'switch workspace' },
  { name: '/new', description: 'create a session' },
  { name: '/attach', description: 'attach by id', needsArgument: true },
  { name: '/cancel', description: 'cancel the running turn' },
  { name: '/clear', description: 'clear the local transcript view' },
  { name: '/reconnect', description: 'reattach the current session' },
  { name: '/rewind', description: 'restore a previous prompt into the composer' },
  { name: '/history', description: 'search prompts sent in this session' },
  { name: '/panel', description: 'session panel: context, spend, speed, todos' },
  { name: '/agents', description: 'list subagents and open their transcripts' },
  { name: '/status', description: 'alias for /panel' },
  { name: '/verbose', description: 'toggle reasoning and lifecycle events' },
  { name: '/quit', description: 'leave the TUI (does not cancel the Host turn)' },
]

export type CompletionKind = 'command' | 'file'

export interface CompletionContext {
  kind: CompletionKind
  /** Text after the trigger, used for filtering. */
  query: string
  /** Replacement range in the composer. */
  start: number
  end: number
}

export interface CompletionItem {
  kind: CompletionKind
  label: string
  description: string
  insert: string
  execute?: string
}

export interface CompletionState {
  context: CompletionContext
  items: CompletionItem[]
  index: number
}

/**
 * Find the completion context at the caret. Only one line is considered:
 * command names cannot contain whitespace, and `@` references end at the next
 * whitespace.
 */
export function completionContext(text: string): CompletionContext | null {
  if (text.includes('\n')) return null
  if (text.startsWith('/')) {
    if (/\s/.test(text)) return null
    return { kind: 'command', query: text.slice(1), start: 0, end: text.length }
  }
  const at = text.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(text[at - 1] ?? '')) return null
  const query = text.slice(at + 1)
  if (/\s/.test(query)) return null
  return { kind: 'file', query, start: at, end: text.length }
}

export function commandItems(query: string): CompletionItem[] {
  const normalized = query.toLowerCase()
  return COMMAND_SPECS
    .filter((command) => command.name.slice(1).toLowerCase().startsWith(normalized))
    .map((command) => ({
      kind: 'command' as const,
      label: command.name,
      description: command.description,
      insert: command.needsArgument === true ? `${command.name} ` : command.name,
      ...(command.needsArgument === true ? {} : { execute: command.name }),
    }))
}

export function fileItems(query: string, candidates: readonly string[]): CompletionItem[] {
  return candidates
    .filter((candidate) => candidate.startsWith(query))
    .map((candidate) => ({
      kind: 'file' as const,
      label: `@${candidate}`,
      description: 'insert file reference',
      insert: `@${candidate} `,
    }))
}

/** Build the menu for the current composer text and cwd file candidates. */
export function completionFor(
  text: string,
  files: readonly string[],
): CompletionState | null {
  const context = completionContext(text)
  if (context === null) return null
  const items = context.kind === 'command'
    ? commandItems(context.query)
    : fileItems(context.query, files)
  return { context, items, index: 0 }
}
