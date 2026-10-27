/**
 * Session spend estimation for official DeepSeek routes.
 *
 * DSH reports token counts, not money. The TUI converts the durable usage
 * events to an estimate with the published per-million-token rates:
 *
 *   input miss + cache write -> miss rate
 *   cache read               -> hit rate
 *   output                   -> output rate
 *
 * Peak hours (Beijing time, Mon-Fri 09:00-12:00 / 14:00-18:00) use the peak
 * rate; everything else uses the idle rate. This is an estimate, never a bill.
 */
import type { SessionEvent } from '../protocol/index.js'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface ModelSpend {
  provider?: string
  model: string
  tokens: UsageTotals
  cost?: number
}

export interface SessionCost {
  tokens: UsageTotals
  /** Estimated session spend in CNY. Undefined when no usage was priced. */
  cost?: number
  peak: number
  idle: number
  pricedTokens: number
  unpricedTokens: number
  models: ModelSpend[]
}

interface Price {
  /** CNY per million tokens, idle rate. Peak is exactly double. */
  inputMiss: number
  inputHit: number
  output: number
}

/**
 * DeepSeek published rates (CNY / million tokens, idle). Prefix match, longest
 * first. V4.1-Flash is billed at the Flash rate. Unknown models are reported
 * as unpriced tokens instead of inventing a number.
 */
export const DEEPSEEK_PRICES: Readonly<Record<string, Price>> = {
  'deepseek-v4.1-flash': { inputMiss: 1.0, inputHit: 0.02, output: 4.0 },
  'deepseek-v4-flash': { inputMiss: 1.0, inputHit: 0.02, output: 4.0 },
  'deepseek-v4-flash-vision-exp': { inputMiss: 1.0, inputHit: 0.02, output: 4.0 },
  'deepseek-flash': { inputMiss: 1.0, inputHit: 0.02, output: 4.0 },
}

export function priceForModel(model: string | undefined): Price | undefined {
  if (model === undefined) return undefined
  let best: Price | undefined
  let bestLength = 0
  for (const [prefix, price] of Object.entries(DEEPSEEK_PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = price
      bestLength = prefix.length
    }
  }
  return best
}

/** Beijing is UTC+8 with no DST. */
export function isPeakHour(time: number): boolean {
  const shifted = new Date(time + 8 * 3_600_000)
  const weekday = shifted.getUTCDay()
  const hour = shifted.getUTCHours()
  if (weekday === 0 || weekday === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total += source.total
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Normalize one DSH `usage` object (camelCase or snake_case). */
export function parseUsage(value: unknown): UsageTotals | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const input = numberValue(record.inputTokens ?? record.input_tokens)
  const output = numberValue(record.outputTokens ?? record.output_tokens)
  const cacheRead = numberValue(record.cacheReadTokens ?? record.cache_read_tokens)
  const cacheWrite = numberValue(record.cacheWriteTokens ?? record.cache_write_tokens)
  const total = input + output + cacheRead + cacheWrite
  if (total <= 0) return undefined
  return { input, output, cacheRead, cacheWrite, total }
}

function usageCost(tokens: UsageTotals, price: Price, peak: boolean): number {
  const multiplier = peak ? 2 : 1
  return (
    tokens.input * price.inputMiss * multiplier
    + tokens.cacheRead * price.inputHit * multiplier
    + tokens.cacheWrite * price.inputMiss * multiplier
    + tokens.output * price.output * multiplier
  ) / 1_000_000
}

function modelKey(provider: string | undefined, model: string): string {
  return `${provider ?? ''}\u0000${model}`
}

/** Fold every durable usage event into session totals and an estimated cost. */
export function estimateSessionCost(events: readonly SessionEvent[]): SessionCost {
  const tokens = emptyTotals()
  let provider: string | undefined
  let model: string | undefined
  const models = new Map<string, ModelSpend>()
  let peak = 0
  let idle = 0
  let pricedTokens = 0
  let unpricedTokens = 0
  // A snapshot replay or history page can repeat the same settlement. One
  // turn/step settles once, so count its usage once (retry events carry no
  // usage of their own).
  const seenSteps = new Set<string>()

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    if (event.type === 'request/context') {
      if (typeof data.provider === 'string') provider = data.provider
      if (typeof data.model === 'string') model = data.model
      continue
    }
    if (event.type === 'request/header') {
      const header = data.header as Record<string, unknown> | undefined
      const config = header?.config as Record<string, unknown> | undefined
      if (typeof config?.provider === 'string') provider = config.provider
      if (typeof config?.model === 'string') model = config.model
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = parseUsage(data.usage)
    if (usage === undefined) continue
    const turn = numberValue(data.turn)
    const step = numberValue(data.step)
    if (turn > 0 && step > 0) {
      const stepKey = `${turn}/${step}`
      if (seenSteps.has(stepKey)) continue
      seenSteps.add(stepKey)
    }

    addTotals(tokens, usage)
    const at = typeof event.time === 'number' ? event.time : Date.now()
    const isPeak = isPeakHour(at)
    const label = model ?? 'unknown'
    const key = modelKey(provider, label)
    let spend = models.get(key)
    if (spend === undefined) {
      spend = { model: label, tokens: emptyTotals(), ...(provider === undefined ? {} : { provider }) }
      models.set(key, spend)
    }
    addTotals(spend.tokens, usage)

    const price = priceForModel(model)
    if (price === undefined) {
      unpricedTokens += usage.total
      continue
    }
    const amount = usageCost(usage, price, isPeak)
    spend.cost = (spend.cost ?? 0) + amount
    pricedTokens += usage.total
    if (isPeak) peak += amount
    else idle += amount
  }

  const cost = pricedTokens > 0 ? peak + idle : undefined
  return {
    tokens,
    ...(cost === undefined ? {} : { cost }),
    peak,
    idle,
    pricedTokens,
    unpricedTokens,
    models: [...models.values()],
  }
}

/** `¥0.0042` for sub-cent sessions, `¥12.34` above one yuan. */
export function formatCostCny(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '¥0.00'
  if (amount < 0.01) return `¥${amount.toFixed(4)}`
  return `¥${amount.toFixed(2)}`
}
