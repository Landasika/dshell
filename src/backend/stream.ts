/** Best-effort extraction of display text from an assistant-stream chunk. */
export function streamChunkText(frame: unknown): string {
  if (typeof frame !== 'object' || frame === null) return ''
  const value = frame as {
    type?: unknown
    chunk?: {
      type?: unknown
      text?: unknown
      delta?: unknown
      content?: unknown
    }
  }
  if (value.type !== 'chunk' || typeof value.chunk !== 'object' || value.chunk === null) return ''
  const chunk = value.chunk
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  return ''
}

/** Whether a stream frame starts a new assistant attempt. */
export function isStreamStart(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as { type?: unknown }).type === 'start'
  )
}
