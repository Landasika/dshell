// Supplemental audit probes. DSH services are simulated; Unix sockets are real.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../../../dist/plugin/index.js'
import { SocketBackend } from '../../../dist/backend/socket.js'
import { syncProviderModels } from '../../../dist/plugin/profile.js'
import { createFakeCtx, makeSession } from './support.mjs'

const report = (id, facts) => console.log(JSON.stringify({ id, ...facts }))
const source = `- id: llm-pi-ai
  config:
    providers:
      custom:
        models:
          - id: old
        baseURL: https://example.invalid/v1
        apiKeyEnv: CUSTOM_KEY
`
const rewritten = syncProviderModels(source, 'custom', ['new'], ['old'])
assert(!rewritten.includes('baseURL:'))
assert(!rewritten.includes('apiKeyEnv:'))
report('provider-sync-loses-sibling-fields', {
  modelCountUnchanged: true, baseURLDeleted: true, credentialReferenceDeleted: true,
  note: 'Pure editor result; outer persistence validation can reject this particular rewrite.',
})

const directory = await mkdtemp(join(tmpdir(), 'dshell-audit-boundary-'))
process.env.DSH_HOME = directory
const socketPath = join(directory, 'host.sock')
const file = join(directory, 'cordis.patch.yml')
await writeFile(file, `- id: llm-pi-ai
  config:
    providers:
      custom:
        baseURL: https://example.invalid/v1
        models:
          - id: old
        api: anthropic-messages
`)
const harness = createFakeCtx({ dshHomePath: directory })
makeSession(harness, 's1', [{ type: 'turn/end', seq: 1, data: {} }])
await apply(harness.ctx, { socketPath })
const backend = new SocketBackend(socketPath)
try {
  await backend.connect()
  await backend.applyProviderSync('custom', ['new'], ['old'])
  const after = await readFile(file, 'utf8')
  assert(!after.includes('api:'))
  assert(after.includes('baseURL:'))
  report('provider-sync-persists-sibling-loss', {
    passedOuterValidation: true, apiDeleted: true, baseURLPreserved: true, output: after,
  })
  for (let i = 0; i < 10; i++) {
    const handle = await backend.openSession('s1')
    handle.dispose()
  }
  // Inspect TypeScript-private fields to prove retention, without a noisy heap benchmark.
  assert.equal(backend.handles.size, 10)
  report('disposed-handles-retained', {
    disposedCount: 10, retainedHandles: backend.handles.size,
    retainedHistoryArrays: [...backend.handles].filter(handle => handle.snapshot().events.length > 0).length,
  })
} finally {
  await backend.disconnect()
  for (const dispose of harness.disposers) await dispose()
  await rm(directory, { recursive: true, force: true })
}

const ptyProbe = spawnSync('python3', ['-c', `
import os, pty, subprocess, json, sys
master, slave = pty.openpty()
proc = subprocess.Popen([sys.argv[1], sys.argv[2], '--resume', 'audit-session', '--socket', '/tmp/dshell-audit-missing.sock'], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
out = b''
while True:
    try:
        chunk = os.read(master, 8192)
        if not chunk: break
        out += chunk
    except OSError: break
proc.wait(timeout=10)
os.close(master)
assert b'Usage:' in out
assert proc.returncode == 0
print(json.dumps({'id':'implicit-tui-options-pty', 'isTTY':True, 'exitCode':proc.returncode, 'printedHelp':True, 'outputPrefix':out.decode()[:180]}))
`, process.execPath, fileURLToPath(new URL('../../../dist/bin/dshell.js', import.meta.url))], {
  encoding: 'utf8', timeout: 15_000,
})
if (ptyProbe.error) throw ptyProbe.error
assert.equal(ptyProbe.status, 0, ptyProbe.stderr)
process.stdout.write(ptyProbe.stdout)
