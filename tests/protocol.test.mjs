import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CAPABILITIES, PROTOCOL_VERSION } from '../dist/protocol/index.js'
import { defaultSocketPath, resolveSocketPath } from '../dist/shared/paths.js'

test('protocol v2 advertises the P3 capabilities', () => {
  assert.equal(PROTOCOL_VERSION, 2)
  assert.deepEqual(
    [...CAPABILITIES],
    [
      'list',
      'attach',
      'prompt',
      'event',
      'stream',
      'status',
      'workspaces',
      'create-session',
      'history',
      'cancel',
      'steer',
      'approval',
      'questions',
      'skills',
      'models',
      'providers',
    ],
  )
})

test('socket path follows DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dshell-test-home'
  try {
    assert.equal(defaultSocketPath(), '/tmp/dshell-test-home/run/dshell.sock')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('explicit socket override wins over DSHELL_SOCKET', () => {
  const previous = process.env.DSHELL_SOCKET
  process.env.DSHELL_SOCKET = '/tmp/from-env.sock'
  try {
    assert.equal(resolveSocketPath('/tmp/from-flag.sock'), '/tmp/from-flag.sock')
    assert.equal(resolveSocketPath(), '/tmp/from-env.sock')
  } finally {
    if (previous === undefined) delete process.env.DSHELL_SOCKET
    else process.env.DSHELL_SOCKET = previous
  }
})
