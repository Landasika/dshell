/** The DSH version and protocol this dshell release was tested against. */
export const TESTED_DSH_VERSION = '0.2.1-rc.2'
export const TESTED_PROTOCOL_VERSION = 2
export const SUPPORTED_NODE_RANGE = '^22.19.0 || >=24.0.0'
export const SUPPORTED_PLATFORM = 'linux'

export function isTestedDshVersion(version: string | undefined): boolean {
  return version === TESTED_DSH_VERSION
}

export function dshVersionNote(version: string | undefined): string {
  if (version === undefined || version === 'unknown') return 'unknown (tested against 0.2.1-rc.2)'
  if (isTestedDshVersion(version)) return `${version} (tested)`
  return `${version} (untested; dshell was tested against 0.2.1-rc.2)`
}
