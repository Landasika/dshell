# Esc 后继续队列

日期：2026-11-04。接续[用户流程审查](./2026-11-04-user-journeys.md)。本轮修复用户反馈：“已有排队语句，按 Esc 停止当前回答后，为什么不接着处理下一条？”所有实现改动位于 dshell，没有修改 DeepSeek Harness 源码或用户已安装的 runtime，也没有重启用户正在运行的 Host。

## 问题与源码依据

原先 Esc 经 TUI `cancelRunningTurn()` 调用普通 `handle.cancel(false)`，插件直接执行 `agent.cancel({kind:'user'})`。上游 `packages/core/agent-loop/src/agent.ts` 的真实实现先清空 inbox，再 abort 当前 activity；所以取消当前回答也会丢弃队列。此前测试 double 的 cancel 没有模拟清空，掩盖了该问题，本轮已修正。

原 `/cancel` 则缓存客户端可见队列的文本，取消后重新发送。这与 Esc 不一致，还会更换消息 ID，无法完整保留结构化附件，并可能重复提交或与另一前端的队列产生分歧。

只加 `keepInbox:true` 仍不够：上游会保留待处理消息，但在当前 activity abort 后将其停放，直到下一次 waking input 才继续。核对的是 `cancel()`、`send()`、`wakeDriver()`、driver 的 `finally`，以及 `inbox.claim()` 的实际控制流，并参考了上游 `cancel.spec.ts` 对 parked queue 和 abort-to-idle window 的执行断言。源码快照为 `687f282e8625c6b8d11ff58211a90524be2e4317` 与 `8bd073392eef6f54e921a093b95076248eb08cbb`；未依据注释推断行为。

## 修复后的行为

- Esc 与 `/cancel` 统一为停止当前轮，保留并顺序继续原有待处理消息。未发送的草稿保留，子 agent 按原有 Esc 约定继续运行。
- TUI 不再缓存文本并逐条重发。Host 优先调用 session controller 的取消入口，保留 inbox；随后移出尾部一条原消息并通过 Agent 的 waking input 入口放回原尾位置。这会在旧 activity 收敛后唤醒 driver，保留消息对象、ID、附件及 FIFO。没有额外插入用户问题，也没有用定时轮询触发。
- 有 queued turn 时只对最后一条 queued 消息执行一次唤醒，steering 交由上游在下一次边界领取；只有 steering 时使用原 steering 消息唤醒。
- 慢取消期间同一 handle 的重复 Esc 只发一次请求。迟到结果不会覆盖另一个会话的界面；取消失败或超时显示“未确认停止”，不会假报成功。
- 新增 `cancel-continue` 能力和 `session/cancel.continueQueued` 选项。旧 Host 没有该能力时客户端明确提示重新加载插件，不发送会清空队列的降级请求。普通不带选项的取消、CLI 退出和 Ctrl-C 的完整停止语义保留。
- 修正真实 Host 消息 ID 与 `source.rpcId` 不同造成的重复队列行、已开始消息仍残留在队列中的问题。显示时关联两种身份，队列编辑仍使用 Host 消息 ID。

该实现使用现有 owner/Agent/Inbox 入口，未访问私有 driver 方法。由于上游没有独立的公开 wake 操作，唤醒依赖公开消息入口对 abort 后输入的处理；这条兼容边界由真实 Host 验证覆盖。尾部移出再放回会产生持久 inbox splice，因此不应把它解释为“完全没有队列事件”。

## 验证

自动回归覆盖 Esc 与 `/cancel`、多个 pending FIFO、其他前端入队、原对象和图片附件保留、steering-only、取消 owner 拒绝、旧 Host 能力缺失、慢取消连按 5 次 Esc、草稿保留，以及 Host 生成独立消息 ID 后的队列去重和执行后移除。

真实端到端使用只读 DSH `0.2.1-rc.2` runtime、Node `v24.21.0`、独立临时 `DSH_HOME` 和本地 HTTP SSE 模拟模型。真实 `runTui` 发出按键，经 socket backend、编译插件和真实 agent loop 完成取消与后续轮次。模型的首条请求保持流未结束，确保验证的是取消，随后两条正常响应：

| 手势 | 当前请求 | 后续两条 | 顺序与身份 | 最终状态 |
| --- | --- | --- | --- | --- |
| Esc | `aborted`，原因 `user` | 均 `completed`，各处理一次 | FIFO，原 requestId 与 Host message ID 保留 | idle，inbox 为空 |
| `/cancel` | `aborted`，原因 `user` | 均 `completed`，各处理一次 | FIFO，原 requestId 与 Host message ID 保留 | idle，inbox 为空 |

自动测试与真实 Host 的范围不同：图片附件保留由插件集成测试断言原消息对象覆盖，真实 Host 脚本使用文本问题。本轮没有调用外部模型或执行真实工具审批。

最终验证结果和复现入口见 [queue-verification.md](./2026-11-04-evidence/queue-verification.md)、[真实 Host 脚本](./2026-11-04-evidence/queue-real-host.mjs) 与 [运行输出](./2026-11-04-evidence/queue-real-host.json)。当前进程中已加载的旧插件需要更新并重新加载后才采用新行为；本轮没有自动部署到用户的 Host。
