# P0 实测报告

> 日期：2026-10-23
> Host：DSH `0.2.1-rc.2`，`dsh --profile web --no-open --port 3099`
> 客户端：`poc/p0-client.mjs`（独立 Node ESM 进程，raw HTTP + WebSocket）
> 说明：本文只记录已经实际执行的步骤；token、Cookie 值、真实 session id 已用占位符替换。

## 1. 目的

验证 [`P0.md`](./P0.md) 中的核心闭环：

```text
读启动 URL → /connect → Cookie → $events
  → 列 Session / Workspace → 建 Session → Prompt
  → 流式事件 → 审批 → 历史 → 断线重连 → Host 重启
```

P0 是 Go/No-Go 门槛，不是演示。重点不是“能发出请求”，而是：

- 认证是否可靠；
- 事件是否完整、有序；
- 审批是否可控（allow/reject/竞态/掉线）；
- 断线和重启后是否可恢复；
- 非交互模式是否安全；
- Node 能否使用官方客户端代码。

## 2. 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.2` |
| Node | `v24.21.0` |
| pnpm | `11.27.1` |
| OS | Ubuntu 24.04.3 LTS / Linux 6.8.0-147-generic x86_64 |
| Host | `dsh --profile web --no-open --port 3099` |
| `DSH_HOME` | `<repo>/.p0/dsh-home` |
| 地址 | `http://127.0.0.1:3099`，loopback，无 TLS |
| 探针 | `poc/p0-client.mjs` + `ws@8.22.0` |

npm dist-tag：

```text
latest = 0.0.1-rc.1
next   = 0.2.1-rc.2
alpha  = 0.2.1-alpha.5
```

## 3. 方法

1. 用 Host stdout 的 `dsh web:` URL 取 token。
2. 用 `fetch(..., {redirect:'manual'})` 处理 `/connect` 的 302，保存 `Set-Cookie`。
3. 用 `ws` 连接 `/api/remote.mux`，手动带 `Cookie` 头。
4. 用 HTTP RPC 调 `session/*`、`workspace/*`。
5. 用 `$events` 收 `ready`、`waterfall`、`emit`、`cancel`。
6. 每个场景结束后关闭 socket，观察 Cookie 失效与重连。
7. Host 重启用同一 `DSH_HOME`，验证 token 失效与 session 持久化。

## 4. 结果总表

| 编号 | 场景 | 结果 |
|---|---|---|
| T01 | 无 Cookie / 错误 token 的边界 | 通过 |
| T02 | `/connect` 换 Cookie | 通过 |
| T03 | `$events` ready | 通过 |
| T04 | `session/list` | 通过 |
| T05 | `session/create` | 通过 |
| T06 | `session/prompt` + 流式 | 通过 |
| T07 | `session/page` 分页 | 通过 |
| T08 | 审批 allow | 通过 |
| T09 | 审批 reject | 通过 |
| T10 | 双 answer 客户端竞态 | 通过 |
| T11 | answer 客户端掉线后的 pending | 通过（但行为是“悬挂 + 重投递”，不是 fail closed） |
| T12 | `interactions=none` 的 `$events` | 通过（被拒绝） |
| T13 | `none` 客户端触发审批 | **失败**（90s 未 fail closed） |
| T14 | 关 socket → 旧 Cookie 401 → 重连 | 通过 |
| T15 | 客户端退出，Host 任务继续 | 通过 |
| T16 | Host 重启 + 历史/恢复 | 通过 |
| T17 | `session/cancel` | 通过 |
| T18 | `workspace/create` + `workspace/follow` | 通过 |
| T19 | 版本探测 | 通过（结论：没有版本握手） |
| T20 | 官方包 Node 导入 | 部分失败（client model 是浏览器 bundle） |
| T21 | 两个独立进程同时连同一 Host | 通过 |
| T22 | `headless` profile 的 API 面 | 通过（确认没有 Host HTTP/API） |

## 5. 逐项记录

### T01 无 Cookie / 错误 token

命令：

```bash
curl -o /dev/null -w '%{http_code}\n' \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:3099/api/session/list \
  --data '{"type":"client-request","rpcId":"x","method":"session/list","payload":{"args":{"_request":{}}}}'

curl -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:3099/api/remote.mux

curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3099/
curl -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3099/connect?token=wrong&interactions=answer'
```

观察：

```text
无 Cookie RPC          401
无 Cookie WS upgrade   401
无 Cookie GET /        401
错误 token /connect    401
```

判定：通过。除 `/connect` 外，HTTP/WS/静态入口都要求认证。

### T02 `/connect` 换 Cookie

命令：

```bash
curl -i -c .p0/cookies.txt \
  "http://127.0.0.1:3099/connect?token=<token>&interactions=answer"
```

观察：

```http
HTTP/1.1 302 Found
cache-control: no-store
location: ./api/remote.mux
referrer-policy: no-referrer
set-cookie: dsh-auth-<authority-hash>=<opaque>;
            Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

补充：

- Cookie 名 `dsh-auth-<authority-hash>` 在 Host 重启前后保持一致；
- Cookie 值每次 `/connect` 变化；
- 值形如 `v2.<base64url payload>.<hmac>`，payload 里能看到 authority、peer id、issuedAt、expiresAt；
- loopback HTTP 下没有 `Secure` 属性；
- 有效期 30 天，但 socket 一关就失效（见 T14）。

判定：通过。Cookie 是 owner 凭据，不能当普通会话 cookie。

### T03 `$events` ready

WebSocket：

```text
ws://127.0.0.1:3099/api/remote.mux
Cookie: dsh-auth-<authority-hash>=<opaque>
```

发送：

```json
{"type":"open","streamId":"s1","endpoint":"$events","payload":{"args":{}}}
```

收到：

```json
{"type":"item","streamId":"s1","value":{
  "type":"ready",
  "clientId":"<uuid>",
  "host":{"home":"<home>"}
}}
```

判定：通过。注意 `ready` 在 `item.value` 里，且没有 Host 版本。

### T04 `session/list`

请求：

```http
POST /api/session/list
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "session/list",
  "payload": {"args": {"_request": {}}}
}
```

响应（成功）：

```json
{"type":"server-response","rpcId":"<uuid>","result":{
  "ok":true,
  "value":{"items":[{"sessionId":"session-<uuid>", "running":false, "...":"..."}]}
}}
```

参数名坑：

```text
session/list 的参数名是 _request
session/create 的参数名是 request
session/prompt 的参数名是 request
session/page 的参数名是 request
workspace/create 的参数名是 request
```

错误示例：

```json
{"ok":false,"error":{"code":"gateway/arguments-invalid",
 "message":"typert gateway: session/create: args fields do not match the descriptor:
            missing \"request\"; unexpected \"_request\""}}
```

判定：通过。`args` 的字段名由 Host 方法参数名决定，不能统一写 `request`。

### T05 `session/create`

请求：

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "session/create",
  "payload": {"args": {"request": {"cwd": "<repo>/.p0/work"}}}
}
```

响应：

```json
{"ok":true,"value":{"sessionId":"session-<uuid>","agentPreset":"standard"}}
```

带 `workspaceId` 时，`workspace/follow` 会收到 `upsert`，`sessionIds` 包含新 session。

判定：通过。

### T06 `session/prompt` + 流式

打开：

```json
{"type":"open","streamId":"s2","endpoint":"session/follow","payload":{"args":{
  "request":{
    "address":{"kind":"session","sessionId":"session-<uuid>"},
    "maxMessages":50,
    "assistantStream":true
  }
}}}
```

先收到 `snapshot`：

```json
{"type":"item","streamId":"s2","value":{
  "type":"snapshot",
  "header":{"version":4,"id":"session-<uuid>","createdAt":...,"cwd":"...","isSeeded":false,"agentPreset":"standard"},
  "cursor":21,
  "records":[...],
  "hasMore":false,
  "projections":{...}
}}
```

发 prompt：

```json
{
  "type":"client-request","rpcId":"<uuid>","method":"session/prompt",
  "payload":{"args":{"request":{
    "requestId":"p0-<uuid>",
    "sessionId":"session-<uuid>",
    "mode":"queue",
    "content":[{"type":"text","text":"Reply with exactly P0_OK and nothing else."}]
  }}}
}
```

响应：

```json
{"ok":true,"value":{"accepted":true}}
```

事件（按 seq）：

```text
agent/inbox/spliced
turn/start          {"turn":1}
step/start          {"turn":1,"step":1}
system/message
user/message
request/header
request/context
session/title
assistant/message   {"turn":1,"step":1,"message":{"role":"assistant","content":[...,{"type":"text","text":"P0_OK"}]},...}
step/end
turn/end            {"turn":1,"reason":{"kind":"completed"}}
```

判定：通过。最终答案完整，seq 单调，turn 边界清楚。

### T07 `session/page`

请求一：

```json
{"request":{
  "address":{"kind":"session","sessionId":"session-<uuid>"},
  "throughSeq":79,
  "maxMessages":10
}}
```

结果：

```text
records=52
seqs=28..79
hasMore=true
```

请求二：

```json
{"request":{
  "address":{"kind":"session","sessionId":"session-<uuid>"},
  "throughSeq":79,
  "beforeSeq":28,
  "maxMessages":10
}}
```

结果：

```text
records=28
seqs=0..27
hasMore=false
overlap=[]
```

注意：

- `maxMessages:10` 返回 52 条记录，是因为它按消息/turn 对齐；
- `throughSeq` 必须 ≤ 当前 cursor。传 `cursor+1` 会得到：
  ```json
  {"ok":false,"error":{"code":"gateway/bad-request",
   "message":"session page through seq 22 is past cursor 21"}}
  ```

判定：通过。分页无重叠、无丢失。

### T08 审批 allow

触发方式：让模型调用 `bash`，并带：

```json
{
  "command": "echo P0_APPROVAL_OK",
  "justification": "P0 approval test",
  "sandbox_permissions": "danger-full-access"
}
```

`$events` 收到：

```json
{"type":"item","streamId":"s1","value":{
  "type":"waterfall",
  "event":"approval/request",
  "eventId":"<uuid>",
  "agentId":"session-<uuid>",
  "request":{
    "toolName":"bash",
    "callId":"call_<id>",
    "reason":"escalate sandbox to danger-full-access: P0 approval test",
    "displayReason":{"en":"...","zh":"..."}
  }
}}
```

应答：

```json
POST /api/$events/result
{"type":"client-request","rpcId":"<uuid>","method":"$events/result","payload":{"args":{
  "clientId":"<clientId>",
  "eventId":"<eventId>",
  "outcome":{"kind":"result","value":"allowed-once"}
}}}
```

durable 事件：

```text
approval/asked    {"id":"<uuid>","toolName":"bash","callId":"call_<id>","reason":"..."}
approval/decided  {"id":"<uuid>","outcome":"allowed-once"}
job/registered    {"jobId":"bash-<id>","kind":"bash","label":"echo P0_APPROVAL_OK",...}
job/settled       {"jobId":"bash-<id>",...}
tool/result       {"content":[{"type":"text","text":"P0_APPROVAL_OK\n"}],"isError":false,...}
turn/end          {"kind":"completed"}
```

判定：通过。审批有效，工具继续，turn 正常结束。

### T09 审批 reject

同一触发方式，`justification` 改为 `P0 rejection test`，命令改为 `echo SHOULD_NOT_RUN`，应答 `rejected`。

durable 事件：

```text
approval/asked    ...
approval/decided  {"outcome":"rejected"}
tool/result       {"content":[{"type":"text","text":"Error: the user rejected ..."}],"isError":true,...}
turn/end          {"kind":"completed"}
```

模型在下一步明确说明“escalation was rejected — the command did not run”，没有尝试绕过。

判定：通过。拒绝语义正确，命令未执行。

### T10 双 answer 客户端竞态

两个独立 peer（A、B）都用 `interactions=answer`，都订阅 `$events`。

```text
A=<clientId>
B=<clientId>
A eventId=<uuid> B eventId=<uuid> same=true
A answered allowed-once
B cancel={"type":"cancel","eventId":"<uuid>"}
A cancel={"type":"cancel","eventId":"<uuid>"}
turn/end
```

判定：通过。Host 的 first-result-wins 成立；`cancel` 会发给所有客户端（包括答完的那个），客户端必须幂等处理。

### T11 answer 客户端掉线后的 pending

步骤：

1. 触发审批；
2. 在 `approval/asked` 后关闭客户端；
3. 45 秒后重新开一个 `answer` 客户端；
4. 新客户端一开 `$events` 就收到同一个 pending `eventId`；
5. 应答 `rejected` 后，turn 才结束。

观察：

```text
session/list: "running": true
projections.asOfSeq: 39
pending eventId 在重连后原样出现
```

判定：通过（行为明确），但不是 fail closed。**没有超时、没有自动拒绝、没有自动允许。**

### T12 `interactions=none` 的 `$events`

连接：

```text
/connect?token=<token>&interactions=none
```

打开 `$events`：

```json
{"ok":false,"error":{
  "code":"gateway/interactions-forbidden",
  "message":"typert gateway: $events: forwarded Remote events require interactions=answer"
}}
```

同一连接打开 `session/follow`：正常返回 snapshot。

判定：通过。`none` 不能收审批，但 raw session stream 仍可用。

### T13 `none` 客户端触发审批（失败）

步骤：

1. `interactions=none` 连接；
2. 打开 `session/follow`；
3. 发 prompt，要求 `bash` + `sandbox_permissions=danger-full-access`；
4. 等待 90 秒。

观察：

```text
approval/asked 出现
没有 approval/decided
没有 turn/end
turn 一直 running
```

后来开一个 `answer` 客户端，立刻收到同一个 pending `eventId`；拒绝后才结束。

判定：**失败**。原计划假设“没有 answerer 就 fail closed”不成立。原因是 Host 的 `api-remotes` 仍把 waterfall 放进 Remote 队列；没有客户端时它只是等待，不是拒绝。

### T14 关 socket → 旧 Cookie 401 → 重连

步骤：

1. 用 Cookie 打开 WS，`session/list` 成功；
2. 关闭 WS；
3. 用旧 Cookie `session/list`；
4. 用同一 token 重新 `/connect`；
5. 新 Cookie 再 `session/list`。

观察：

```text
before: 200
old cookie after close: 401 unauthorized
reconnect: 302 + new cookie
after: 200
new clientId: <uuid>
```

判定：通过。API Peer 与 lifecycle socket 绑定；任何断线都必须重新 `/connect`。

### T15 客户端退出，Host 任务继续

步骤：

1. 发 prompt：`Use the bash tool to run: sleep 20; echo P0_SURVIVED`；
2. 看到 `tool/call` 后，关闭客户端；
3. 等 25 秒；
4. 重新连接，读 history。

观察：

```text
job/settled
tool/result  "P0_SURVIVED\n[stderr] ..."
turn/end     {"kind":"completed"}
```

判定：通过。客户端退出不会取消 Host 的 agent/tool 任务。

### T16 Host 重启 + 历史/恢复

步骤：

1. 保存旧 token 和一个有效旧 Cookie；
2. 停 Host，重启同一个 `DSH_HOME`；
3. 旧 token `/connect`；
4. 旧 Cookie `session/list`；
5. 新 token `/connect`；
6. 新 Cookie `session/list`；
7. 对旧 session 发 prompt。

观察：

```text
旧 token /connect       401
旧 Cookie session/list  401
新 token /connect       302
新 Cookie session/list  200
旧 session:
  formatStatus = "current"
  agentAvailable = false
  running = false
  history 仍在
对旧 session prompt:
  assistant/message = "P0_RESUMED"
  turn/end completed
```

判定：通过。Host 重启只换 token/peer，不丢 session 日志；`agentAvailable:false` 的 session 可以按需拉起 Agent。

### T17 `session/cancel`

步骤：

1. 发 prompt：`sleep 30; echo P0_CANCEL_SHOULD_NOT_RUN`；
2. 看到 `tool/call`；
3. 调 `session/cancel`。

观察：

```text
session/cancel → {"accepted":true}
tool/result    → "Error: tool call aborted before dispatch"
turn/end       → {"kind":"aborted","reason":{"kind":"user"}}
```

判定：通过。

### T18 `workspace/create` + `workspace/follow`

请求：

```json
{"type":"client-request","rpcId":"<uuid>","method":"workspace/create",
 "payload":{"args":{"request":{"path":"<repo>/.p0/ws"}}}}
```

响应：

```json
{"ok":true,"value":{
  "workspace":{
    "workspaceId":"<uuid>",
    "path":"<repo>/.p0/ws",
    "title":"ws",
    "sessionIds":[],
    "createdAt":"...",
    "updatedAt":"..."
  },
  "created":true
}}
```

`workspace/follow`：

```json
{"type":"baseline","value":{
  "items":[{"workspaceId":"<uuid>","path":"...","title":"ws","sessionIds":[],...}],
  "archivedSessionIds":[],
  "pinnedSessionIds":[]
}}
```

用 `workspaceId` 建 session 后：

```json
{"type":"upsert","workspace":{"workspaceId":"<uuid>","sessionIds":["session-<uuid>"],...}}
```

判定：通过。**没有 `workspace/list`**；列表就是 `workspace/follow` 的 baseline。

路径坑：`workspace/create` 只接受绝对路径，传相对路径会得到：

```json
{"ok":false,"error":{"code":"workspace/invalid-path",
 "message":"cannot create a Workspace at \"../.p0/ws\": Workspace path is not fully qualified"}}
```

### T19 版本探测

检查：

- `$events.ready`：只有 `clientId` 和 `host.home`；
- `/connect` 响应头：没有版本；
- 无 Cookie `/`：401；
- 未知 API：404；
- `headless` profile：没有 `client-connection` / `session-controller` / `api-remotes`。

结论：没有受支持的版本握手。原型用行为探测；生产加 Host 插件。

### T20 官方包 Node 导入

```bash
node --input-type=module -e "await import('@deepseek-ai/dsh-client-connection/client')"
node --input-type=module -e "await import('@deepseek-ai/dsh-api-gateway/client')"
node --input-type=module -e "await import('@deepseek-ai/dsh-api-session-controller/remote')"
node --input-type=module -e "await import('@deepseek-ai/dsh-api-session-controller/client')"
node --input-type=module -e "await import('@deepseek-ai/dsh-client-file-upload/client')"
```

结果：

```text
client-connection/client        OK   installConnection, apply, inject, ...
api-gateway/client              OK   RemoteStream, apply, inject, ...
session-controller/remote       OK   TYPERT_REMOTE, default
session-controller/client       FAIL ReferenceError: window is not defined
client-file-upload/client       FAIL ReferenceError: window is not defined
```

`session-controller/client` 文件开头：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-api-session-controller",
  factory: (require) => { ... }
})
```

判定：部分失败。官方 Client Model 不是 Node ESM；Node adapter 必须用 `/remote` 或自建。

### T21 两个独立进程同时连同一 Host

进程 1（`none`）持有 `session/follow`：

```text
[connect] interactions=none ok
[watch] none client holding session=session-<uuid> cursor=132 for 12s
```

进程 2（`answer`）同时连接：

```text
[connect] interactions=answer ok
[events] ready clientId=<uuid>
[session/list] items=5
[workspace/follow] baseline items=1
```

判定：通过。`none` 与 `answer` 可以同时工作，互不阻塞。

### T22 `headless` profile

命令：

```bash
dsh --profile headless --dump-config | grep -E \
  'dsh-client-connection|dsh-api-gateway|dsh-api-session-controller|dsh-api-remotes'
```

结果：

```text
只出现 dsh-api-gateway
没有 dsh-client-connection
没有 dsh-api-session-controller
没有 dsh-api-remotes
```

判定：通过。`headless` 不能作为 P0 的 Host 基线；必须是 `web` profile 或自建 Host bundle。

## 6. 失败与限制

### 6.1 阻塞项

1. **`none` 审批悬挂**：没有 answerer 时，`approval/request` 不会 fail closed；`-p` 会无限等待。
2. **官方 `session-controller/client` 不可在 Node 加载**：P2 不能按原计划直接挂它。

### 6.2 非阻塞但必须写进设计

1. `$events` 转发事件包在 `item.value` 里；
2. 旧 Cookie 在 socket 关闭后立即 401；
3. Host 重启后 token 失效，必须重新取 URL；
4. `workspace` 没有 `list`，用 `follow` baseline；
5. `session/page` 的 `maxMessages` 是消息/turn 对齐，不是记录数；
6. `cancel` 会发给所有 answer 客户端（包括答完的），要幂等；
7. pending 审批会在新 answer 客户端重投递，TUI 要能恢复；
8. `displayReason` 是 `{en, zh}`，UI 要选 locale；
9. 无版本握手；
10. `headless` 没有 Host API。

## 7. 结论

**Conditional Go。**

- 交互式 TUI：**Go**。认证、session、workspace、prompt、stream、history、page、approval allow/reject、cancel、重连、Host 重启恢复都有实测证据。
- `-p`：**No-Go**。审批悬挂是产品级阻塞，必须先有 Host 侧超时/fail-closed 或明确的 `answer` 策略。
- P2 adapter：**No-Go（官方 client model）**，**Go（Remote + 自建 store）**。
- Host 插件：生产必需；原型可选。

下一步见 [`P0.md`](./P0.md) 第 9 节。
