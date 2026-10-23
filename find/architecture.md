# dshell 架构：一个 Host，两个前端

## 目标

`dshell` 不是一个“更漂亮的 DSH 启动器”，而是 DSH Host 的第二个前端：

```text
                    ┌──────────────────────────────┐
                    │        dsh Host (one)        │
                    │                              │
  Web browser ──────┤  ctx.agents / ctx.sessions   │
                    │  ctx.sessionQuery            │
  dshell CLI  ──────┤  ctx.approval / ctx.terminals│
                    │  dshell-host plugin          │
                    └──────────────────────────────┘
```

Web 和 CLI 操作的是同一份 Session 日志、同一个 live `Agent`。不是两个 Host，也不是“CLI 通过 HTTP 再登录一次”。

## 为什么必须是一个 Host

- `ctx.agents` 是**进程内**的 live Agent 注册表；同一个 Session 不能由两个进程同时驱动。
- Session 日志是 single-writer；两个 Host 同时写同一 Session 会产生无法合并的冲突。
- Web 已经持有 live Agent 时，CLI 只需要拿到同一个 `Agent` 的引用，不应该 `resume` 出第二个。
- 审批、终端、任务、todo 都是 Host 服务；CLI 绕开 Host 就会丢失这些能力。

因此 `dshell` 启动时只做两件事：

1. 找到已经运行的 Host 的 Unix socket；
2. attach 上去。

找不到 socket 时明确报错，**不自动 spawn 第二个 Host**：

```text
没有找到运行中的 dsh Host；请先启动 dsh --profile web
```

## 组件

### 1. `dshell-host`（DSH 插件）

在 Host 启动时由 profile 加载，负责：

- 在 `$DSH_HOME/run/dshell.sock` 监听 Unix socket（`0600`）；
- 接受 CLI 连接，处理 `hello` / `list` / `attach` / `detach` / `prompt`；
- 对 live Session 直接 `ctx.agents.get(sessionId)`；
- 对冷 Session 才 `ctx.agents.resume({ resumeSessionId })`，并由插件持有 handle；
- 订阅 `session/event`，把 durable event 转发给 attach 的 CLI；
- 订阅 `agent/assistant-stream`，把 process-local 流式帧转发给 attach 的 CLI；
- CLI 断开时只移除订阅，**不 dispose Agent**；
- 插件卸载时才 dispose 自己 resume 出来的 handle。

当前 spike 代码：`poc/dshell-host/`。

### 2. `dshell` CLI

CLI 是纯前端：

- 连接 socket，发 `hello`；
- `list` 看 Session；
- `attach <sessionId>` 看历史 + 实时事件；
- `prompt <sessionId> <text>` 向同一个 live Agent 发一轮输入；
- 后续的 TUI 渲染、输入框、审批卡片都只在这一层做。

当前 spike 代码：`poc/dshell-cli.mjs`。

## Socket 协议（spike 版）

NDJSON，一行一个 JSON 对象。

客户端 → Host：

```json
{"type":"hello"}
{"type":"list"}
{"type":"attach","sessionId":"session-..."}
{"type":"detach"}
{"type":"prompt","sessionId":"session-...","text":"..."}
```

Host → 客户端：

```json
{"type":"welcome","protocol":1,"socketPath":"...","sessions":[...]}
{"type":"sessions","sessions":[...]}
{"type":"attached","sessionId":"...","header":{...},"cursor":21,"events":[...]}
{"type":"accepted","sessionId":"...","requestId":"...","mode":"queue"}
{"type":"event","sessionId":"...","event":{...}}
{"type":"stream","sessionId":"...","frame":{...}}
{"type":"status","sessionId":"...","status":"running"}
{"type":"error","code":"...","message":"..."}
```

设计约束：

- durable truth 是 `session/event`，不是 `assistant-stream`；
- `assistant-stream` 只用于即时显示，断线后必须能靠 `attached` 的 history 恢复；
- CLI 的 `prompt` 目前等价于 `agent.followup()`，后续要加 `queue` / `steer` 模式；
- 所有消息都带 `sessionId`，为以后一个 CLI 同时看多个 Session 留位置。

## 生命周期

```text
Host boot
  └─ load dshell-host
       ├─ create socket
       └─ subscribe session/event, agent/assistant-stream

CLI start
  └─ connect socket
       ├─ hello -> welcome(sessions)
       ├─ attach -> attached(history)
       └─ prompt -> accepted + event/stream...

CLI exit
  └─ remove subscription only
       └─ Agent keeps running in Host
```

关键点：**Agent 的所有权在 Host 插件，不在 CLI 连接**。否则 CLI 一断，长任务就被杀掉，Web 端也会丢 Agent。

## 审批

当前 spike **还没有实现 CLI 审批回答**。

- `dsh-user-approval` 的请求是 `approval/request` waterfall；
- Web 的 `dsh-api-approvals` 已经是 answerer；
- CLI 现在只能通过 `session/event` 看到 `approval/asked`，不能回答；
- 在 CLI 审批做出来之前，需要审批的工具仍然由 Web 回答；如果 Web 不在，按 DSH 的 fail-closed / 悬挂语义处理。

下一步要做的不是“CLI 自己再答一次”，而是：

1. 让 Host 插件成为 approval 的一个 answerer；
2. 请求同时推给 Web 和 CLI；
3. 第一个回答生效，另一个收到 `cancel`；
4. 用 `eventId` 做幂等，避免重复回答；
5. 超时后 fail closed，而不是无限等。

## 冷 Session

```text
attach(sessionId)
  ├─ ctx.agents.get(sessionId) 有值 -> 直接用
  └─ 无值 -> ctx.agents.resume({ resumeSessionId })
               └─ 插件保存 handle
```

不能在 Web 已经 live 的情况下再 `resume` 同一个 id；`dsh-agent` 会拒绝重复 live id。所以顺序必须是“先 get，再 resume”。

## 平台范围

V1 只支持 **Linux**：

- Unix domain socket、`0600` 权限、stale socket 行为只在 Linux 上验证；
- 不承诺 macOS、Windows；
- Windows named pipe 和 macOS 兼容放到后续版本。

## 安全

- socket 权限 `0600`，只允许同一 UID；
- 不引入 token / Cookie 给 CLI；
- 依赖 Unix domain socket 的进程边界，而不是网络回环；
- 不在日志、提交、截图里出现 Host URL 的 token；
- 后续可以加 `SO_PEERCRED` 校验，明确拒绝不同 UID。

## 已验证的最小闭环

在 DSH `0.2.1-rc.2`、本地 `.p0/dsh-home`、`web` profile 上：

1. Web API 创建 Session；
2. `dshell-host` 加载并监听 socket；
3. CLI `list` 看到同一个 Session；
4. CLI `prompt` 后，Web 侧 `session/follow` 读到同一条 `user/message` 和 `assistant/message`；
5. Web API `prompt` 后，CLI `attach` 实时收到 `user/message`、`assistant/message`、`turn/end`；
6. CLI 断开后 Session 仍然 live，Web 仍可继续。

这证明了“一个 Host + 两个前端”的主路径可行。

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | socket + list/attach/prompt + 双向事件 | 已完成（spike） |
| M2 | 审批、cancel/steer、status、错误恢复 | 待做 |
| M3 | TUI：历史渲染、输入、工具卡片、流式 | 待做 |
| M4 | 打包为 `@scope/dshell`，提供 `dshell` bin 和 profile 安装 | 待做 |
| M5 | 重连、多客户端、权限校验、版本握手 | 待做 |

## 非目标

- 不做第二个 Host；
- 不把 Web 的 `session-controller/client` 浏览器 bundle 硬塞进 Node；
- 不假设 `assistant-stream` 是 durable transcript；
- 不在 CLI 里复制一套 Agent 生命周期。
