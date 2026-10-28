/** Paste handling: normalize pasted text and fold large pastes into placeholders. */

import { displayWidth } from './width.js'

/** Fold a paste when it has more than this many lines. */
export const PASTE_FOLD_LINES = 4
/** Fold a paste when it is wider than this many display cells. */
export const PASTE_FOLD_CHARS = 200

/**
 * Normalize pasted text: CRLF → LF and strip trailing whitespace from every
 * line. Pasted source usually carries editor artifacts (auto-indent padding,
 * selection trailing blanks) that the user never meant to send.
 */
export function normalizePaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
}

/** Decide whether a paste is large enough to fold into a placeholder. */
export function shouldFoldPaste(text: string): boolean {
  if (text.length === 0) return false
  if (text.includes('\n')) {
    const lines = text.split('\n').length
    if (lines > PASTE_FOLD_LINES) return true
  }
  return displayWidth(text) > PASTE_FOLD_CHARS
}

/**
 * Build the compact placeholder shown in the composer, e.g.
 * `[Pasted text #3 +20 lines]`. The full content is stored separately and
 * substituted back when the prompt is sent.
 */
export function pastePlaceholder(text: string, index: number): string {
  const lines = text.split('\n').length
  const size = lines > 1 ? `+${String(lines)} lines` : `+${String(text.length)} chars`
  return `[Pasted text #${String(index)} ${size}]`
}
