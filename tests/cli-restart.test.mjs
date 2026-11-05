/**
 * `dshell restart` 的确认策略测试。
 *
 * 这条命令是**不可逆且会打断别人**的：Host 收到请求就 `process.exit(0)`，
 * 不等在跑的 turn 收尾。所以测试重点不是"能不能重启"，而是
 * **在什么情况下必须拒绝执行**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { isAffirmative, decideRestart } = await import('../dist/cli/restart.js')

test('isAffirmative: y / yes 及其大小写与空白都算同意', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', 'Yes', '  y  ', ' yes\n', '\ty']) {
    assert.equal(isAffirmative(answer), true, `"${answer}" 应该算同意`)
  }
})

test('isAffirmative: 其他一律不算同意', () => {
  // 空回答必须是否定的：直接回车不能重启 Host。
  for (const answer of ['', ' ', '\n', 'n', 'no', 'N', 'nope', 'ye', 'yy', '1', 'true', 'y es']) {
    assert.equal(isAffirmative(answer), false, `"${answer}" 不该算同意`)
  }
})

test('decideRestart: --yes 直接执行', () => {
  assert.deepEqual(decideRestart(true, true), { kind: 'proceed' })
  // 非 TTY 时 --yes 依然生效：这正是脚本要用的路径。
  assert.deepEqual(decideRestart(true, false), { kind: 'proceed' })
})

test('decideRestart: 无 --yes 且非 TTY 必须拒绝', () => {
  const decision = decideRestart(false, false)
  assert.equal(decision.kind, 'refuse')
  // 拒绝理由要告诉用户怎么在无人值守下运行。
  assert.match(decision.reason, /--yes/)
  assert.match(decision.reason, /not a terminal/)
})

test('decideRestart: 无 --yes 且是 TTY 才走交互确认', () => {
  assert.deepEqual(decideRestart(false, true), { kind: 'confirm' })
})

test('decideRestart: 只有 TTY 交互这一种情况会问人', () => {
  // 穷举四种组合，确保没有"静默执行"的口子。
  const table = [
    { yes: true, tty: true, kind: 'proceed' },
    { yes: true, tty: false, kind: 'proceed' },
    { yes: false, tty: true, kind: 'confirm' },
    { yes: false, tty: false, kind: 'refuse' },
  ]
  for (const row of table) {
    assert.equal(decideRestart(row.yes, row.tty).kind, row.kind, `yes=${row.yes} tty=${row.tty}`)
  }
})
