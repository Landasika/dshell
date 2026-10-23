# P0 — 连接与 API 可行性验证

**目标**：在写 TUI 之前证明“独立 Node.js 客户端 + DSH Host”可以构成完整、可恢复的双进程 Agent 体验。

## 工作包

- [ ] 固定一个可复现的 DSH tag/commit 和 Node.js 版本；记录实际运行环境。
- [ ] 盘点 DSH 公开入口与依赖：Connection、API Gateway、Session/Workspace Client Model、交互 Request。
- [ ] 验证 Node.js ESM 下加载 Client Plugin Graph；梳理其对 Browser-only 模块的依赖。
- [ ] 建立认证连接、断开、重连；验证非浏览器 Client 的权限与可交互授权。
- [ ] 访问 Workspace / Session 列表，创建并发送 Prompt。
- [ ] 读取历史、Follow 实时事件，检查游标、基线、增量、事件顺序、取消与恢复。
- [ ] 验证跨客户端审批：两个 Client 同时看到审批，其中一个提交后另一个正确失效。
- [ ] 关闭客户端进程，确认 Host 存活时任务继续；重连后回放历史。
- [ ] 决定最小 Host 插件是否必要。优先使用原生 DSH API。

## 交付物

- 最小 PoC：无 TUI，仅连接、创建 Session、接收流、断开重连。
- `docs/research/dsh-api-inventory.md`：已验证的 package export/API 与调用样例。
- `docs/research/compatibility-risks.md`：公开/内部接口分类和断线/权限风险。
- 下一阶段的 Go/No-Go 决策。

## 验收标准

在两个独立 Node.js Client 进程中，对同一 Host 完成创建 Session、发送、接收完整结果、客户端退出、重连、继续读取；验证一项需要用户交互的请求按 Host 权限策略处理。**如果审批/授权不可用，不进入 P4 UI 开发。**

## 注意

DSH 文档存在 Node Client/Connection 扩展方向，但具体导出、鉴权和跨版本稳定性必须以本阶段 PoC 为准。不能因为有 `client` 路径就认为 Node 环境全部可用。
