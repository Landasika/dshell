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
  { name: '/skills', description: 'browse skills from the Host skill hub', needsArgument: false },
  { name: '/status', description: 'alias for /panel' },
  { name: '/verbose', description: 'toggle reasoning and lifecycle events' },
  { name: '/model', description: 'switch provider/model and reasoning level' },
  { name: '/provider', description: 'edit provider rows in cordis.patch.yml' },
  { name: '/harness', description: 'agent presets: prompts and tools a session composes' },
  { name: '/resume', description: 'alias for /sessions' },
  { name: '/quit', description: 'leave the TUI (does not cancel the Host turn)' },
]

export type CompletionKind = 'command' | 'file' | 'skill'

/** The slice of a skill the `$` menu needs. */
export interface SkillCandidate {
  name: string
  description: string
  userInvocable: boolean
}

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
  // `$` is the skill shortcut: it expands to the `/name` gesture the Host
  // already parses, so the composer never invents a second invocation syntax.
  if (text.startsWith('$')) {
    if (/\s/.test(text)) return null
    return { kind: 'skill', query: text.slice(1), start: 0, end: text.length }
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

/** Skills the user may invoke by name, filtered by the `$` query. */
export function skillItems(query: string, skills: readonly SkillCandidate[]): CompletionItem[] {
  const normalized = query.toLowerCase()
  return skills
    .filter((skill) => skill.userInvocable && skill.name.toLowerCase().startsWith(normalized))
    .map((skill) => ({
      kind: 'skill' as const,
      label: `$${skill.name}`,
      description: skill.description,
      insert: `/${skill.name} `,
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

/** Build the menu for the current composer text and its candidate sources. */
export function completionFor(
  text: string,
  files: readonly string[],
  skills: readonly SkillCandidate[] = [],
): CompletionState | null {
  const context = completionContext(text)
  if (context === null) return null
  const items = context.kind === 'command'
    ? commandItems(context.query)
    : context.kind === 'skill'
      ? skillItems(context.query, skills)
      : fileItems(context.query, files)
  return { context, items, index: 0 }
}
