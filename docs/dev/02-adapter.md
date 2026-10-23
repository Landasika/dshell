# P2 — DSH Client Adapter 与契约封装（完成）

- 状态：**完成（list/attach/prompt 适配层）**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/02-adapter.md`](../development/02-adapter.md)
- P0 结论：[`00-feasibility.md`](./00-feasibility.md)

## 1. 边界

CLI/TUI 只依赖 `src/backend/types.ts`，不直接 import DSH 类型、WebSocket、
`socket-client` 的协议消息，也不重写 durable log reducer。

```text
CLI / TUI
   ↓
DshellBackend  (src/backend/types.ts)
   ├─ SocketBackend  → dshell-host NDJSON
   └─ FakeBackend    → 内存事件流（测试）
```

P0 已确认官方 `session-controller/client` 是 browser bundle，在 Node 中导入会触发
`window is not defined`。因此 P2 的“DSH 适配”落在 **Host 内插件 + 自有协议**
上，而不是在客户端直接加载 React/browser client graph；这是对 P0 结论的落实，
不是绕开适配层。

## 2. 领域接口

`DshellBackend`：

```ts
interface DshellBackend {
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly connected: boolean
  capabilities(): DshellCapabilities
  listWorkspaces(): Promise<WorkspaceSummary[]>
  listSessions(workspaceId?: string): Promise<SessionSummary[]>
  createSession(options?: CreateSessionOptions): Promise<SessionHandle>
  openSession(sessionId: string): Promise<SessionHandle>
}
```

`SessionHandle`：

```ts
interface SessionHandle {
  readonly id: string
  readonly header: SessionHeader
  subscribe(listener: (view: SessionView) => void): () => void
  snapshot(): SessionView
  send(text: string, options?: SendOptions): Promise<SendReceipt>
  cancel(reason?: string): Promise<void>
  loadOlder(limit?: number): Promise<boolean>
  answerApproval(requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>
  dispose(): void
}
```

`SessionView` 同时携带：

- durable events（历史真相）；
- `streamText`（当前 process-local 流式文本，仅展示）；
- `status`；
- `pendingApproval`（若存在）。

## 3. 能力与错误

统一错误 `BackendError.code`：

- 连接类：`HOST_NOT_RUNNING`、`SOCKET_PERMISSION_DENIED`、`NOT_CONNECTED`；
- 协议类：`PROTOCOL_MISMATCH`、`PLUGIN_MISSING`；
- 领域类：`SESSION_NOT_FOUND`、`SESSION_DISPOSED`、`APPROVAL_NOT_PENDING`；
- 能力类：`UNSUPPORTED_CAPABILITY`；
- 请求类：`BAD_REQUEST`、`REQUEST_TIMEOUT`。

`capabilities()` 从 Host `welcome` 推导；P2 明确把 `createSession`、`cancel`、
`steer`、`paging`、`approvals` 标为不可用，而不是乐观返回 `true`。
P3 会在插件协议真正支持后逐项打开。

## 4. 传输细节

- `SocketBackend` 用一个 control connection 做 `list`；
- 每个 `openSession` 使用独立连接，避免 P1 单 socket 只能 attach 一个 Session 的限制；
- `SocketSessionHandle` 在 `attached` 前缓冲消息，按 `cursor` 过滤重复历史；
- durable event 按 `seq` 去重；
- `assistant-stream` 只累积到 `streamText`，`assistant/message` 到达时清空；
- `dispose()` 只关闭本地连接，不 dispose Host Agent；
- `FakeBackend` 提供可预测的 `turn/start → user/message → assistant/message → turn/end`
  事件序列，并有 `askApproval`/`answerApproval` 测试入口。

## 5. CLI 迁移

`list`、`attach`、`prompt` 已改为只使用 `DshellBackend`：

- `list` → `backend.listSessions()`；
- `attach` → `backend.openSession()` + `subscribe()`；
- `prompt` → `openSession()` + `subscribe()` + `handle.send()`；
- `doctor` 仍保留底层 socket 诊断，因为它要报告路径/权限/握手细节。

因此替换 Adapter 内部实现时，上层命令无需改动。

## 6. 验收

| 计划验收项 | 结果 |
| --- | --- |
| 定义 `DshellBackend` / `SessionHandle` | 完成 |
| 统一认证/断线/能力错误 | 完成 |
| 不直接依赖 DSH 内部类型 | CLI 已做到；DSH 类型只在 Host 插件侧 |
| FakeBackend | 完成 |
| 文本 CLI 只依赖 Backend | 完成 |
| Event → Presentation 一致性 | `snapshot` + `subscribe` 统一从 durable event 生成 |
| 历史分页 / cancel / approval | 接口已定义，P2 明确返回 `UNSUPPORTED_CAPABILITY`；P3 实现 |

测试：`pnpm test` 共 **9** 个通过，其中 P2 新增 3 个：

- FakeBackend workspace/session/stream/approval；
- SocketBackend list/attach/prompt/stream；
- unsupported capability 的明确错误。

## 7. 已知限制

1. P2 的 `SocketBackend` 仍使用 P1 协议，`createSession`/`cancel`/`loadOlder`/`answerApproval`
   只是清晰失败，不是完整可用。
2. 一个 Session 的多个 view 仍共享一个连接；P3 的多 Session 订阅会在此基础上扩展。
3. `streamText` 对未知 chunk 类型只做 best-effort，最终以 `assistant/message` 为准。

P3 将补齐协议 v2、Workspace/Session 创建、历史分页、cancel/steer、审批桥接。
