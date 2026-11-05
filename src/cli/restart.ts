/**
 * `dshell restart` 的确认策略。
 *
 * 单独成一个模块，是因为这段逻辑**必须能被测试覆盖**，而 `main.ts` 里的
 * 命令实现直接连真 Host、直接读 stdin，没法在单元测试里跑。
 *
 * 为什么这条命令要格外小心：Host 收到 `host/restart` 后立刻
 * `close()` + `process.exit(0)`，不等任何在跑的 turn 收尾。也就是说误触
 * 一次，别人的会话就断了——没有第二次机会，所以判定要保守。
 */

/** 用户对确认提示的回答是否算"同意"。 */
export function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

/**
 * 该不该真的执行重启。
 *
 * 三种情况：
 *
 * - 给了 `--yes`：直接执行（脚本/自动化用，调用方已明示同意）；
 * - 没给 `--yes` 且**不是 TTY**：拒绝。这里刻意不"默认同意"——CI 里
 *   一次误触就会打断别人的会话，而管道输入也没法回答提示；
 * - 其它：交给交互确认。
 */
export type RestartDecision =
  | { kind: 'proceed' }
  | { kind: 'confirm' }
  | { kind: 'refuse'; reason: string }

export function decideRestart(yes: boolean, stdinIsTTY: boolean): RestartDecision {
  if (yes) return { kind: 'proceed' }
  if (!stdinIsTTY) {
    return {
      kind: 'refuse',
      reason: 'restart needs confirmation, but stdin is not a terminal; pass --yes to run it unattended',
    }
  }
  return { kind: 'confirm' }
}
