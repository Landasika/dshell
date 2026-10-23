# P2 — DSH Client Adapter 与契约封装

**目标**：让 TUI 和 CLI 都不直接依赖 DSH 内部类型。DSH 升级后的改动尽量收敛在 `src/adapter/`。

## 工作包

- [ ] 定义 dshell 自有领域接口 `DshellBackend`：connect/disconnect、能力信息、Workspace/Session 操作。
- [ ] 定义 `SessionHandle`：subscribe snapshot、loadOlder、send/queue、cancel、dispose。
- [ ] 引入官方 Connection、Gateway、React-free Session/Workspace Client Model，明确可用 Node 导出。
- [ ] 在适配层统一错误与认证状态：auth-required、disconnected、unsupported-capability、permission-denied。
- [ ] 客户端连接代际（generation）变化触发模型重建；不自行重写 durable log Reducer。
- [ ] 独立测试 Event → Presentation 模型在历史分页、Streaming、完成时的一致性。
- [ ] 接入用户交互（approval / ask-user）和请求失效处理；用户断开时不得自动允许。
- [ ] 用 FakeBackend 完成上层可测试性。
- [ ] 提供 capability probing / 显式支持版本判定，而不是对任何 Host 乐观兼容。

## 推荐的 TypeScript 接口草图（不是 DSH 原生 API）

```ts
interface DshellBackend {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getCapabilities(): Promise<DshellCapabilities>
  listWorkspaces(): Promise<WorkspaceSummary[]>
  listSessions(workspaceId?: string): Promise<SessionSummary[]>
  createSession(options: CreateSessionOptions): Promise<SessionHandle>
  openSession(id: string): Promise<SessionHandle>
}

interface SessionHandle {
  subscribe(listener: (snapshot: SessionView) => void): () => void
  send(prompt: string): Promise<void>
  cancel(): Promise<void>
  loadOlder(): Promise<void>
  dispose(): void
}
```

## 验收标准

纯文本测试 CLI 和模拟 TUI 都只依赖 `DshellBackend`；替换 Adapter 内部 DSH Client Model 后，上层业务测试无需改动。API 无法兼容时清晰失败。
