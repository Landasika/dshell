# 用户流程、极端场景与复合故障验证

日期：2026-11-04。范围：dshell 的 Host 插件、socket backend、TUI 与 App 会话预览。接续 [全量审查](./2026-11-04-full-audit.md) 和 [落地记录](./2026-11-04-implementation.md)。所有修复位于 dshell；DeepSeek Harness 源码保持未修改。

后续补充：[Esc 后继续队列](./2026-11-04-queue-cancel.md) 记录了取消交互的进一步修复与真实流式请求验证；本文的 262 项结果保留为该阶段的历史记录。

## 切换模型与断连的结论

已经复现并修复 dshell 侧“保存成功但界面没有确认”“需要再操作一次”的状态问题。尚未复现用户现场导致 DSH 断开的原始触发条件，不能据此宣称已找到 Host 断连根因。

真实隔离 Host 使用 DSH `0.2.1-rc.2`、Node `v24.21.0`，通过全新临时 `DSH_HOME` 加载本地编译插件。Provider 指向不提供服务的本地端口，只执行控制操作，没有发送 LLM 请求：

| 场景 | 实测结果 |
| --- | --- |
| 单客户端交替切换两个模型 40 次 | 40 次成功，意外断连 0 次 |
| 两个客户端对同一会话各切换 50 次 | 100 次成功，意外断连 0 次 |
| 并发结束后再确认最终模型 | 两个视图一致显示最终模型 |
| 请求不存在的模型 | 正确拒绝，后续连接保持可用 |
| 关闭视图后重新 attach | 恢复 durable 模型选择，无需再切一次 |

并发实验共 101 次有效选择，约 1.2 秒完成包含建会话、非法请求及重新 attach 的控制流程。该时间是本机冒烟记录，不是吞吐量承诺。另在前一阶段的隔离 rc.3 Host 上完成 3 次串行模型选择，均未断连。

对上游实际实现的核对包括：`session-controller/src/commands.ts` 的 `selectModel` 调用链、`agent.ts` 的事件写入、`model-selection-projection.ts` 的状态推进、`agent-default-model` 的异步默认模型保存，以及 config editor 的 reconcile 行为。源码证据不足以支持“保存默认模型一定导致插件重载”的判断。

## 已复现问题与实现

| 问题 | 修复后的用户行为 |
| --- | --- |
| durable `model/selection` 已写入，控制 socket 在回执之前断开 | 自动重连后按 Host 状态恢复模型；无需自动重发或再次确认 |
| `model/selection` 原先降级为 diagnostic | 作为规范事件推进模型状态；其他前端的选择即时反映到 TUI |
| 慢切换期间连续 Enter | 同一会话、同一 attach 代次只保留一个切换请求 |
| 会话 A 的切换回执在打开 B 后迟到 | 不修改 B 的模型、状态或面板 |
| 旧请求的 `request/header` 晚于新的模型选择 | 旧请求不会消耗为下一次请求选择的模型；只有完全匹配的 header 才消耗 pending |
| 另一前端已改选模型，旧回执随后到达 | 更晚的 durable 选择优先；重连核对后显示当前模型，不自动覆盖另一前端 |
| 长会话的模型事件落在 opening page 外 | attach 携带 owner 的有效选择和 last-used 基线；旧 Host 从完整读取结果计算后再截尾 |
| last-used 基线被误当作 pending 选择 | 后续真实 request header 可以正常更新当前模型 |
| 用户等待模型切换时打开了其他面板 | 迟到回执只关闭原来的模型面板，保留当前面板 |
| 重连退避期间用户切换到另一会话 | 保留最新会话，不被旧重连任务拉回 |
| `/reconnect` 仅重建视图 | 同时恢复缺失的控制连接，可主动立即重连 |
| 退出期间存在待完成 attach 或重连 | 迟到 handle 被释放；退出后不再后台连接或启动轮询 |
| 历史搜索和 rewind 超过首屏后选中行不可见 | 可见窗口跟随选中项滚动 |
| 长问题正文只显示前三行 | 剩余正文与 detail 一起进入阅读窗口；翻页步长适配可见行数 |
| 20×6 终端把问题输入区裁出屏幕 | 紧凑布局保留问题阅读行、当前选项/动作及自定义回答光标；可输入和提交 |
| App 预览超时被缓存为空 5 分钟 | 超时不写入成功缓存；下一次未命中列表缓存时重新读取 |
| App 预览截断劈开 emoji，异常 text payload 被转成字符串 | 按 grapheme 截断；跳过无效文本和事件载荷 |
| owner `maxMessages` 被误解成事件条数 | attach 最多 500 条事件；history 最多请求条数（上限 200）。额外截尾后保留 `hasMore`，可继续补页 |

## 测试方式与覆盖

新增 `tests/user-journeys.test.mjs`，19 项用户流程测试。模型与断连场景使用真实 `SocketBackend`、`runTui` 和 Unix socket，故障由隔离 wire server 注入；每个 TUI 有独立 control/view 连接。通过解析 TerminalScreen 实际 ANSI 行更新检查当前屏幕与光标，避免仅靠累计输出中曾出现过的字符串误判恢复成功。

覆盖一次确认后回执丢失、重复 Enter、错误拒绝后重试、旧会话回执、旧请求 header、跨前端改选、长历史基线、连续三次视图断连、退出与迟到 attach、主动重连、重连时切换会话、历史搜索、长问题与最小终端。

复合故障测试在一次流程内叠加：模型 B 已提交但回执挂起 → 用户继续编辑 Unicode 草稿 → 另一前端选择 C → 终端缩至 20×6 → control/view socket 同时丢失 → 自动 reattach → 恢复终端尺寸。断言最终显示 C、未自动重发 B、草稿和光标仍在、只剩一个活动 handle。

其他集成测试补充了 RPC 超时后的迟到成功/错误隔离、旧 Host 无关联 ID 时超时关闭连接、owner projection 实际字段结构、旧 Host 的 700 条历史截尾、预览超时恢复/emoji/24 行预算，以及 owner 返回 1,200 条非消息事件时的分页。最后一个场景核对所有 seq，确认完整恢复且没有重复或遗漏；其输入特意模拟上游按消息数而非原始事件数分页的真实行为。

## 验证记录

- `pnpm typecheck`：通过。
- `pnpm test`：262 项通过，失败/跳过/取消均为 0。
- `scripts/verify-pack.sh`：构建、打包、临时目录安装、CLI 版本与插件导入验证通过。
- `git diff --check`：通过。
- 两个固定上游源码目录的 `git status --porcelain`：均为空。
- 只启动并停止自建的临时 Host；用户运行中的 Host、真实 profile 和已安装 DSH 保持未修改。

运行现有 `node --expose-gc scripts/bench-longsession.mjs`，1k/10k/50k 历史、每组 150 帧均完成。流更新中位数约 1.19/1.48/2.56 ms；50k 组观察到的 heap 增量约 9.3 MiB。脚本包含事件循环等待和固定 300 ms append 等待，不能把这些数字解释成纯渲染耗时或 append 延迟，也不代表多小时内存稳定性证明。

复现自动回归：

```bash
pnpm build
node --test tests/user-journeys.test.mjs tests/client.test.mjs tests/plugin-host.test.mjs
pnpm typecheck
pnpm test
./scripts/verify-pack.sh
```

原始最终验证摘要保存在同目录 `2026-11-04-evidence/user-journeys-verification.txt`。这些验证没有进行真实 LLM 生成、真实工具审批或用户环境 Host 重启。现场断连触发原因和付费模型完整请求链仍需现场证据；本轮结果证明的是已描述的控制流程、故障恢复和界面一致性。
