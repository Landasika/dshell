# P3 — Session Core：Workspace、Session、Cancel/Steer 与审批桥（完成）

- 状态：**完成**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/03-session-core.md`](../development/03-session-core.md)
- 前置阶段：
  - P0 [`00-feasibility.md`](./00-feasibility.md)
  - P1 [`01-packaging.md`](./01-packaging.md)
  - P2 [`02-adapter.md`](./02-adapter.md)
- PR：[Gitea #4](http://192.168.8.77:3000/Landasika/dshell/pulls/4)
- 证据：`find/p3-evidence.md`

## 1. 这一阶段解决什么

P2 已经证明：一个运行中的 dsh Host 可以通过 Host 插件暴露 Unix socket，
`dshell` CLI 可以 `list` / `attach` / `prompt`，并且流式输出与 durable event
都来自同一个 Host。但 P2 只打开了最小协议：

- 不能建 Workspace / Session；
- 不能分页读历史；
- 不能 cancel / steer；
- 不能回答审批；
- 一个 socket 只 watch 一个 Session。

P3 把 Host 内的 **Session Core** 补齐，并保持 P1 的核心约束：

> 一个 Host 拥有所有 live Agent；Web 和 CLI 只是两个前端。CLI 断线只能取消订阅，
> 不能 dispose Host 的 Agent。

## 2. 架构位置

```text
dsh --profile web
  ├─ DSH Web UI ───────────────┐
  ├─ ctx.agents / sessions ────┤
  ├─ ctx.workspaceRegistry ────┤
  ├─ ctx.sessionQuery ─────────┤
  ├─ ctx.approval ─────────────┤
  └─ @landasika/dshell (Host 插件)
        ├─ dshell.sock (NDJSON v2)
        ├─ watched: Socket → Set<SessionId>
        ├─ handles: SessionId → AgentHandle
        └─ approval bridge
              ↑
        dshell CLI（list/attach/prompt/steer/cancel/new/workspaces）
```

CLI 没有 token、没有 Cookie、没有 WebSocket。它只通过 `$DSH_HOME/run/dshell.sock`
与同一个 Host 通信；socket 目录 `0700`，socket 文件 `0600`。

## 3. 协议 v2

`PROTOCOL_VERSION = 2`。新增能力：

```text
list, attach, prompt, event, stream, status,
workspaces, create-session, history, cancel, steer, approval
```

### 3.1 Client → Host

| 消息 | 作用 |
| --- | --- |
| `hello {protocol}` | 握手；版本不匹配返回 `PROTOCOL_MISMATCH` |
| `list` / `session/list` | 列出 Session |
| `workspaces` | 列出 Workspace |
| `workspace/create {path,title?}` | 创建/复用 Workspace |
| `session/create {cwd?,workspaceId?,title?}` | 新建 Session 与 live Agent |
| `attach {sessionId}` | 订阅并返回当前历史 |
| `watch` / `unwatch {sessionId}` | 多 Session 订阅/退订 |
| `detach {sessionId?}` | 退订；不带 id 则清空 |
| `session/history {sessionId,before?,limit?}` | 历史分页 |
| `prompt {sessionId,text,mode?:'queue'\|'steer'}` | 新 turn 或 steer |
| `session/cancel {sessionId}` | 取消当前 turn |
| `approval/answer {requestId,outcome}` | `allowed-once` / `rejected` |
| `ping` | 存活探测 |

### 3.2 Host → Client

`welcome`、`pong`、`sessions`、`workspaces`、`attached`、`history`、`detached`、
`session-created`、`accepted`、`cancelled`、`event`、`stream`、`status`、
`approval-request`、`approval-resolved`、`error`。

关键语义：

- `accepted` 先于任何 `turn/start` 发送，避免 CLI 先看到事件、后看到 ack；
- `event` 是 durable `session/event`，`stream` 是 process-local 的
  `agent/assistant-stream`，后者只用于展示；
- `approval-request` 的 `requestId` 是 **Host 桥接层生成的 id**，不是 durable
  `approval/asked` 事件里的 id；CLI 只能用前者回答；
- 所有错误走 `error {code,message,action?}`，错误码与 `BackendErrorCode` 对齐。

## 4. Host 插件实现

### 4.1 多 Session 订阅

P1/P2 的 `attached: Map<Socket, sessionId>` 被替换为：

```ts
const watched = new Map<Socket, Set<string>>()
```

`attach`/`watch` 加入，`unwatch`/`detach`/断开移除；事件按
`sessionId → watchers` fanout。一个 CLI 连接可以同时 watch 多个 Session，
不同 CLI 可以 watch 同一个 Session。

### 4.2 Workspace 与 Session 创建

- `workspaceRegistry.list()` 映射为 `WorkspaceSummary`；
- `workspaceRegistry.create(path,title)` 负责 canonical path；
- `agents.create({sessionId,meta:{cwd,agentPreset?},agentOptions,setup})`
  创建 live Agent；
- 创建后调用 `workspace.attachSession(sessionId)`，让 Web 工作区也能看到；
- `session-created` 返回 header + workspaceId；
- `new` 不传 cwd 时，CLI 显式发送 **CLI 自己的 cwd**，不使用 Host 的
  `process.cwd()`（Host 与 CLI 可能在不同目录）。

### 4.3 历史分页

`sessionQuery.readSession(id)` 给出完整事件；`session/history` 按
`before`（不含）向前取 `limit` 条，返回 `cursor` 和 `hasMore`。
`attach` 仍返回当前完整历史，保证 P2 行为不退化；分页供 TUI/大历史使用。

### 4.4 Cancel / Steer

- `session/cancel` 只对 `ctx.agents.get(id)` 的 live Agent 调用
  `cancel({kind:'user'})`；cold Session 不 resume，返回 `cancelled` no-op；
- `prompt` 的 `mode:'steer'` 调用 `agent.steer(message)`，否则
  `agent.followup(message)`；
- `steer` 只在 turn 运行时有意义，CLI 会先检查 `status === 'running'`；
- cancel/steer 都不会 dispose Agent，后续 turn 仍可继续。

### 4.5 审批桥（本阶段最关键的部分）

DSH 的审批是 **agent-scoped waterfall**：

```text
ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, next)
```

Web UI 已经注册了一个 answerer，而且它在 listener 链里通常排在前面。
如果 Host 插件只是普通 `ctx.on(...)`：

1. 会被 scope filter 排除，根本收不到 agent 的审批；
2. 即使收到，排在 Web 后面也不会先执行，CLI 仍会卡住。

最终实现：

```ts
ctx.on('approval/request', handleApproval, {
  global: true,   // 绕过 agent scope filter
  prepend: true,  // 排在 Web answerer 之前
})
```

`handleApproval` 的逻辑：

1. 如果该 Session 没有 CLI watcher，直接 `next()`，完全保留 Web 行为；
2. 生成 `approval-<uuid>`，向所有 watcher 广播 `approval-request`；
3. 同时启动：
   - CLI 回答 promise；
   - `next()`（Web answerer）；
   - 超时计时器（默认 `120_000ms`，可由插件配置
     `approvalTimeoutMs` 覆盖）；
   - `request.signal` 的 abort 监听；
4. **first-answer-wins**：谁先返回谁决定；
5. 输家收到 `approval-resolved`，CLI pending 清空；
6. 超时、Host 关闭、最后一个 watcher 断开、request abort 都返回
   `unavailable`（fail closed），绝不自动 allow；
7. `answerApproval` 校验请求仍在 pending、且该 socket 正在 watch 该 Session；
   重复回答返回 `APPROVAL_NOT_PENDING`。

一个容易踩的坑：durable `approval/asked` 事件和 Host 的 `approval-request`
消息有 **两个不同的 id**。durable id 只用于审计，不能拿来回答；P3 的
`SocketSessionHandle` 只把 `approval-request` 的 id 作为可回答 id，避免把
历史里已经结束的审批当成 pending。

## 5. CLI 变化

新增/更新命令：

```text
dshell workspaces
dshell list [workspaceId]
dshell new [cwd]
dshell attach <sessionId>
dshell prompt <sessionId> <text...>
dshell steer <sessionId> <text...>
dshell cancel <sessionId>
```

行为：

- `workspaces` 打印 workspace id、session 数、title、path；
- `list` 可按 workspaceId 过滤；
- `new` 创建 Session 并打印 id 与 cwd；
- `prompt` 等待 `turn/end`，遇到审批时在 TTY 上询问
  `[a]llow once / [r]eject`；非 TTY 直接 reject（fail closed）；
- `steer` 要求当前 turn 正在运行，发送 next-step 消息并等待该 turn 结束；
- `cancel` 对 live Agent 发 cancel；cold Session 是安全 no-op。

## 6. 验收结果

### 6.1 自动化测试

`pnpm test`：**10/10 通过**。P3 新增/扩展：

- `SocketBackend supports history paging, steer, cancel, and approvals`
  - `loadOlder()` 取回更早事件并保持 `hasMore`；
  - `send(...,{mode:'steer'})` 的 `accepted.mode` 为 `steer`；
  - `approval-request` → `answerApproval` → `approval-resolved`；
  - `cancel` 消息路径；
- protocol v2 capability 列表；
- client welcome 版本断言更新为 2。

`pnpm typecheck`、`pnpm lint` 均通过。

### 6.2 真实 Host 验收

在 `.p0/dsh-home` 启动 `dsh --profile web --port 3111`，插件从本仓库
`dist/plugin` 加载，CLI 使用同一个 `DSH_HOME`：

| 场景 | 实际结果 |
| --- | --- |
| `dshell doctor` | protocol 2；capabilities 全部列出 |
| `dshell workspaces` | 创建前空；`new` 后出现 workspace |
| `dshell new <cwd>` | 打印 `session-...` 与 cwd |
| `dshell prompt` | `P3_OK`，`[turn] completed` |
| `dshell attach` | `cursor=21 history=22`，重放历史并持续监听 |
| 两个 Session 并发 prompt | A 得到 `A_OK`，B 得到 `B_OK`，两个都 live |
| 两个 CLI 同时 attach 同一 Session | 两个 watcher 都看到 `MULTI_WATCH_OK` |
| `dshell cancel` | 长回答在 `[turn] aborted` 结束 |
| `dshell steer` | `[steered]`，模型在下一条消息回复 `STEERED` |
| 审批 allow | `approval-request` → `allowed-once` → `tool/result` → `turn/end` |
| 审批 reject | `rejected` → `tool/result`（错误）→ `turn/end` |
| `dshell list <workspaceId>` | 正确过滤到该 workspace 的 14 个 Session |

审批 allow 的真实输出（截取）：

```text
[tool/call] bash ...
[approval] id=approval-4e80... tool=bash
[approval] allowed-once sent
[event] approval/decided
[event] job/registered
[event] tool/result
[event] turn/end
```

reject 的真实输出（截取）：

```text
[approval] rejected sent
[event] approval/decided
[event] tool/result
[event] turn/end
```

## 7. 已知限制

1. **CLI 仍是单前台命令**：一个进程执行一个 `prompt`/`steer`/`attach`；
   多 Session 的交互式切换留给 P4 TUI。
2. `attach` 仍一次性返回完整历史；`session/history` 已实现，但 CLI 还没有
   分页浏览命令。
3. 审批在文本 CLI 里是简单的 stdin 询问；没有 diff/参数预览、没有队列 UI；
   P4 做 TUI 审批面板。
4. 非 TTY 的 CLI 遇到审批会 **reject**，这是 P0 要求的 fail-closed 行为。
5. `dshell new` 不设置 Session title；`workspace/create` 的 title 由路径/参数决定。
6. 没有 archive/delete Session 的协议；P3 只做创建、读取、取消、steer。
7. 仍然只支持 Linux；socket 认证依赖 DSH_HOME 目录权限，尚未接入
   `SO_PEERCRED`。
8. 同一个 DSH_HOME 只允许一个 dshell Host；第二个 Host 会抛
   “another dshell host is already listening”。Cordis 只把它记为一条未激活
   entry，Web 仍可能启动——操作上不要启动第二个 Host。
9. Web 不会自动跟随 CLI 当前 Session；需要在 Web 里手动选择同一个
   `sessionId`。这是 DSH 现有前端行为，P3 不修改。
10. 审批输家（例如 Web 已答、CLI 仍 pending）依赖 durable
    `approval/decided` 清理 UI；CLI 同时会收到 `approval-resolved`。

## 8. 下一阶段（P4）

P4 将只做“更好用”，不改变 Session 所有权模型：

- 全屏 TUI：会话列表、消息流、输入框、状态栏；
- 多 Session 切换/并行 watch；
- todo / plan / subagent / tool 调用的结构化渲染；
- 审批面板：允许一次 / 拒绝 / 查看参数；
- 断线重连与会话恢复；
- 保留 `--json` / 非交互模式给 P5。

P3 已经提供 P4 需要的全部底层消息；P4 不应再改 Host 的 Agent 所有权。
