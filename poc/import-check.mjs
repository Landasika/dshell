#!/usr/bin/env node
/**
 * Check which official DSH client entries are loadable from plain Node.
 *
 * Expected result on 0.2.1-rc.2:
 *   - connection / gateway / session remote: OK
 *   - session client / file-upload client: browser bundle, expected FAIL
 *
 * Exit code is 0 only when every entry matches its expectation. A browser-only
 * entry that unexpectedly loads is reported too, because that would change the
 * P2 adapter decision.
 */
const checks = [
  { spec: '@deepseek-ai/dsh-client-connection/client', expect: 'node' },
  { spec: '@deepseek-ai/dsh-api-gateway/client', expect: 'node' },
  { spec: '@deepseek-ai/dsh-api-session-controller/remote', expect: 'node' },
  { spec: '@deepseek-ai/dsh-api-session-controller/client', expect: 'browser-only' },
  { spec: '@deepseek-ai/dsh-client-file-upload/client', expect: 'browser-only' },
]

let mismatches = 0
for (const { spec, expect } of checks) {
  try {
    const module = await import(spec)
    const exports = Object.keys(module).slice(0, 8).join(', ')
    const ok = expect === 'node'
    console.log(`${ok ? 'PASS' : 'UNEXPECTED'} ${spec} (loaded: ${exports})`)
    if (!ok) mismatches += 1
  } catch (error) {
    const ok = expect === 'browser-only'
    console.log(`${ok ? 'EXPECTED-FAIL' : 'FAIL'} ${spec}: ${error.message}`)
    if (!ok) mismatches += 1
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} entr${mismatches === 1 ? 'y' : 'ies'} did not match expectation`)
  process.exitCode = 1
} else {
  console.log('\nall entries matched expectation')
}
