import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CAPABILITIES, PROTOCOL_VERSION } from '../dist/protocol/index.js'
import { defaultSocketPath, resolveSocketPath } from '../dist/shared/paths.js'

test('protocol v2 advertises the P3 capabilities', () => {
  assert.equal(PROTOCOL_VERSION, 2)
  assert.deepEqual(
    [...CAPABILITIES],
    [
      'session-rename',
      'session-archive',
      'session-pin',
      'session-fork',
      'rpc-id',
      'pending-snapshot',
      'turn-correlation',
      'prompt-content',
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
      'cancel-continue',
      'steer',
      'approval',
      'questions',
      'skills',
      'models',
      'providers',
      'provider-key',
      'provider-discover',
      'agents',
      'session-children',
      'session-index',
      // 只订阅广播、不推历史。多端同步靠它：手机要看见"电脑终端上那条
      // 会话开始跑了"，就必须 watch；用 attach 替代会每条都读日志 + 拉历史。
      'watch',
    ],
  )
})

test('新增的会话组织能力都进了能力表', async () => {
  // 能力表是客户端判断"这个 Host 支不支持某功能"的唯一依据。加了请求
  // 却不加能力，客户端就只能靠"收到 unknown message type"才发现不支持——
  // 那是错误路径，不是协商。
  const { CAPABILITIES: caps } = await import('../dist/protocol/index.js')
  for (const name of ['session-children', 'session-index']) {
    assert.ok(caps.includes(name), `能力表缺少 ${name}`)
  }
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
