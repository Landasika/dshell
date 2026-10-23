# find/ — P0/P1 实测、设计输入与实现记录

这里存放 P0 的实测结果、API 清单和兼容性风险。**不修改 `docs/development/`**；所有新结论先落在这里。

| 文件 | 内容 |
|---|---|
| [`P0.md`](./P0.md) | P0 执行计划 + 实测结论 + Go/No-Go |
| [`p0-report.md`](./p0-report.md) | 逐项测试记录（T01–T22） |
| [`dsh-api-inventory.md`](./dsh-api-inventory.md) | 认证、RPC/stream envelope、endpoint、event、错误码 |
| [`compatibility-risks.md`](./compatibility-risks.md) | 风险分级、证据、缓解方案 |
| [`architecture.md`](./architecture.md) | 一个 Host + Web/CLI 两个前端的架构、socket 协议、里程碑 |
| [`p1-revision.md`](./p1-revision.md) | P1 修订：Linux 优先、单包双入口、插件安装与 attach 契约 |
| [`p1-implementation.md`](./p1-implementation.md) | P1 scaffold 实现记录、验收证据、与设计差异、已知问题 |

配套 PoC 在仓库根目录的 `poc/`：

- `poc/p0-client.mjs`：raw HTTP + WebSocket 的 Node 探针；
- `poc/import-check.mjs`：官方包 Node 导入检查；
- `poc/dshell-host/`：挂进 dsh Host 的 Unix socket 插件（spike）；
- `poc/dshell-cli.mjs`：attach 到该 socket 的最小 CLI（spike）；
- `poc/README.md`：启动 Host 和运行探针的步骤。

## 最短结论

- **P1 scaffold：已实现**。`@landasika/dshell@0.1.0` 的 CLI + Host 插件已在本机真实 Host 上通过 `doctor/list/attach/prompt`，并验证 Web/CLI 同会话。
- **交互式 TUI：Go**。认证、session、stream、approval allow/reject、history、reconnect、cancel 都有实测。
- **`-p`：No-Go**。没有 answerer 时审批不会 fail closed，会无限悬挂。
- **P2：不要 import `@deepseek-ai/dsh-api-session-controller/client`**。它是浏览器 bundle；用 `session-controller/remote` + 自建 store。
- **握手**：裸 HTTP 路径没有握手；P1 的 Host 插件已经有 `hello/welcome` 版本与能力协商。

## 安全提醒

`.p0/url`、`.p0/cookies.txt`、`.p0/dsh-home/` 含 owner 凭据或本地状态，已 gitignore。不要提交、截图、粘贴到聊天或日志里。
