import { paint, type Theme } from './theme.js'
import { sanitizeText, truncate, wrapText } from './width.js'

function isDiff(text: string): boolean {
  return /^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m.test(text)
}

/** Render a markdown-ish assistant/user message into terminal lines. */
export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  const safe = sanitizeText(text)
  if (safe.trim().length === 0) return []
  if (isDiff(safe)) return renderDiff(safe, width, theme)

  const lines: string[] = []
  let inFence = false
  let fenceLanguage = ''

  for (const raw of safe.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence !== null) {
      inFence = !inFence
      fenceLanguage = fence[1]?.trim() ?? ''
      if (inFence && fenceLanguage.length > 0) {
        lines.push(paint(theme, 'gray', `  ${truncate(fenceLanguage, Math.max(1, width - 2))}`))
      }
      continue
    }

    if (inFence) {
      if (line.length === 0) {
        lines.push(paint(theme, 'gray', `  │`))
      } else {
        lines.push(paint(theme, 'gray', `  │ ${truncate(line, Math.max(1, width - 4))}`))
      }
      continue
    }

    if (line.trim().length === 0) {
      lines.push('')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const title = heading[2] ?? ''
      const style = heading[1]?.length === 1 ? 'bold' : 'cyan'
      lines.push(paint(theme, style, truncate(title, width)))
      continue
    }

    const rule = /^\s*([-*_])\1{2,}\s*$/.test(line)
    if (rule) {
      lines.push(paint(theme, 'gray', '─'.repeat(Math.max(1, width))))
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const indent = Math.min(6, bullet[1]?.length ?? 0)
      const prefix = `${' '.repeat(indent)}• `
      const body = wrapText(bullet[2] ?? '', Math.max(1, width - indent - 2))
      lines.push(`${prefix}${body[0] ?? ''}`)
      for (const continuation of body.slice(1)) {
        lines.push(`${' '.repeat(indent + 2)}${continuation}`)
      }
      continue
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (numbered !== null) {
      const indent = Math.min(6, numbered[1]?.length ?? 0)
      const marker = `${numbered[2]}. `
      const body = wrapText(numbered[3] ?? '', Math.max(1, width - indent - marker.length))
      lines.push(`${' '.repeat(indent)}${paint(theme, 'bold', marker)}${body[0] ?? ''}`)
      for (const continuation of body.slice(1)) {
        lines.push(`${' '.repeat(indent + marker.length)}${continuation}`)
      }
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      for (const part of wrapText(quote[1] ?? '', Math.max(1, width - 2))) {
        lines.push(paint(theme, 'gray', `│ ${part}`))
      }
      continue
    }

    // Keep inline markup simple and predictable: remove the markers that
    // would otherwise look like noise, style the whole line where useful.
    const cleaned = line
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    for (const part of wrapText(cleaned, width)) lines.push(part)
  }

  return lines
}

/** Render a unified diff with line-level colors. */
export function renderDiff(text: string, width: number, theme: Theme): string[] {
  const lines: string[] = []
  for (const raw of sanitizeText(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('@@')) {
      lines.push(paint(theme, 'cyan', truncate(line, width)))
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      lines.push(paint(theme, 'bold', truncate(line, width)))
    } else if (line.startsWith('+')) {
      lines.push(paint(theme, 'green', truncate(line, width)))
    } else if (line.startsWith('-')) {
      lines.push(paint(theme, 'red', truncate(line, width)))
    } else if (line.startsWith('diff --git')) {
      lines.push(paint(theme, 'bold', truncate(line, width)))
    } else {
      lines.push(truncate(line, width))
    }
  }
  return lines
}
