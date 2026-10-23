# P0 — 连接与 API 可行性验证（完成）

- 状态：**完成**
- 完成时间：2026-10-23
- 验收结论：**Conditional Go**
- 原始计划：[`docs/development/00-feasibility.md`](../development/00-feasibility.md)
- 证据索引：[`find/P0.md`](../../find/P0.md)、[`find/p0-report.md`](../../find/p0-report.md)、[`find/dsh-api-inventory.md`](../../find/dsh-api-inventory.md)、[`find/compatibility-risks.md`](../../find/compatibility-risks.md)

## 1. 环境

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.2` |
| Node.js | `v24.21.0` |
| OS | Ubuntu 24.04.3 LTS, Linux x64 |
| Host profile | `web` |

DSH 以本机缓存 runtime 的绝对路径启动；没有修改 DSH 源码，也没有把 DSH Runtime 复制进 dshell。

## 2. 已验收的链路

- `GET /connect?token=...&interactions=answer` 返回 302 + `dsh-auth-*` Cookie；
- 无 Cookie、旧 Cookie、关闭 socket 后请求均返回 401；
- Host 重启后 token/Cookie 失效，但 Session 日志保留；
- 通过 WebSocket `$events` 读取 `item.value` 包装的转发帧；
- `session/list` / `session/page` / `session/follow` 可以列 Session、读历史、跟随增量；
- 在独立 Node.js 进程中创建 Session、发送 Prompt、接收完整结果；
- 关闭客户端后 Host 与任务继续；重连后可以回放历史；
- `interactions=none` 不能打开 `$events`，但原始 `session/follow` 可用；
- 两个客户端同时看到审批请求；第一个回答生效，另一个收到 `cancel`；
- 客户端断开后，待审批请求保留并可重新投递；
- **没有 answerer 时审批会一直挂起**（实测 90s），Host 不会自动 fail-closed；
- `headless` profile 不含 `client-connection` / `session-controller` / `api-remotes`；
- 官方 `session-controller/client` 导入会触发 `window is not defined`，不能在 Node 中直接使用。

## 3. 决策

- **Interactive TUI / P4：Go**；可以基于 Host 内插件 + Unix socket 实现。
- **`-p` 非交互模式：No-Go（暂缓）**，直到审批桥接具备超时 fail-closed。
- **官方 browser client bundle 直接用于 Node：No-Go**。
- **最小 Host 插件：必要**；纯 HTTP/WS 客户端无法满足无 token、同进程 Agent、审批同源等要求。
- V1 只支持 Linux；socket 访问控制依赖 `0700` 目录 + `0600` socket + 同 UID。

## 4. 验收对照

| 计划验收项 | 结果 |
| --- | --- |
| 固定 DSH/Node 版本并记录环境 | 完成 |
| 盘点公开入口与依赖 | 完成，见 API inventory |
| Node ESM 加载 client graph | 部分可用；browser-only 模块不可直接用，改走 Host 插件 |
| 认证连接、断开、重连 | 完成 |
| Workspace/Session 列表、创建、Prompt | 完成（Workspace 通过 Session cwd 归组） |
| 历史、Follow、游标、事件顺序 | 完成 |
| 跨客户端审批 | 完成；但无 answerer 时挂起是风险 |
| 关闭客户端任务继续、重连回放 | 完成 |
| 判断最小 Host 插件是否必要 | 必要，已决策 |

## 5. 遗留风险

1. 无 answerer 时审批挂起，P2/P3 必须补 fail-closed。
2. `session/page` 的 `maxMessages` 是消息/轮次对齐，不是记录数。
3. Host 重启会使 token/Cookie 失效；CLI 不能用 token 方案。
4. 同一 Session 不能被两个 Host 同时写；CLI 必须 attach，不得自行 spawn Host。

## 6. 结论

P0 的 Go 条件是：**审批桥接必须补上，且非交互模式不得在审批语义未完成前宣称可用**。该条件在后续 P3/P5 中落实。
