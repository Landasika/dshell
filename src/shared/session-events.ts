export interface SessionEventLike {
  type: string
  seq: number
  time?: number
  data?: unknown
}

export type EventData = Record<string, any>

/** Normalize the optional event payload once for every frontend and adapter. */
export function dataOf(event: SessionEventLike): EventData {
  return event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as EventData : {}
}

/** Extract textual message parts without leaking renderer-specific behavior. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text?: string } => {
      return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
    })
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** DSH-authored context that uses the user role but is not a human prompt. */
export function isInjectedContext(text: string): boolean {
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('Current runtime context.') ||
    text.startsWith('Time sampled while preparing') ||
    text.startsWith('The approval policy changed') ||
    text.startsWith('Session context compacted') ||
    text.startsWith('Current DSH file policy:')
  )
}

/** Resolve one compact list preview from the durable tail. */
export function latestUserPreview(
  events: readonly SessionEventLike[],
  options: { scanLimit?: number; maxChars?: number } = {},
): string | undefined {
  const scanLimit = Math.max(1, options.scanLimit ?? 300)
  const maxChars = Math.max(1, options.maxChars ?? 60)
  for (let index = events.length - 1; index >= Math.max(0, events.length - scanLimit); index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const data = dataOf(event)
    const message = (data.message ?? data) as Record<string, unknown>
    const source = message.source as { kind?: string } | undefined
    if (source?.kind !== 'user') continue
    const text = contentText(message.content).trim()
    if (text.length === 0 || isInjectedContext(text)) continue
    const flat = text.replace(/\s+/g, ' ')
    let preview = ''
    let length = 0
    for (const { segment } of previewSegments.segment(flat)) {
      if (length >= maxChars) return `${preview.trimEnd()}…`
      preview += segment
      length += 1
    }
    return preview
  }
  return undefined
}

const previewSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
