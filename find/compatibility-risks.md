# 兼容性与产品风险（P0 实测版）

> 基于 2026-10-23 对 DSH `0.2.1-rc.2`、`dsh --profile web` 的实测。
> 风险等级：**Critical** 阻塞核心场景；**High** 需要产品决策或 Host 插件；**Medium** 需要设计规避；**Low** 记录并幂等处理。

## 1. 风险总表

| # | 风险 | 等级 | 证据 | 影响 |
|---|---|---|---|---|
| R1 | 没有 answerer 时审批不 fail closed | **Critical** | `none` 客户端触发审批，90s 无 `turn/end` | `-p` 无限悬挂；CI/脚本不可用 |
| R2 | 官方 `session-controller/client` 是浏览器 bundle | **Critical** | Node 导入 `window is not defined` | P2 不能按原计划直接复用官方 Client Model |
| R3 | 最后一个 answer 客户端断开后 pending 审批保留 | **High** | 断线 45s 后新客户端收到同一 `eventId` | turn 长期 `running`；资源占用；UI 必须恢复 pending |
| R4 | Cookie 与 WebSocket 生命周期绑定 | **High** | 关 socket 后旧 Cookie 401 | 不能只重开 WS；必须重新 `/connect` |
| R5 | launch token 只在启动 URL/内存 | **High** | Host 重启后旧 token 401 | 用户体验差；token 易泄漏到 shell history/日志 |
| R6 | API Peer 是 owner，无只读角色 | **High（安全）** | 拿到 Cookie 即可 owner 操作 | 凭据泄漏 = Host 完全失守 |
| R7 | 没有版本/能力握手 | **High** | `$events.ready` 只有 `host.home` | P6 无法诊断“版本不支持”；只能行为探测 |
| R8 | 只有 `web` profile 有完整 Host API | **High** | `headless` 无 `connection`/`session-controller`/`api-remotes` | 用户必须先开 Web Host，或自建 Host bundle |
| R9 | 审批 `waterfall` 包在 `item.value` 里 | **Medium** | 顶层 `waterfall` 监听收不到 | 协议层写错会“看起来没有审批” |
| R10 | `workspace` 没有 `list` | **Medium** | 只有 `workspace/follow` baseline | 列表逻辑要按流式首帧写 |
| R11 | `session/page.maxMessages` 不是记录数 | **Medium** | `maxMessages:10` 返回 52 条记录 | UI 分页/虚拟列表会算错 |
| R12 | `throughSeq` 不能超过 cursor | **Medium** | 传 `cursor+1` → `gateway/bad-request` | 历史加载边界易错 |
| R13 | 附件/file-upload 浏览器 only | **Medium** | `file-upload/client` Node 导入失败 | P2 附件能力受限；需 Node 路径或 BFF |
| R14 | `latest` dist-tag 是旧的 `0.0.1-rc.1` | **Medium** | npm dist-tags 实测 | 误装旧版；API 不兼容 |
| R15 | `dshell` npm 名已被占用 | **Medium** | `npm view dshell` 已有 v1.5.0 | 发布必须用 scope/改名 |
| R16 | `cancel` 广播给所有 answer 客户端（包括答完的） | **Low** | 双客户端竞态实测 | 客户端要幂等，不要把 cancel 当失败 |
| R17 | pending 审批重投递时 `eventId` 不变 | **Low** | 断线重连实测 | 客户端要按 `eventId` 去重 |
| R18 | `displayReason` 是 `{en,zh}` | **Low** | 审批请求实测 | UI 要按 locale 选择 |
| R19 | `agentAvailable:false` 不等于不可用 | **Low** | Host 重启后旧 session 可 prompt | UI 不要禁用输入 |
| R20 | `assistantStream` 是 process-local | **Low** | 重连后不保证逐帧重放 | 不要把它当 durable transcript |

## 2. Critical

### R1 审批不 fail closed

**现象**

- `interactions=none` 客户端发一个需要 escalation 的 prompt。
- Host 记录 `approval/asked`。
- 没有 `approval/decided`，没有 `turn/end`，90 秒仍然 `running:true`。
- 后来开一个 `answer` 客户端，它立刻收到同一个 pending `eventId`；拒绝后 turn 才结束。

**根因（推断 + 源码）**

`api-remotes` 把 `approval/request` waterfall 放进 Remote 队列。队列在 Host 侧是活跃的，即使当前没有 `$events` 客户端；没有客户端来 `$events/result`，waterfall 就一直等。不是“没有 listener → fallback unavailable”。

**影响**

- `-p` 不能安全使用。
- CI 会卡死，直到外部 timeout。
- 用户可能误以为“没有 UI 就自动拒绝”。

**缓解**

1. **Host 插件（推荐）**：给 `approval` 加超时/默认拒绝；或提供一个低优先级 answerer，在没有 UI 客户端时按策略拒绝。
2. **CLI 策略**：`-p` 始终以 `answer` 连接，自己实现 `--approval=reject|allow-once|ask`；默认拒绝。
3. **客户端 watchdog**：检测到 `approval/asked` 后 N 秒无 answerer，主动 `session/cancel`；但这只能救“客户端还在”的情况，救不了断线。
4. **产品限制**：`-p` 只允许不会触发审批的工具/权限；遇到审批直接失败并取消 turn。

**决策**：没有 1 或 2，不要把 `-p` 标为可用。

### R2 官方 Client Model 是浏览器 bundle

**现象**

```text
import '@deepseek-ai/dsh-api-session-controller/client'
→ ReferenceError: window is not defined
```

文件开头：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-api-session-controller",
  factory: (require) => { ... }
})
```

`file-upload/client` 同样失败。

**影响**

- 不能按原计划在 Node 里 `import` 官方 session client。
- 不能直接复用它的 store/projection/recovery。
- 在 Node 里 shim `window` 也不稳：它还需要 DSH 的模块加载器和可能的 DOM。

**缓解**

1. 用 `@deepseek-ai/dsh-api-session-controller/remote`（Node 可导入，导出 `TYPERT_REMOTE`）。
2. 用 `@deepseek-ai/dsh-api-gateway/client` 的 `RemoteStream` 管理流。
3. 自建 store：session list、follow snapshot、event journal、projection、pending approval。
4. 或者做 Host BFF，让浏览器侧继续用官方 client；CLI 只连 BFF。
5. 不建议把整个 Web 前端塞进 Node（Electron 除外）。

**决策**：P2 的 adapter 设计必须按“无官方 client model”来做。

## 3. High

### R3 最后一个 answer 客户端断开后 pending 保留

**现象**

- 审批 pending 时关闭客户端。
- Host 不取消、不拒绝、不超时；`running:true`。
- 新 answer 客户端会收到同一个 `eventId`。

**影响**

- turn 可能永远不结束。
- TUI 重连必须恢复审批 UI，否则用户看不到“还在等审批”。
- 多客户端场景下，别的客户端可能接走审批。

**缓解**

- 客户端持久化 pending `eventId` + 请求内容；重连后重新渲染。
- 本地超时只用于 UI 提示；真正关闭要发 `rejected`。
- Host 插件加超时/默认拒绝（同 R1）。
- 产品文案明确：“关闭客户端不会自动拒绝审批”。

### R4 Cookie 与 socket 绑定

**现象**

```text
关闭 WS → 旧 Cookie session/list → 401
同一 token 重新 /connect → 新 Cookie → 200
```

**影响**

- 不能只实现“WebSocket 自动重连”；必须重新 `/connect`。
- 重连后 `clientId` 变化，`$events` 的 pending 会重投递。
- 旧 Cookie 不能缓存复用。

**缓解**

- 把“连接”定义为一个 generation：`/connect` → Cookie → WS → `$events` ready → 重新拉 list/follow。
- 每次 generation 重建所有流，不要跨 generation 复用 `streamId`。
- 401 时清空 Cookie，重新 `/connect`；如果 token 也 401，提示“启动 URL 失效”。

### R5 token 生命周期

**现象**

- token 只在 Host 进程内存和启动 stdout 里。
- Host 重启后旧 token 401。
- 没有持久化/查询 API。

**影响**

- 用户必须保留启动 URL，或每次重启 Host 重新粘贴。
- token 容易进 shell history、日志、截图。
- 不能做“一次保存，永久可用”。

**缓解**

- 默认只存内存；可选 OS keychain，并标注“Host 重启即失效”。
- 启动命令避免把 token 放命令行参数；从 stdin/文件读。
- 日志/错误信息统一 redact `token=` 和 `dsh-auth-*`。
- 文档明确：token = owner 凭据。

### R6 owner principal

**现象**

- `/connect` 发布 owner principal。
- Remote access 的角色策略只约束非 owner。
- 拿到 Cookie 就能列 session、发 prompt、审批、读写 workspace。

**影响**

- 凭据泄漏 = Host 完全失守。
- 不能把 API 暴露到不可信网络。
- 多用户场景没有隔离。

**缓解**

- 只 bind loopback / trusted host。
- 不要把 `dsh web` URL 截图/发群。
- CLI 不把 Cookie 写磁盘（或加密存储）。
- 未来如果需要多用户，必须加 Host 侧鉴权/租户，而不是靠客户端。

### R7 没有版本握手

**现象**

- `$events.ready` 只有 `clientId`、`host.home`。
- `/connect` 响应头没有版本。
- 未知 API 404，但没有“版本不支持”错误。

**影响**

- P6 无法给“Host 太旧/太新”的明确诊断。
- 只能通过“调用失败 → 猜”来兼容。
- 新 API 缺失时，用户看到的是 404/参数错误，不是升级提示。

**缓解**

- 生产：最小 Host 插件上报 `version` + `capabilities` + `approvalPolicy`。
- 原型：行为探测（尝试 `session/list`、`$events`、`approval`），按错误分类。
- 不推荐只靠静态资源 hash。

### R8 只有 web profile 有完整 API

**现象**

`headless --dump-config`：

```text
有 dsh-api-gateway
没有 dsh-client-connection
没有 dsh-api-session-controller
没有 dsh-api-remotes
```

**影响**

- 不能连任意 `dsh` 进程；必须 `--profile web`。
- 用户需要先起 Web Host，CLI 才能连。
- 如果产品要“像编辑器一样自带 Host”，需要自建 Host bundle。

**缓解**

- 明确 Host 前置条件。
- 或提供 `dshell host` 子命令，内部起 web profile。
- 或做最小 Host bundle（P5/P6）。

## 4. Medium

### R9 `$events` 的 item 包装

所有 forwarded 事件都在 `item.value`：

```json
{"type":"item","streamId":"s1","value":{"type":"waterfall",...}}
```

如果协议层只监听顶层 `waterfall`，审批会“消失”。必须在 `onMessage` 里先解包 `item.value`。

### R10 `workspace` 没有 `list`

用 `workspace/follow` 的 `baseline`。不要等一个不存在的 `workspace/list`。

### R11 `maxMessages` 语义

`maxMessages` 是 message/turn 对齐的窗口，不是记录数。实测 `10` 返回 52 条记录。UI 分页/虚拟列表必须按 `hasMore` 和 `beforeSeq`，不能按“本页 10 条”假设。

### R12 `throughSeq`

必须 ≤ 当前 cursor。传 `cursor+1` 会报：

```json
{"code":"gateway/bad-request","message":"session page through seq 22 is past cursor 21"}
```

### R13 附件/file-upload

`@deepseek-ai/dsh-client-file-upload/client` 是浏览器 bundle。Node 侧要么：

- 只用 `session/prompt` 的 `text`；
- 或走 Remote 的 `Uint8Array` fallback（需验证）；
- 或做 BFF。

不要把附件能力当作 P2 的默认项。

### R14 `latest` 是旧版

```text
latest = 0.0.1-rc.1
next   = 0.2.1-rc.2
```

所有依赖 pin 精确版本；CI 加检查，禁止 `latest`/`^0.0.1`。

### R15 npm 名

`dshell` 已被占用（v1.5.0）。用 scope（如 `@your-scope/dshell`）或改名。package.json 的 `name`、bin、文档、发布脚本要一起改。

## 5. Low

### R16 `cancel` 广播

双 answer 竞态中，A 答完后 A、B 都收到：

```json
{"type":"cancel","eventId":"<uuid>"}
```

客户端要把 cancel 当作“停止等待/清理 UI”，不是“我的答案失败了”。按 `eventId` 幂等。

### R17 pending 重投递

重连后同一 `eventId` 会再次出现。按 `eventId` 去重，不要生成新的审批 UI 条目。

### R18 `displayReason`

```json
{"en":"...","zh":"..."}
```

按 locale 选；没有对应语言时回退到 `reason`。

### R19 `agentAvailable:false`

Host 重启后旧 session 的 `agentAvailable:false`，但发 prompt 会重新拉起 Agent（实测 `P0_RESUMED`）。UI 不要因此禁用输入。

### R20 `assistantStream`

`assistantStream:true` 的 `assistant-stream` 帧是 process-local presentation，不是 durable event。重连后以 `snapshot.records` 和 durable `assistant/message` 为准。

## 6. P0 门槛结论

| 门槛 | 结果 |
|---|---|
| 认证可用 | 通过 |
| 审批 allow/reject 可用 | 通过 |
| 审批在无 answerer 时安全 | **失败** |
| Node 可复用官方 client model | **失败** |
| 断线/重启可恢复 | 通过（需要显式 re-`/connect`） |
| 版本可诊断 | **失败**（无握手） |

**Conditional Go**：

- 交互式 TUI 可以进 P4；
- `-p` 必须先修 R1；
- P2 必须按 R2 调整 adapter 方案；
- 生产版本必须解决 R1/R7（建议一个最小 Host 插件同时做审批超时与版本/能力上报）。
