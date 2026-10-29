/**
 * Skill hub for `dshell`.
 *
 * DSH already has a skill registry (`ctx.skills`) fed by providers such as
 * `@deepseek-ai/dsh-skill-filesystem`. That provider scans fixed roots
 * (`<project>/.dsh/skills`, `$DSH_HOME/skills`, ...) which are convenient for
 * per-project skills but awkward when you want one shelf of reusable skills
 * shared by every project and every profile.
 *
 * The hub is that shelf: a configurable list of directories, scanned on demand,
 * registered as a normal skill provider so the skills appear everywhere DSH
 * looks — the Web UI, the `skill` tool and `dshell`'s `/skills` browser.
 *
 * Layout, per root:
 *
 *   <root>/<name>/SKILL.md     directory bundle (resources may live beside it)
 *   <root>/<name>.md           flat skill
 *
 * `SKILL.md` needs YAML frontmatter with `name` and `description`; `whenToUse`,
 * `user-invocable` and `disable-model-invocation` are honoured the same way the
 * filesystem provider honours them.
 */
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { SkillEntry } from '../protocol/index.js'

/** Wins over user roots (400/500) but never over project roots (100/200). */
const HUB_RANK = 350
export const HUB_PROVIDER = 'dshell-hub'
const HUB_SOURCE = 'dshell-hub'
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface SkillSummaryLike {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  path?: string
  invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
}

export interface SkillDefinitionLike extends SkillSummaryLike {
  content: string
}

export interface SkillProviderControlLike {
  invalidate(): void
}

export interface SkillCandidateLike {
  name: string
  locator: unknown
}

export interface SkillsRegistryLike {
  list(options?: { cwd?: string; scope?: object }): Promise<readonly SkillSummaryLike[]>
  get(name: string, options?: { cwd?: string; scope?: object }): Promise<SkillDefinitionLike | undefined>
  registerProvider?(
    create: (control: SkillProviderControlLike) => {
      name: string
      list(options: { cwd?: string }): Promise<readonly unknown[]>
      get(candidate: any, options: { cwd?: string }): Promise<unknown>
    },
  ): () => void
}

export interface HubSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
  path: string
  modelInvocable: boolean
  userInvocable: boolean
}

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const data: Record<string, string> = {}
  let index = 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '---') {
      index += 1
      break
    }
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]!
    let value = match[2]!.trim()
    // YAML block scalars: gather the indented lines that follow.
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value.startsWith('>')
      const collected: string[] = []
      while (index + 1 < lines.length && (lines[index + 1]!.startsWith(' ') || lines[index + 1]!.trim() === '')) {
        index += 1
        collected.push(lines[index]!.trim())
      }
      value = (folded ? collected.join(' ') : collected.join('\n')).trim()
    } else {
      value = unquote(value)
    }
    data[key] = value
  }
  return { data, body: lines.slice(index).join('\n').trim() }
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function boolField(data: Record<string, string>, key: string): boolean | undefined {
  const raw = data[key]
  if (raw === undefined) return undefined
  return raw !== 'false' && raw !== 'no' && raw !== '0'
}

/** Read one skill file; returns undefined when the bundle is invalid. */
export function readSkillFile(path: string): HubSkill | undefined {
  let text: string
  try {
    if (statSync(path).size > 512 * 1024) return undefined
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseFrontmatter(text)
  if (parsed === undefined) return undefined
  const name = (parsed.data.name ?? (basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md'))).trim()
  const description = (parsed.data.description ?? '').trim()
  if (!SKILL_NAME.test(name) || description.length === 0) return undefined
  const whenToUse = (parsed.data.whenToUse ?? parsed.data['when-to-use'] ?? '').trim()
  return {
    name,
    description,
    ...(whenToUse.length > 0 ? { whenToUse } : {}),
    content: parsed.body,
    path,
    modelInvocable: boolField(parsed.data, 'disable-model-invocation') !== true,
    userInvocable: boolField(parsed.data, 'user-invocable') !== false,
  }
}

/** Scan every hub root; the first root wins a duplicate name. */
export function scanSkillDirs(dirs: readonly string[]): HubSkill[] {
  const found = new Map<string, HubSkill>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue
      const path = join(dir, entry)
      let candidate: string | undefined
      try {
        candidate = statSync(path).isDirectory() ? join(path, 'SKILL.md') : entry.endsWith('.md') ? path : undefined
      } catch {
        continue
      }
      if (candidate === undefined || !existsSync(candidate)) continue
      const skill = readSkillFile(candidate)
      if (skill === undefined || found.has(skill.name)) continue
      found.set(skill.name, skill)
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** The `ctx.skills` provider the hub registers. */
export function createHubProvider(dirs: readonly string[]): {
  name: string
  list(options: { cwd?: string }): Promise<readonly unknown[]>
  get(candidate: any, options: { cwd?: string }): Promise<unknown>
} {
  return {
    name: HUB_PROVIDER,
    async list() {
      return scanSkillDirs(dirs).map((skill) => candidateOf(skill))
    },
    async get(candidate: any) {
      const path = (candidate as SkillCandidateLike | undefined)?.locator
      if (typeof path !== 'string') return undefined
      const skill = readSkillFile(path)
      if (skill === undefined) return undefined
      return {
        ...summaryOf(skill),
        content: skill.content,
      }
    },
  }
}

function summaryOf(skill: HubSkill): SkillSummaryLike & { invocation: { modelInvocable: boolean; userInvocable: boolean } } {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    source: HUB_SOURCE,
    provider: HUB_PROVIDER,
    path: skill.path,
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
  }
}

function candidateOf(skill: HubSkill): unknown {
  return { ...summaryOf(skill), rank: HUB_RANK, locator: skill.path }
}

/**
 * Re-run discovery when a hub root changes. `fs.watch` with `recursive` is
 * supported on Linux and macOS; failures are swallowed, leaving the catalog
 * to refresh on the next Host restart.
 */
export function watchSkillDirs(dirs: readonly string[], onChange: () => void): FSWatcher[] {
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const watcher = watch(dir, { recursive: true }, () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(onChange, 300)
      })
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {
      // Recursive watching is unavailable here; the catalog stays as-is.
    }
  }
  return watchers
}

/** Resolve the configured hub roots: plugin config, then env, then defaults. */
export function resolveHubDirs(input: {
  configured?: string | readonly string[]
  env?: string | undefined
  dshHome: string
  delimiter?: string
}): string[] {
  const split = (value: string): string[] => value.split(input.delimiter ?? ':').map((item) => item.trim()).filter((item) => item.length > 0)
  const configured = input.configured
  if (typeof configured === 'string') {
    const dirs = split(configured)
    if (dirs.length > 0) return dirs
  } else if (Array.isArray(configured)) {
    const dirs = configured.map((item) => item.trim()).filter((item) => item.length > 0)
    if (dirs.length > 0) return dirs
  }
  if (input.env !== undefined && input.env.trim().length > 0) {
    const dirs = split(input.env)
    if (dirs.length > 0) return dirs
  }
  return [join(input.dshHome, 'dshell-skills')]
}

/** Map the registry's summaries onto the wire shape. */
export function toSkillEntry(summary: SkillSummaryLike): SkillEntry {
  return {
    name: summary.name,
    description: summary.description,
    ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
    source: summary.source,
    provider: summary.provider,
    ...(summary.path === undefined ? {} : { path: summary.path }),
    modelInvocable: summary.invocation?.modelInvocable !== false,
    userInvocable: summary.invocation?.userInvocable !== false,
  }
}
