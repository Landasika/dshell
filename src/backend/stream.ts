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

/** Split an assistant-stream chunk into display text and reasoning text. */
export function streamChunkParts(frame: unknown): { text: string; reasoning: string } {
  if (typeof frame !== 'object' || frame === null) return { text: '', reasoning: '' }
  const value = frame as {
    type?: unknown
    chunk?: { type?: unknown; text?: unknown; delta?: unknown }
  }
  if (value.type !== 'chunk' || typeof value.chunk !== 'object' || value.chunk === null) {
    return { text: '', reasoning: '' }
  }
  const chunk = value.chunk
  const piece = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : ''
  if (piece.length === 0) return { text: '', reasoning: '' }
  return chunk.type === 'reasoning-delta'
    ? { text: '', reasoning: piece }
    : { text: piece, reasoning: '' }
}

/** Whether a stream frame starts a new assistant attempt. */
export function isStreamStart(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as { type?: unknown }).type === 'start'
  )
}
