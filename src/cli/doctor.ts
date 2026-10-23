import { existsSync, statSync } from 'node:fs'

import { DshellError, HostConnection } from '../client/socket-client.js'
import { PROTOCOL_VERSION, type Capability } from '../protocol/index.js'
import { resolveDshHome } from '../shared/paths.js'
import { TESTED_DSH_VERSION, dshVersionNote } from '../shared/compat.js'

type CheckStatus = 'ok' | 'warn' | 'error'

function line(status: CheckStatus, label: string, detail: string): void {
  const mark = status === 'ok' ? '[ok]  ' : status === 'warn' ? '[warn]' : '[err] '
  console.log(`${mark} ${label.padEnd(20)} ${detail}`)
}

function nodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  return Number.isFinite(major) ? major : 0
}

/** Run local diagnostics and return a process exit code. */
export async function runDoctor(socketPath: string): Promise<number> {
  let ok = true

  if (process.platform === 'linux') {
    line('ok', 'platform', 'linux')
  } else {
    ok = false
    line('error', 'platform', `${process.platform} (V1 supports Linux only)`)
  }

  if (nodeMajor() >= 22) {
    line('ok', 'node', process.versions.node)
  } else {
    ok = false
    line('error', 'node', `${process.versions.node} (requires Node 22.19+ or 24+)`)
  }

  const home = resolveDshHome()
  if (existsSync(home)) {
    line('ok', 'DSH_HOME', home)
  } else {
    line('warn', 'DSH_HOME', `${home} (does not exist yet)`)
  }

  let stat
  try {
    stat = statSync(socketPath)
  } catch {
    ok = false
    line('error', 'socket', `${socketPath} (not found)`)
    console.log('       Start the Host:        dsh --profile web')
    console.log('       Install the plugin:    dsh plugin --profile web add @landasika/dshell')
    return 1
  }

  if (!stat.isSocket()) {
    ok = false
    line('error', 'socket', `${socketPath} (exists, but is not a socket)`)
    return 1
  }
  line('ok', 'socket', socketPath)

  const mode = stat.mode & 0o777
  if (mode === 0o600) {
    line('ok', 'socket mode', '0600')
  } else {
    ok = false
    line('error', 'socket mode', `0${mode.toString(8)} (expected 0600)`)
  }

  let connection: HostConnection
  try {
    connection = await HostConnection.connect(socketPath)
  } catch (error) {
    ok = false
    if (error instanceof DshellError) {
      line('error', 'handshake', `${error.code}: ${error.message}`)
      if (error.action !== undefined) console.log(`       ${error.action}`)
    } else {
      line('error', 'handshake', error instanceof Error ? error.message : String(error))
    }
    return 1
  }

  try {
    const welcome = connection.welcome
    line('ok', 'host', `plugin ${welcome.pluginVersion}, dsh ${welcome.dshVersion}`)
    if (welcome.protocol === PROTOCOL_VERSION) {
      line('ok', 'protocol', String(welcome.protocol))
    } else {
      ok = false
      line('error', 'protocol', `${welcome.protocol} (this CLI uses ${PROTOCOL_VERSION})`)
    }

    const required: Capability[] = ['list', 'attach', 'prompt', 'event', 'stream', 'status']
    const missing = required.filter((capability) => !welcome.capabilities.includes(capability))
    if (missing.length === 0) {
      line('ok', 'capabilities', welcome.capabilities.join(', '))
    } else {
      ok = false
      line('error', 'capabilities', `missing: ${missing.join(', ')}`)
    }

    if (welcome.dshVersion === 'unknown') {
      line('warn', 'dsh version', dshVersionNote(welcome.dshVersion))
    } else if (welcome.dshVersion !== TESTED_DSH_VERSION) {
      line('warn', 'dsh version', dshVersionNote(welcome.dshVersion))
    }
  } finally {
    connection.close()
  }

  return ok ? 0 : 1
}
