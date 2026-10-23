# DSH API Inventory（0.2.1-rc.2）

> 本文只记录 2026-10-23 在 `dsh --profile web` 上实际跑通或从同版本源码确认的接口。
> 标“源码”的条目未在本轮 PoC 中逐项执行；标“实测”的条目有 `poc/p0-client.mjs` 的运行证据。
> 所有 token / Cookie 值均已省略。

## 1. 认证

### 1.1 交换 launch token

```http
GET /connect?token=<launch-token>&interactions=answer|none
```

成功：

```http
HTTP/1.1 302 Found
location: ./api/remote.mux
cache-control: no-store
referrer-policy: no-referrer
set-cookie: dsh-auth-<authority-hash>=<opaque>;
            Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

- `interactions=answer`：可以打开 `$events`，接收并应答审批/提问。
- `interactions=none`：不能打开 `$events`，但可以用 raw stream 和 unary RPC。
- Cookie 名按 authority 派生，Host 重启前后不变。
- Cookie 值形如 `v2.<base64url-payload>.<hmac>`，payload 含 authority、peer id、`issuedAt`、`expiresAt`。
- loopback HTTP 下没有 `Secure`。
- Cookie 与 API Peer 绑定；Peer 与 WebSocket lifecycle socket 绑定。socket 关闭后旧 Cookie 立即 401。
- API Peer 是 **owner** principal。没有只读角色；拿到 token/Cookie 就是 Host owner。

### 1.2 认证失败

| 场景 | HTTP |
|---|---|
| 无 Cookie 调 `/api/*` | 401 |
| 无 Cookie 升级 `/api/remote.mux` | 401 |
| 无 Cookie `GET /` | 401 |
| 错误 token `/connect` | 401 |
| Host 重启后的旧 token | 401 |
| socket 关闭后的旧 Cookie | 401 |

错误响应体是纯文本 `unauthorized`（实测），不是 JSON envelope。

## 2. HTTP RPC envelope

### 2.1 请求

```http
POST /api/<endpoint>
Content-Type: application/json
Cookie: dsh-auth-<authority-hash>=<opaque>

{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "<endpoint>",
  "payload": {
    "args": {
      "<host-parameter-name>": <value>
    }
  }
}
```

关键点：

- `method` 必须与 URL 里的 `<endpoint>` 完全一致，否则 `gateway/bad-request`。
- `payload` 必须恰好有一个 plain-object 的 `args` 字段。
- `args` 里的字段名是 **Host 方法参数名**，不是统一叫 `request`：
  - `session/list` → `_request`
  - `session/create` → `request`
  - `session/prompt` → `request`
  - `session/page` → `request`
  - `session/cancel` → `request`
  - `workspace/create` → `request`
- `rpcId` 会原样回传；客户端必须校验，避免串包。
- 成功和业务失败通常都是 HTTP 200；必须看 `result.ok`，不能只看状态码。

### 2.2 成功响应

```json
{
  "type": "server-response",
  "rpcId": "<same-uuid>",
  "result": {
    "ok": true,
    "value": <endpoint-specific>
  }
}
```

### 2.3 业务失败响应

```json
{
  "type": "server-response",
  "rpcId": "<same-uuid>",
  "result": {
    "ok": false,
    "error": {
      "code": "gateway/arguments-invalid",
      "message": "...",
      "details": {}
    }
  }
}
```

### 2.4 传输失败

- 401：未认证/凭据失效。
- 404：endpoint 不存在。
- 415：`Content-Type` 不是 `application/json`（源码）。
- 400：body 不是 JSON（源码）。
- 500：handler 抛错（源码）。

## 3. WebSocket stream envelope

### 3.1 连接

```text
ws://127.0.0.1:3099/api/remote.mux
Cookie: dsh-auth-<authority-hash>=<opaque>
```

### 3.2 打开流

```json
{
  "type": "open",
  "streamId": "<client-unique>",
  "endpoint": "session/follow",
  "payload": {
    "args": {
      "request": { "...": "..." }
    }
  }
}
```

### 3.3 流帧

```json
{"type":"item","streamId":"<id>","value":{ "...": "..." }}
{"type":"error","streamId":"<id>","error":{ "...": "..." }}
{"type":"end","streamId":"<id>"}
```

`$events` 的特殊之处：`ready`、`waterfall`、`emit`、`cancel` 都作为 `item.value` 到达：

```json
{"type":"item","streamId":"s1","value":{"type":"ready","clientId":"...","host":{"home":"..."}}}
{"type":"item","streamId":"s1","value":{"type":"waterfall","event":"approval/request","eventId":"...","agentId":"...","request":{...}}}
{"type":"item","streamId":"s1","value":{"type":"emit","event":"api-session/added","resources":{...}}}
{"type":"item","streamId":"s1","value":{"type":"cancel","eventId":"..."}}
```

`session/follow` 的 `value.type`：

```text
snapshot
event
assistant-stream
```

`workspace/follow` 的 `value.type`：

```text
baseline
upsert
remove
replace
```

## 4. Endpoint inventory

### 4.1 `$events`（stream，仅 answer）

```json
payload.args = {}
```

成功帧：

```json
{"type":"item","streamId":"s1","value":{
  "type":"ready",
  "clientId":"<uuid>",
  "host":{"home":"<home>"}
}}
```

失败（`interactions=none`）：

```json
{"code":"gateway/interactions-forbidden",
 "message":"typert gateway: $events: forwarded Remote events require interactions=answer"}
```

- 没有 Host 版本、没有 capability 列表。
- `clientId` 用于 `$events/result`。
- 关闭 socket 后，pending 审批不会取消；新 answer 客户端会再次收到。

### 4.2 `$events/result`（unary，仅 answer）

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "$events/result",
  "payload": {
    "args": {
      "clientId": "<clientId>",
      "eventId": "<eventId>",
      "outcome": {"kind": "result", "value": "allowed-once"}
    }
  }
}
```

`outcome`：

```text
{"kind":"result","value":"allowed-once"}
{"kind":"result","value":"rejected"}
{"kind":"result","value":"cancelled"}
{"kind":"result","value":"unavailable"}
{"kind":"next"}                 ← 交给下一个 answerer
```

实测 `allowed-once` / `rejected` 生效；`value` 的返回体形状本次未记录，只确认 `result.ok=true`。

### 4.3 `session/list`（unary）

```json
payload.args = {"_request": {"cursor": "<optional>"}}
```

返回：

```json
{"items":[
  {
    "sessionId":"session-<uuid>",
    "updatedAt": 1792740111359,
    "agentAvailable": false,
    "formatStatus": "current",
    "running": false,
    "blank": true,
    "cwd": "<path>",
    "projections": {
      "kind": "cached",
      "asOfSeq": 2,
      "values": {
        "title": null,
        "goal": null,
        "tokenUsage": {...},
        "contextPressure": {...},
        "contextBreakdown": {...},
        "inbox": {"next-turn":[],"next-step":[]},
        "sessionStats": {...},
        "turnOutline": [...],
        "agentPreset": "standard",
        "userQuestions": {"active":[],"settled":[]},
        "permissions": {"currentValue":"workspace-write"},
        "workingDirectory": "<path>",
        "subagentCatalog": [],
        "subagentTiming": {...},
        "subagent": null,
        "todos": null,
        "plan": {"active":false,"pending":false},
        "modelSelection": {"lastUsed":null,"next":null},
        "sessionListMetadata": {...},
        "imageLimits": {...}
      }
    }
  }
]}
```

要点：

- `cursor` 参数本轮未测分页。
- `agentAvailable:false` 不代表不可用；对旧 Session 发 prompt 会重新拉起 Agent（实测）。
- `running:false` 表示当前没有活跃 turn；断线后 pending 审批的 Session 可能仍为 `running:true`。
- `projections.kind` 可能是 `sequenced` 或 `cached`。

### 4.4 `session/create`（unary）

```json
payload.args = {
  "request": {
    "workspaceId": "<optional>",
    "cwd": "<optional, absolute>",
    "sessionId": "<optional, reuse>",
    "agentPreset": "<optional>"
  }
}
```

`workspaceId` 与 `cwd` 互斥。返回：

```json
{"sessionId":"session-<uuid>","agentPreset":"standard"}
```

实测：

- `cwd` 建会话 → `workspace/follow` 不会自动出现 workspace；
- `workspaceId` 建会话 → `workspace/follow` 收到 `upsert`，`sessionIds` 包含新 session。

### 4.5 `session/prompt`（unary）

```json
payload.args = {
  "request": {
    "requestId": "p0-<uuid>",
    "sessionId": "session-<uuid>",
    "mode": "queue",
    "content": [{"type":"text","text":"..."}],
    "clientTimeZone": "<optional>"
  }
}
```

返回：

```json
{"accepted":true}
```

- `requestId` 由客户端生成，持久化到 user message 的 `source.rpcId`。
- `mode` 实测只用过 `queue`；`steer` 源码存在，未测。
- `content` 支持 `text` / `image` / `file`；`file` 需要 file-upload receipt，本轮未测。
- 省略 `clientTimeZone` 时，Host 会注入 “Browser time zone ... unavailable” 的运行时上下文。

### 4.6 `session/cancel`（unary）

```json
payload.args = {"request":{"sessionId":"session-<uuid>"}}
```

返回：

```json
{"accepted":true}
```

实测效果：

```text
进行中的 tool/call → tool/result "Error: tool call aborted before dispatch"
turn/end → {"kind":"aborted","reason":{"kind":"user"}}
```

### 4.7 `session/follow`（stream）

```json
payload.args = {
  "request": {
    "address": {"kind":"session","sessionId":"session-<uuid>"},
    "maxMessages": 50,
    "turnWindow": {"minMessages": 1, "minTurns": 1},
    "assistantStream": true
  }
}
```

`address` 还支持 subagent：

```json
{"kind":"subagent","parentSessionId":"...","childSessionId":"...","mode":"one-shot|continuable|unknown"}
```

首帧：

```json
{"type":"snapshot","header":{
  "version":4,
  "id":"session-<uuid>",
  "createdAt": 1792740111359,
  "cwd":"<path>",
  "parentSession":"<optional>",
  "isSeeded":false,
  "origin":"<optional>",
  "delegationDepth":0,
  "agentPreset":"standard"
},"cursor":21,"records":[...],"hasMore":false,"projections":{...}}
```

增量：

```json
{"type":"event","event":{
  "type":"assistant/message",
  "seq":19,
  "time":1792740111359,
  "data":{...},
  "ignorable":true
}}
```

`assistantStream:true` 时还会收到：

```json
{"type":"assistant-stream","frame":{"type":"start|chunk|end", "...":"..."}}
```

- 这些是 process-local presentation 帧，不是 durable event；重连后不一定能逐帧重放。
- `assistant-stream.end.outcome` 可能是 `{"kind":"committed","eventType":"assistant/message","seq":...}` 或 `{"kind":"abandoned"}`。

### 4.8 `session/page`（unary）

```json
payload.args = {
  "request": {
    "address": {"kind":"session","sessionId":"session-<uuid>"},
    "throughSeq": 79,
    "beforeSeq": 28,
    "maxMessages": 10,
    "turnWindow": {"minMessages": 1, "minTurns": 1}
  }
}
```

返回：

```json
{"records":[{"type":"event","event":{...}}],"hasMore":true}
```

要点：

- `throughSeq` 必须是当前 cursor 或更早；`cursor+1` → `gateway/bad-request`。
- `maxMessages` 按 message/turn 对齐，不是记录数上限；`maxMessages:10` 可以返回 52 条记录。
- 第二页用 `beforeSeq = 第一页最早 seq`；实测无重叠。

### 4.9 `workspace/create`（unary）

```json
payload.args = {"request":{"path":"<absolute-path>"}}
```

返回：

```json
{
  "workspace": {
    "workspaceId": "<uuid>",
    "path": "<absolute-path>",
    "title": "<basename>",
    "sessionIds": [],
    "createdAt": "2026-10-23T...",
    "updatedAt": "2026-10-23T..."
  },
  "created": true
}
```

- 只接受绝对路径；相对路径 → `workspace/invalid-path`。
- 已存在路径可能返回 `created:false`（源码；本轮未测重复创建）。

### 4.10 `workspace/follow`（stream）

```json
payload.args = {}
```

首帧：

```json
{"type":"baseline","value":{
  "items":[{"workspaceId":"<uuid>","path":"...","title":"...","sessionIds":[],"...":"..."}],
  "archivedSessionIds":[],
  "pinnedSessionIds":[]
}}
```

增量（`upsert` 实测；`remove`/`replace` 为源码，未逐项执行）：

```json
{"type":"upsert","workspace":{"workspaceId":"<uuid>","sessionIds":["session-<uuid>"],"...":"..."}}
{"type":"remove","workspaceId":"<uuid>"}
{"type":"replace","value":{"items":[...],"...":"..."}}
```

**没有 `workspace/list`**。列表就是 baseline。

### 4.11 其他 workspace 方法（源码，未测）

`initializeDefault`、`rename`、`delete`、`insertBefore`、`insertSessionBefore`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`。

### 4.12 未覆盖的 namespace

- `fileUpload`：浏览器 client 不可在 Node 加载；附件的 `Uint8Array` 路径未测。
- `subagents`：`session/follow` 的 subagent address 未测。
- `commands`、`credentials`、`goal`、`settings` 等 forwarded events：未测。

## 5. Durable event inventory（实测）

| event.type | 关键 data | 说明 |
|---|---|---|
| `agent/inbox/spliced` | `target`, `start`, `inserted/removed` | 用户消息进入 inbox |
| `turn/start` | `turn` | turn 开始 |
| `step/start` | `turn`, `step` | 一次模型/工具步开始 |
| `system/message` | `message` | 系统提示 |
| `user/message` | `content`, `source` | 用户消息，`source.rpcId` 对应 prompt `requestId` |
| `request/header` | `header.config`, `header.tools` | 模型请求配置 |
| `request/context` | `provider`, `model`, `contextWindow` | 上下文信息 |
| `session/title` | `title`, `source` | 会话标题 |
| `session/title-llm-request` | `route`, `system`, ... | 标题模型请求 |
| `session-log-deepseek/delivery-accepted` | `sessionId`, `throughSeq` | 日志持久化水位 |
| `assistant/message` | `turn`, `step`, `message`, `usage`, `stream` | 助手最终消息 |
| `tool/call` | `turn`, `step`, `callId`, `name`, `arguments` | 工具调用 |
| `approval/asked` | `id`, `toolName`, `callId`, `reason` | 审批请求已持久化 |
| `approval/decided` | `id`, `outcome` | 审批结果 |
| `job/registered` | `jobId`, `owner`, `kind`, `label`, `toolCall` | bash job 开始 |
| `job/settled` | `jobId`, ... | bash job 结束 |
| `tool/result` | `message`, `toolCallId`, `isError` | 工具结果 |
| `step/end` | `turn`, `step` | 步结束 |
| `turn/end` | `turn`, `reason` | turn 结束；`completed` / `aborted` |
| `workspace/changes` | `turn` | turn 产生的 workspace 变化 |

`turn/end.reason` 实测：

```json
{"kind":"completed"}
{"kind":"aborted","reason":{"kind":"user"}}
```

## 6. Forwarded event inventory（`$events` 的 `emit`）

实测看到：

| event | 说明 |
|---|---|
| `api-session/added` | session 列表新增 |
| `api-session/status` | session 状态变化 |

- `emit` 事件是 **广播**，不要求结果。
- `waterfall` 事件（审批/提问）要求 `$events/result`。
- `cancel` 用于通知其他 answer 客户端“某个 waterfall 已被处理”。

## 7. 错误码（实测）

| code | 触发 | 备注 |
|---|---|---|
| `gateway/internal` | `payload` 不是恰好一个 plain-object `args` | 消息：`Remote payload must contain exactly one plain-object args field` |
| `gateway/arguments-invalid` | `args` 字段名不匹配 | 消息会指出 missing/unexpected 字段 |
| `gateway/bad-request` | `method` 与 URL 不一致；`throughSeq` 超过 cursor | details 可能为空 |
| `gateway/interactions-forbidden` | `none` 连接打开 `$events` | 需要 `interactions=answer` |
| `workspace/invalid-path` | workspace 路径不是绝对路径 | `Workspace path is not fully qualified` |
| HTTP 401 | 无/错 Cookie、旧 token、旧 Cookie | 纯文本 `unauthorized` |
| HTTP 404 | 未知 endpoint | 纯文本 `not found` |

## 8. Node 包兼容性（实测）

| 包/入口 | Node | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-client-connection/client` | OK | 条件导出 `node` → `lib/client.node.js`；导出 `installConnection` |
| `@deepseek-ai/dsh-api-gateway/client` | OK | 条件导出 `node`；导出 `RemoteStream` 等 |
| `@deepseek-ai/dsh-api-session-controller/remote` | OK | 普通 ESM；导出 `TYPERT_REMOTE` / default |
| `@deepseek-ai/dsh-api-session-controller/client` | FAIL | 浏览器 bundle，`window.__ModuleLoader__.load` |
| `@deepseek-ai/dsh-client-file-upload/client` | FAIL | 浏览器 bundle，`window is not defined` |

结论：

- P2 不要 `import '@deepseek-ai/dsh-api-session-controller/client'`。
- 用 `session-controller/remote` 的 descriptor + `api-gateway/client` 的 `RemoteStream`，自己维护 store。
- 或者做 Host BFF，把浏览器 client 留在浏览器侧。

## 9. Adapter 注意事项

1. **`$events` 解包**：先看 `item.value.type`，再分发 `ready`/`waterfall`/`emit`/`cancel`。
2. **`args` 字段名**：按 endpoint 查表，不要统一 `request`。
3. **`result.ok`**：HTTP 200 也可能是业务失败。
4. **`rpcId`**：必须校验。
5. **`throughSeq`**：用当前 cursor，不要 +1。
6. **`maxMessages`**：按 message/turn 对齐，不要当记录数。
7. **`agentAvailable:false`**：可恢复，不要禁用输入。
8. **审批 pending**：新 answer 客户端会收到旧 `eventId`；本地要做去重和 UI 恢复。
9. **`cancel` 广播**：答完的客户端也会收到，幂等处理。
10. **Cookie 生命周期**：socket 关闭即失效；重连必须重新 `/connect`，不能只重开 WS。
11. **token 生命周期**：Host 重启即失效；没有持久化接口。
12. **无版本握手**：不要承诺“支持所有 0.2.x”；要么加插件，要么行为探测。
13. **`headless` 没有 Host API**：必须 `web` profile 或自建 Host bundle。
14. **`ws` 依赖**：Node 内置 WebSocket 不能自定义 `Cookie` 头；需要 `ws` 或自定义 upgrade。
15. **浏览器 bundle**：不要用 `window` shim 硬跑 `session-controller/client`；它会继续依赖 DSH 的模块加载器和 DOM。
