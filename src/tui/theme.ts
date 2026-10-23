/** ANSI styling for the TUI. Colors can be disabled with NO_COLOR/DSHELL_NO_COLOR. */
export interface Theme {
  enabled: boolean
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
  bgPanel: string
}

function enabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.DSHELL_NO_COLOR !== undefined) return false
  return process.env.TERM !== 'dumb'
}

export function createTheme(explicit?: boolean): Theme {
  const on = enabled(explicit)
  const sgr = (code: string): string => (on ? `\u001b[${code}m` : '')
  return {
    enabled: on,
    reset: sgr('0'),
    bold: sgr('1'),
    dim: sgr('2'),
    italic: sgr('3'),
    underline: sgr('4'),
    red: sgr('31'),
    green: sgr('32'),
    yellow: sgr('33'),
    blue: sgr('34'),
    magenta: sgr('35'),
    cyan: sgr('36'),
    gray: sgr('90'),
    white: sgr('97'),
    inverse: sgr('7'),
    bgPanel: sgr('48;5;236'),
  }
}

export function paint(theme: Theme, style: keyof Omit<Theme, 'enabled'>, text: string): string {
  if (!theme.enabled || text.length === 0) return text
  return `${theme[style]}${text}${theme.reset}`
}
