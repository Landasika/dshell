import { isMap, isSeq, isScalar, parseDocument, type Node, type YAMLMap } from 'yaml'
import { PROVIDER_APIS } from '../protocol/index.js'

export const PROVIDER_FIELDS = ['baseURL', 'apiKeyEnv', 'displayName', 'api'] as const
export type ProviderField = (typeof PROVIDER_FIELDS)[number]
export interface ProviderRecord { id: string; displayName?: string; baseURL?: string; apiKeyEnv?: string; api?: string; models: number }
export type ProviderEditCode = 'PROVIDERS_NOT_FOUND' | 'PROVIDER_NOT_FOUND' | 'PROVIDER_EXISTS' | 'EMPTY_PROVIDERS' | 'BAD_FIELD'
export class ProviderEditError extends Error {
  constructor(readonly code: ProviderEditCode, message: string) { super(message); this.name = 'ProviderEditError' }
}
export interface NewProviderSpec { id: string; baseURL: string; api?: string; apiKeyEnv?: string; displayName?: string; models: string[] }
export interface ProviderDetail { id: string; baseURL?: string; api?: string; apiKeyEnv?: string; modelIds: string[] }
function bad(message: string): never { throw new ProviderEditError('BAD_FIELD', message) }
function scalar(value: unknown): string | undefined { return isScalar(value) && typeof value.value === 'string' ? value.value : undefined }
function providerRows(node: unknown): YAMLMap[] {
  const found: YAMLMap[] = []
  const walk = (node: unknown): void => {
    if (isSeq(node)) { for (const item of node.items) walk(item); return }
    if (!isMap(node)) return
    if (node.get('id') === 'llm-pi-ai' || node.get('name') === '@deepseek-ai/dsh-llm-pi-ai') {
      found.push(node)
      return
    }
    for (const pair of node.items) if (String(pair.key) !== 'config') walk(pair.value)
  }
  walk(node)
  // Metadata-only patches do not replace an engine's inherited config.
  // Prefer the config-bearing row, while refusing ambiguous config owners.
  const configured = found.filter(row => row.has('config'))
  if (configured.length > 1) bad('multiple llm-pi-ai provider blocks; choose one configuration source before editing')
  return configured.length > 0 ? configured : found.slice(-1)
}
function providers(text: string): YAMLMap | undefined {
  const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true })
  if (doc.errors.length) bad('invalid YAML: ' + doc.errors[0]?.message)
  const map = providerRows(doc.contents)[0]?.getIn(['config', 'providers'], true)
  if (map !== undefined && !(isScalar(map) && map.value === null) && !isMap(map)) bad('providers must be a YAML map')
  return isMap(map) ? map : undefined
}
function requireProviders(text: string): YAMLMap {
  const map = providers(text)
  if (!map) throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai providers block in this patch file')
  return map
}
/** A config-bearing engine row owns providers even before its map is initialized. */
export function hasProviderConfig(text: string): boolean {
  const doc = parseDocument(text, { uniqueKeys: true })
  if (doc.errors.length) bad('invalid YAML: ' + doc.errors[0]?.message)
  return providerRows(doc.contents).some(row => row.has('config'))
}
function provider(text: string, id: string): YAMLMap {
  const map = requireProviders(text).get(id, true)
  if (!isMap(map)) throw new ProviderEditError('PROVIDER_NOT_FOUND', 'provider ' + id + ' is not declared in this patch file')
  return map
}
function modelIds(map: YAMLMap): string[] {
  const models = map.get('models', true)
  return !isSeq(models) ? [] : models.items.flatMap(item => {
    const id = isMap(item) ? item.get('id') ?? item.get('name') : undefined
    return typeof id === 'string' ? [id] : []
  })
}
const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1
function range(node: unknown): [number, number, number] {
  const r = (node as Node | null)?.range
  if (!r) bad('configuration uses an alias or an unaddressable YAML node')
  return r
}
const splice = (text: string, start: number, end: number, value: string): string => text.slice(0, start) + value + text.slice(end)
const pairFor = (map: YAMLMap, key: string) => map.items.find(pair => scalar(pair.key) === key)
function flowEdit(text: string, map: YAMLMap, change: (object: Record<string, unknown>) => void): string {
  const object = map.toJSON()
  change(object)
  const [start, end] = range(map)
  return splice(text, start, end, JSON.stringify(object))
}
export function encodeScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+~=-]+$/.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value) && !/^[-+]?\d/.test(value) && !value.endsWith(':')) return value
  return "'" + value.replaceAll("'", "''") + "'"
}
export function isProviderField(value: string): value is ProviderField { return (PROVIDER_FIELDS as readonly string[]).includes(value) }
export function readProviders(text: string): ProviderRecord[] {
  return providers(text)?.items.flatMap(pair => {
    const id = scalar(pair.key), map = pair.value
    if (id === undefined || !isMap(map)) return []
    const row: ProviderRecord = { id, models: modelIds(map).length }
    for (const field of PROVIDER_FIELDS) { const value = map.get(field); if (typeof value === 'string') row[field] = value }
    return [row]
  }) ?? []
}
export function readProviderDetail(text: string, id: string): ProviderDetail {
  const map = provider(text, id), row: ProviderDetail = { id, modelIds: modelIds(map) }
  for (const key of ['baseURL', 'api', 'apiKeyEnv'] as const) { const value = map.get(key); if (typeof value === 'string') row[key] = value }
  return row
}
/** Locate with YAML nodes; edit source ranges so unrelated rows retain their bytes. */
export function setProviderField(text: string, id: string, field: ProviderField, raw: string): string {
  if (!isProviderField(field)) bad('field cannot be edited from the TUI')
  const map = provider(text, id), value = raw.trim(), pair = pairFor(map, field)
  if (field === 'api' && !(PROVIDER_APIS as readonly string[]).includes(value)) bad('api is not a wire protocol this build knows')
  if (map.flow) return flowEdit(text, map, object => { object[field] = value })
  if (pair?.value) {
    const [start, end] = range(pair.value)
    return splice(text, start, end, encodeScalar(value) + (text.slice(start, end).endsWith('\n') ? '\n' : ''))
  }
  const first = range(map.items[0]?.key)[0], at = lineStart(text, first)
  return splice(text, at, at, ' '.repeat(first - at) + field + ': ' + encodeScalar(value) + '\n')
}
export function clearProviderField(text: string, id: string, field: ProviderField): string {
  const map = provider(text, id), pair = pairFor(map, field)
  if (!pair) return text
  if (map.flow) return flowEdit(text, map, object => { delete object[field] })
  return splice(text, lineStart(text, range(pair.key)[0]), range(pair.value ?? pair.key)[2], '')
}
export function addProvider(text: string, spec: NewProviderSpec): string {
  const map = providers(text)
  if (!map) {
    // A fresh installation can mount llm-pi-ai without any custom providers.
    // Initialize its map while preserving the rest of the engine config.
    const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true })
    const row = providerRows(doc.contents)[0]
    if (!row) throw new ProviderEditError('PROVIDERS_NOT_FOUND', 'no llm-pi-ai row in this configuration source')
    const config = row.get('config', true)
    if (config !== undefined && !(isScalar(config) && config.value === null) && !isMap(config)) bad('llm-pi-ai config must be a YAML map')
    if (isMap(config)) config.set('providers', doc.createNode({}))
    else row.set('config', doc.createNode({ providers: {} }))
    return addProvider(doc.toString(), spec)
  }
  const id = spec.id.trim(), api = spec.api?.trim()
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(id)) bad('provider id is not a safe YAML key')
  if (map.has(id)) throw new ProviderEditError('PROVIDER_EXISTS', 'provider ' + id + ' already exists')
  const models = [...new Set(spec.models.map(id => id.trim()).filter(Boolean))]
  if (!models.length) bad('a provider needs at least one model id')
  if (api && !(PROVIDER_APIS as readonly string[]).includes(api)) bad('api is not a wire protocol this build knows')
  const object = {
    ...(api ? { api } : {}),
    ...(spec.apiKeyEnv?.trim() ? { apiKeyEnv: spec.apiKeyEnv.trim() } : {}),
    ...(spec.displayName?.trim() ? { displayName: spec.displayName.trim() } : {}),
    baseURL: spec.baseURL.trim(), models: models.map(id => ({ id })),
  }
  if (map.flow || !map.items.length) return flowEdit(text, map, result => { result[id] = object })
  const first = range(map.items[0]?.key)[0], indent = first - lineStart(text, first)
  const rows = [' '.repeat(indent) + encodeScalar(id) + ':']
  for (const [key, value] of Object.entries(object)) {
    if (key === 'models') {
      rows.push(' '.repeat(indent + 2) + 'models:')
      for (const id of models) rows.push(' '.repeat(indent + 4) + '- id: ' + encodeScalar(id))
    } else rows.push(' '.repeat(indent + 2) + key + ': ' + encodeScalar(String(value)))
  }
  const at = range(map)[2]
  return splice(text, at, at, (text.slice(0, at).endsWith('\n') ? '' : '\n') + rows.join('\n') + (at < text.length || text.endsWith('\n') ? '\n' : ''))
}
export function removeProvider(text: string, id: string): string {
  const map = requireProviders(text), pair = pairFor(map, id)
  if (!pair) throw new ProviderEditError('PROVIDER_NOT_FOUND', 'provider ' + id + ' is not declared in this patch file')
  if (map.items.length <= 1) throw new ProviderEditError('EMPTY_PROVIDERS', 'refusing to remove the last provider')
  if (map.flow) return flowEdit(text, map, object => { delete object[id] })
  return splice(text, lineStart(text, range(pair.key)[0]), range(pair.value)[2], '')
}
export function syncProviderModels(text: string, id: string, add: readonly string[], remove: readonly string[]): string {
  const map = provider(text, id), models = map.get('models', true)
  if (!isSeq(models)) bad('provider declares no models list to sync')
  const dropping = new Set(remove), kept = models.items.filter(item => {
    const model = isMap(item) ? item.get('id') ?? item.get('name') : undefined
    return typeof model === 'string' && !dropping.has(model)
  })
  const ids = new Set(kept.map(item => (item as YAMLMap).get('id') ?? (item as YAMLMap).get('name')))
  const additions = [...new Set(add.map(id => id.trim()).filter(id => id && !dropping.has(id) && !ids.has(id)))]
  if (!kept.length && !additions.length) bad('a provider needs at least one model')
  const [start, end, nodeEnd] = range(models)
  if (models.flow) return splice(text, start, end, JSON.stringify([...kept.map(item => (item as YAMLMap).toJSON()), ...additions.map(id => ({ id }))]))
  const at = lineStart(text, start), indent = start - at
  let body = kept.map(item => text.slice(lineStart(text, range(item)[0]), range(item)[2])).join('')
  if (body && !body.endsWith('\n') && additions.length) body += '\n'
  body += additions.map(id => ' '.repeat(indent) + '- id: ' + encodeScalar(id)).join('\n')
  if (text.slice(at, nodeEnd).endsWith('\n') && !body.endsWith('\n')) body += '\n'
  return splice(text, at, nodeEnd, body)
}
