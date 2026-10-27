/**
 * ANSI styling for the TUI.
 *
 * The default family is "mist blue": DeepSeek's brand blue carries focus and
 * interaction, neutral surfaces stay quiet, and the five context-bar colours
 * form one blue ramp. Terminals with truecolor get the real palette; others
 * fall back to the nearest xterm-256 colour. `NO_COLOR` / `DSHELL_NO_COLOR`
 * turn every sequence off.
 */
export interface Theme {
  enabled: boolean
  truecolor: boolean
  reset: string
  bold: string
  dim: string
  italic: string
  underline: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  gray: string
  white: string
  inverse: string
  /** Background for raised panels, cards and the composer. */
  bgPanel: string
  /** Background for the empty part of the context bar. */
  bgFree: string
  /** Primary brand/focus colour. */
  accent: string
  /** Lighter brand tone used for gradients and shimmer. */
  accentSoft: string
  /** Body text. */
  text: string
  /** Secondary text and hints. */
  muted: string
  /** Rules and box borders. */
  border: string
  /** Semantic state colours. */
  success: string
  warning: string
  error: string
  info: string
  /** Context-bar composition ramp, system → tools. */
  contextSystem: string
  contextPrompt: string
  contextAssistant: string
  contextThinking: string
  contextTools: string
  /** Selected-row fill. */
  selection: string
}

export type ThemeStyle = Exclude<keyof Theme, 'enabled' | 'truecolor'>

interface Rgb {
  r: number
  g: number
  b: number
}

const PALETTE = {
  accent: '#4d6bfe',
  accentSoft: '#8aa2ff',
  text: '#dce3f0',
  muted: '#7b879c',
  border: '#2f3a4f',
  success: '#48c78e',
  warning: '#f5b451',
  error: '#f26d78',
  info: '#63b3ed',
  contextSystem: '#22305f',
  contextPrompt: '#2b3d78',
  contextAssistant: '#344a92',
  contextThinking: '#4d6bfe',
  contextTools: '#7d96ff',
  bgPanel: '#1b2230',
  bgFree: '#252e3f',
  selection: '#2c3a58',
} as const

function parseHex(value: string): Rgb {
  const hex = value.replace(/^#/, '')
  const number = Number.parseInt(hex, 16)
  return {
    r: (number >> 16) & 0xff,
    g: (number >> 8) & 0xff,
    b: number & 0xff,
  }
}

/** Nearest xterm-256 cube colour for terminals without 24-bit support. */
function to256({ r, g, b }: Rgb): number {
  const level = (value: number): number => {
    const cube = value < 48 ? 0 : value < 115 ? 1 : Math.round((value - 35) / 40)
    return Math.max(0, Math.min(5, cube))
  }
  const index = 16 + 36 * level(r) + 6 * level(g) + level(b)
  // Grey ramp is usually a better match for neutral surfaces.
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const grey = Math.round(((r + g + b) / 3 - 8) / 10)
    return 232 + Math.max(0, Math.min(23, grey))
  }
  return index
}

function detectTruecolor(): boolean {
  if (process.env.DSHELL_TRUECOLOR === '1') return true
  if (process.env.DSHELL_TRUECOLOR === '0') return false
  return /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
    || /truecolor/i.test(process.env.TERM ?? '')
}

function enabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.DSHELL_NO_COLOR !== undefined) return false
  return process.env.TERM !== 'dumb'
}

export function createTheme(explicit?: boolean): Theme {
  const on = enabled(explicit)
  const truecolor = on && detectTruecolor()
  const fg = (hex: string): string => {
    if (!on) return ''
    const rgb = parseHex(hex)
    return truecolor
      ? `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
      : `\u001b[38;5;${to256(rgb)}m`
  }
  const bg = (hex: string): string => {
    if (!on) return ''
    const rgb = parseHex(hex)
    return truecolor
      ? `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m`
      : `\u001b[48;5;${to256(rgb)}m`
  }
  return {
    enabled: on,
    truecolor,
    reset: on ? '\u001b[0m' : '',
    bold: on ? '\u001b[1m' : '',
    dim: on ? '\u001b[2m' : '',
    italic: on ? '\u001b[3m' : '',
    underline: on ? '\u001b[4m' : '',
    // Base ANSI names stay available for very old call sites; the semantic
    // keys below are preferred by the new components.
    red: fg(PALETTE.error),
    green: fg(PALETTE.success),
    yellow: fg(PALETTE.warning),
    blue: fg(PALETTE.accent),
    magenta: fg(PALETTE.accent),
    cyan: fg(PALETTE.info),
    gray: fg(PALETTE.muted),
    white: fg(PALETTE.text),
    inverse: on ? '\u001b[7m' : '',
    bgPanel: bg(PALETTE.bgPanel),
    bgFree: bg(PALETTE.bgFree),
    accent: fg(PALETTE.accent),
    accentSoft: fg(PALETTE.accentSoft),
    text: fg(PALETTE.text),
    muted: fg(PALETTE.muted),
    border: fg(PALETTE.border),
    success: fg(PALETTE.success),
    warning: fg(PALETTE.warning),
    error: fg(PALETTE.error),
    info: fg(PALETTE.info),
    contextSystem: fg(PALETTE.contextSystem),
    contextPrompt: fg(PALETTE.contextPrompt),
    contextAssistant: fg(PALETTE.contextAssistant),
    contextThinking: fg(PALETTE.contextThinking),
    contextTools: fg(PALETTE.contextTools),
    selection: bg(PALETTE.selection),
  }
}

export function paint(theme: Theme, style: ThemeStyle, text: string): string {
  if (!theme.enabled || text.length === 0) return text
  return `${theme[style]}${text}${theme.reset}`
}

/** Raw foreground SGR for per-cell sprite rendering (no text, no reset). */
export function fgCode(theme: Theme, hex: string): string {
  if (!theme.enabled) return ''
  const rgb = parseHex(hex)
  return theme.truecolor
    ? `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\u001b[38;5;${to256(rgb)}m`
}

/** Raw background SGR for per-cell sprite rendering (no text, no reset). */
export function bgCode(theme: Theme, hex: string): string {
  if (!theme.enabled) return ''
  const rgb = parseHex(hex)
  return theme.truecolor
    ? `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\u001b[48;5;${to256(rgb)}m`
}

/** Foreground hex colour for gradients and per-cell sprite rendering. */
export function fgColor(theme: Theme, hex: string, text: string): string {
  if (!theme.enabled || text.length === 0) return text
  return `${fgCode(theme, hex)}${text}${theme.reset}`
}

export function bgColor(theme: Theme, hex: string, text: string): string {
  if (!theme.enabled || text.length === 0) return text
  return `${bgCode(theme, hex)}${text}${theme.reset}`
}

/** Blend two hex colours; `amount` 0 keeps `from`, 1 reaches `to`. */
export function blendHex(from: string, to: string, amount: number): string {
  const left = parseHex(from)
  const right = parseHex(to)
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * Math.max(0, Math.min(1, amount)))
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${hex(mix(left.r, right.r))}${hex(mix(left.g, right.g))}${hex(mix(left.b, right.b))}`
}

export const BRAND_HEX = {
  accent: PALETTE.accent,
  accentSoft: PALETTE.accentSoft,
  warning: PALETTE.warning,
  error: PALETTE.error,
  success: PALETTE.success,
} as const
