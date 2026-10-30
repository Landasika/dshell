/**
 * Line-oriented reader/editor for the `llm-pi-ai` provider block of a DSH
 * patch file.
 *
 * A full YAML round-trip would rewrite comments, anchors and `!!js` tags that
 * belong to the user. The DSH generator emits a strictly indented shape, so
 * this module recognises that shape and refuses anything else instead of
 * guessing:
 *
 * ```yaml
 * - id: llm-pi-ai
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       kimi-relay:                 # provider key, six spaces
 *         apiKeyEnv: KIMI_RELAY_API_KEY
 *         baseURL: http://host:8180
 *         displayName: Kimi 中转站
 *         models:                   # list items at ten spaces
 *           - id: kimi-latest
 * ```
 */

/** Provider fields the TUI may rewrite. Secrets never live in this file. */
export const PROVIDER_FIELDS = ['baseURL', 'apiKeyEnv', 'displayName'] as const
export type ProviderField = (typeof PROVIDER_FIELDS)[number]

export interface ProviderRecord {
  id: string
  displayName?: string
  baseURL?: string
  apiKeyEnv?: string
  /** Number of `- id:` rows under the provider's `models:` list. */
  models: number
}

const PROVIDERS_KEY = /^ {4}providers:[ \t]*(?:#.*)?$/
const PROVIDER_ID = /^ {6}([A-Za-z0-9_][A-Za-z0-9_.:-]*):[ \t]*(?:#.*)?$/
const FIELD = /^ {8}([A-Za-z][A-Za-z0-9]*):[ \t]*(.*?)[ \t]*$/
const MODEL_ROW = /^ {10}- (?:id|name):/

/** Decode one scalar: quoted forms keep `#`, plain forms drop a comment. */
function parseScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'")
    if (end > 0) return trimmed.slice(1, end).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"')
    if (end > 0) return trimmed.slice(1, end).replaceAll('\\"', '"')
  }
  // A `#` only starts a comment after whitespace, per YAML plain scalars.
  const match = /(^|\s)#/.exec(trimmed)
  return (match === null ? trimmed : trimmed.slice(0, match.index)).trim()
}

/** Quote a scalar only when a plain YAML scalar would change its meaning. */
export function encodeScalar(value: string): string {
  const plain = /^[A-Za-z0-9_./:@+~=-]+$/.test(value)
  const ambiguous = value.length === 0
    || !plain
    || /^(true|false|null|yes|no|on|off|~)$/i.test(value)
    || /^[-+]?\d/.test(value)
  if (!ambiguous && !value.includes(': ') && !value.endsWith(':')) return value
  return `'${value.replaceAll("'", "''")}'`
}

/** Split the file into lines, remembering whether it ended with a newline. */
function splitLines(text: string): string[] {
  return text.split('\n')
}

function splitDocument(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  return { lines: body.split('\n'), trailingNewline }
}

function joinDocument(lines: string[], trailingNewline: boolean): string {
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`
}

/** Locate the `providers:` map and the byte-free line ranges of each entry. */
export function findProviderBlock(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => PROVIDERS_KEY.test(line))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= 4) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Parse every provider row of the first `providers:` map in the file. */
export function readProviders(text: string): ProviderRecord[] {
  const lines = splitLines(text)
  const block = findProviderBlock(lines)
  if (block === undefined) return []
  const ranges = providerRanges(lines, block)
  const records: ProviderRecord[] = []
  for (const [id, range] of ranges) {
    const record: ProviderRecord = { id, models: 0 }
    for (let index = range.start + 1; index < range.end; index += 1) {
      const line = lines[index] ?? ''
      if (MODEL_ROW.test(line)) {
        record.models += 1
        continue
      }
      const match = FIELD.exec(line)
      if (match === null) continue
      const key = match[1]
      const value = parseScalar(match[2] ?? '')
      if (value.length === 0) continue
      if (key === 'baseURL') record.baseURL = value
      else if (key === 'apiKeyEnv') record.apiKeyEnv = value
      else if (key === 'displayName') record.displayName = value
    }
    records.push(record)
  }
  return records
}

function providerRanges(
  lines: string[],
  block: { start: number; end: number },
): Map<string, { start: number; end: number }> {
  const ranges = new Map<string, { start: number; end: number }>()
  const starts: Array<{ id: string; line: number }> = []
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = PROVIDER_ID.exec(lines[index] ?? '')
    if (match?.[1] !== undefined) starts.push({ id: match[1], line: index })
  }
  for (const [offset, entry] of starts.entries()) {
    const next = starts[offset + 1]
    ranges.set(entry.id, { start: entry.line, end: next === undefined ? block.end : next.line })
  }
  return ranges
}

export type ProviderEditCode =
  | 'PROVIDERS_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_EXISTS'
  | 'EMPTY_PROVIDERS'
  | 'BAD_FIELD'

export class ProviderEditError extends Error {
  readonly code: ProviderEditCode
  constructor(code: ProviderEditCode, message: string) {
    super(message)
    this.name = 'ProviderEditError'
    this.code = code
  }
}

export function isProviderField(value: string): value is ProviderField {
  return (PROVIDER_FIELDS as readonly string[]).includes(value)
}

/**
 * Replace one scalar field of one provider, inserting the key when absent.
 * Returns the new file text; throws before touching anything it cannot locate.
 */
export function setProviderField(text: string, providerId: string, field: ProviderField, rawValue: string): string {
  if (!isProviderField(field)) {
    throw new ProviderEditError('BAD_FIELD', `field ${String(field)} cannot be edited from the TUI`)
  }
  const value = rawValue.trim()
  const { lines, trailingNewline } = splitDocument(text)
  const block = findProviderBlock(lines)
  if (block === undefined) {
    throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai providers block in this patch file')
  }
  const range = providerRanges(lines, block).get(providerId)
  if (range === undefined) {
    throw new ProviderEditError('PROVIDER_NOT_FOUND', `provider ${providerId} is not declared in this patch file`)
  }
  const replacement = `        ${field}: ${encodeScalar(value)}`
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index] ?? ''
    if (new RegExp(`^ {8}${field}:[ \\t]`).test(line) || line === `        ${field}:`) {
      lines[index] = replacement
      return joinDocument(lines, trailingNewline)
    }
  }
  // Insert directly under the provider key so the insert sits above its models.
  lines.splice(range.start + 1, 0, replacement)
  return joinDocument(lines, trailingNewline)
}

/** Remove one provider field; a missing key is not an error. */
export function clearProviderField(text: string, providerId: string, field: ProviderField): string {
  const { lines, trailingNewline } = splitDocument(text)
  const block = findProviderBlock(lines)
  if (block === undefined) {
    throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai providers block in this patch file')
  }
  const range = providerRanges(lines, block).get(providerId)
  if (range === undefined) {
    throw new ProviderEditError('PROVIDER_NOT_FOUND', `provider ${providerId} is not declared in this patch file`)
  }
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index] ?? ''
    if (new RegExp(`^ {8}${field}:[ \\t]`).test(line) || line === `        ${field}:`) {
      lines.splice(index, 1)
      return joinDocument(lines, trailingNewline)
    }
  }
  return text
}

/** A provider row the TUI asks the Host to create. */
export interface NewProviderSpec {
  id: string
  baseURL: string
  /** Wire protocol; required when a model is not in the installed catalog. */
  api?: string
  apiKeyEnv?: string
  displayName?: string
  models: string[]
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/

/** Append a complete provider block, keeping the file's indentation style. */
export function addProvider(text: string, spec: NewProviderSpec): string {
  const id = spec.id.trim()
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new ProviderEditError('BAD_FIELD', `provider id "${id}" is not a safe YAML key`)
  }
  const models = spec.models.map((model) => model.trim()).filter((model) => model.length > 0)
  if (models.length === 0) {
    throw new ProviderEditError('BAD_FIELD', 'a provider needs at least one model id')
  }
  const { lines, trailingNewline } = splitDocument(text)
  const block = findProviderBlock(lines)
  if (block === undefined) {
    throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai providers block in this patch file')
  }
  if (providerRanges(lines, block).has(id)) {
    throw new ProviderEditError('PROVIDER_EXISTS', `provider ${id} already exists`)
  }
  if (block.end === block.start + 1) {
    throw new ProviderEditError('EMPTY_PROVIDERS', 'the providers block is empty; add the first provider by hand')
  }
  const api = spec.api?.trim() ?? ''
  const API_VALUES = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
  if (api.length > 0 && !API_VALUES.has(api)) {
    throw new ProviderEditError('BAD_FIELD', `api "${api}" is not a wire protocol this build knows`)
  }
  const row: string[] = [`      ${id}:`]
  if (api.length > 0) {
    row.push(`        api: ${encodeScalar(api)}`)
  }
  if (spec.apiKeyEnv !== undefined && spec.apiKeyEnv.trim().length > 0) {
    row.push(`        apiKeyEnv: ${encodeScalar(spec.apiKeyEnv.trim())}`)
  }
  if (spec.displayName !== undefined && spec.displayName.trim().length > 0) {
    row.push(`        displayName: ${encodeScalar(spec.displayName.trim())}`)
  }
  row.push(`        baseURL: ${encodeScalar(spec.baseURL.trim())}`)
  row.push('        models:')
  for (const model of models) row.push(`          - id: ${encodeScalar(model)}`)

  // Insert after the last provider line, above the blank line that separates
  // this entry from the next top-level one.
  let insertAt = block.end
  while (insertAt > block.start + 1 && (lines[insertAt - 1] ?? '').trim().length === 0) insertAt -= 1
  lines.splice(insertAt, 0, ...row)
  return joinDocument(lines, trailingNewline)
}

/** Remove a whole provider block; other providers stay byte-identical. */
export function removeProvider(text: string, providerId: string): string {
  const { lines, trailingNewline } = splitDocument(text)
  const block = findProviderBlock(lines)
  if (block === undefined) {
    throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai providers block in this patch file')
  }
  const ranges = providerRanges(lines, block)
  const range = ranges.get(providerId)
  if (range === undefined) {
    throw new ProviderEditError('PROVIDER_NOT_FOUND', `provider ${providerId} is not declared in this patch file`)
  }
  if (ranges.size <= 1) {
    throw new ProviderEditError('EMPTY_PROVIDERS', 'refusing to remove the last provider')
  }
  lines.splice(range.start, range.end - range.start)
  return joinDocument(lines, trailingNewline)
}
