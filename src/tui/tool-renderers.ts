import { truncate } from './width.js'

export type ToolArguments = Record<string, unknown>

export interface ToolRenderContext {
  name: string
  rawArguments: unknown
  arguments: ToolArguments
}

/** A tool can customize its folded label, summary, and identifying argument. */
export interface ToolRenderer {
  label: string | ((context: ToolRenderContext) => string)
  summary?: (context: ToolRenderContext) => string
  primary?: (context: ToolRenderContext) => string
}

function parseArguments(raw: unknown): ToolArguments {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed as ToolArguments : { input: raw }
    } catch {
      return { input: raw }
    }
  }
  return typeof raw === 'object' && raw !== null ? raw as ToolArguments : {}
}

function pick(arguments_: ToolArguments, keys: readonly string[]): string {
  for (const key of keys) {
    const value = arguments_[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

function genericSummary(context: ToolRenderContext): string {
  return truncate(Object.entries(context.arguments)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' '), 180)
}

function askRows(arguments_: ToolArguments): { question: string; options: string[] }[] {
  if (!Array.isArray(arguments_.questions)) return []
  return arguments_.questions.flatMap((raw): { question: string; options: string[] }[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const question = raw as ToolArguments
    if (typeof question.question !== 'string' || question.question.length === 0) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): string[] => {
          if (typeof option !== 'object' || option === null) return []
          const label = (option as ToolArguments).label
          return typeof label === 'string' && label.length > 0 ? [label] : []
        })
      : []
    return [{ question: question.question, options }]
  })
}

const pathPrimary = (context: ToolRenderContext): string => pick(context.arguments, ['file_path', 'path', 'file'])
const patternPrimary = (context: ToolRenderContext): string => pick(context.arguments, ['pattern', 'query', 'glob'])

const renderers = new Map<string, ToolRenderer>(Object.entries({
  bash: {
    label: 'Bash',
    primary: (context: ToolRenderContext) => pick(context.arguments, ['command', 'cmd']),
    summary: (context: ToolRenderContext) => {
      const command = pick(context.arguments, ['command', 'cmd'])
      const description = pick(context.arguments, ['description'])
      return truncate(description.length > 0 ? `${description} · ${command}` : command, 180)
    },
  },
  read: { label: 'Read', primary: pathPrimary, summary: pathPrimary },
  read_image: { label: 'Image', primary: pathPrimary, summary: pathPrimary },
  write: { label: 'Write', primary: pathPrimary, summary: pathPrimary },
  edit: { label: 'Edit', primary: pathPrimary, summary: pathPrimary },
  apply_patch: { label: 'Patch', primary: pathPrimary, summary: pathPrimary },
  grep: { label: 'Grep', primary: patternPrimary },
  glob: { label: 'Glob', primary: patternPrimary },
  task: { label: 'Task', primary: (context: ToolRenderContext) => pick(context.arguments, ['description', 'name', 'prompt']) },
  web_fetch: { label: 'Fetch', primary: (context: ToolRenderContext) => pick(context.arguments, ['url']) },
  web_search: { label: 'Search', primary: (context: ToolRenderContext) => pick(context.arguments, ['query', 'q']) },
  todo: { label: 'Todo', primary: () => '' },
  ask_user_question: {
    label: 'Ask',
    primary: (context: ToolRenderContext) => askRows(context.arguments)[0]?.question ?? '',
    summary: (context: ToolRenderContext) => {
      const questions = askRows(context.arguments)
      const first = questions[0]
      if (first === undefined) return ''
      const options = first.options.join(' / ')
      const more = questions.length > 1 ? ` (+${String(questions.length - 1)} more)` : ''
      return truncate(options.length > 0 ? `${first.question} · ${options}${more}` : `${first.question}${more}`, 180)
    },
  },
  skill: { label: 'Skill', primary: (context: ToolRenderContext) => pick(context.arguments, ['description', 'name', 'prompt']) },
  subagent: { label: 'Agent', primary: (context: ToolRenderContext) => pick(context.arguments, ['description', 'name', 'prompt']) },
} satisfies Record<string, ToolRenderer>))

/** Register a frontend renderer without changing the transcript reducer. */
export function registerToolRenderer(name: string, renderer: ToolRenderer): () => void {
  const previous = renderers.get(name)
  renderers.set(name, renderer)
  return () => {
    if (previous === undefined) renderers.delete(name)
    else renderers.set(name, previous)
  }
}

export function toolDisplayLabel(name: string): string {
  const renderer = renderers.get(name)
  if (renderer === undefined) return name
  if (typeof renderer.label === 'string') return renderer.label
  return renderer.label({ name, rawArguments: undefined, arguments: {} })
}

export function renderToolCall(name: string, rawArguments: unknown): { label: string; summary: string; signature: string } {
  const context: ToolRenderContext = { name, rawArguments, arguments: parseArguments(rawArguments) }
  const renderer = renderers.get(name)
  const label = renderer === undefined
    ? `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`
    : typeof renderer.label === 'string' ? renderer.label : renderer.label(context)
  const summary = truncate(renderer?.summary?.(context) ?? genericSummary(context), 180)
  const fallbackPrimary = Object.values(context.arguments).find(value => typeof value === 'string' && value.trim().length > 0)
  const primary = (renderer?.primary?.(context) ?? (typeof fallbackPrimary === 'string' ? fallbackPrimary : '')).trim()
  return { label, summary, signature: primary.length === 0 ? label : `${label}(${primary})` }
}
