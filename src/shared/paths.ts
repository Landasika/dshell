import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolve the DSH home the same way the harness does. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/** Default control socket for the local dshell-host plugin. */
export function defaultSocketPath(): string {
  return join(resolveDshHome(), 'run', 'dshell.sock')
}

/** Explicit CLI override wins over DSHELL_SOCKET, then the profile home. */
export function resolveSocketPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  const configured = process.env.DSHELL_SOCKET
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  return defaultSocketPath()
}
