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

/** Split the file into lines without normalising the trailing newline. */
function splitLines(text: string): string[] {
  return text.split('\n')
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

export class ProviderEditError extends Error {
  readonly code: 'PROVIDERS_NOT_FOUND' | 'PROVIDER_NOT_FOUND' | 'BAD_FIELD'
  constructor(code: 'PROVIDERS_NOT_FOUND' | 'PROVIDER_NOT_FOUND' | 'BAD_FIELD', message: string) {
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
  const lines = splitLines(text)
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
      return lines.join('\n')
    }
  }
  // Insert directly under the provider key so the insert sits above its models.
  lines.splice(range.start + 1, 0, replacement)
  return lines.join('\n')
}

/** Remove one provider field; a missing key is not an error. */
export function clearProviderField(text: string, providerId: string, field: ProviderField): string {
  const lines = splitLines(text)
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
      return lines.join('\n')
    }
  }
  return text
}
