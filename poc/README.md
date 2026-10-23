# poc/ — P0 probe

这是一个**探针**，不是产品代码。它用 raw HTTP + WebSocket 验证 DSH `0.2.1-rc.2` 的认证、Session、流式、审批、历史和重连语义。

结果与结论见：

- [`../find/P0.md`](../find/P0.md)
- [`../find/p0-report.md`](../find/p0-report.md)
- [`../find/dsh-api-inventory.md`](../find/dsh-api-inventory.md)
- [`../find/compatibility-risks.md`](../find/compatibility-risks.md)

## 前置条件

- Node `^22.19.0 || >=24.0.0`（实测 `v24.21.0`）
- pnpm 11.x（实测 `11.27.1`）
- DSH `0.2.1-rc.2`（`dsh` 在 PATH，或使用缓存的 runtime）
- 一个 `dsh --profile web` Host

## 1. 启动 Host

```bash
cd <repo>
export DSH_HOME="$PWD/.p0/dsh-home"
dsh --profile web --no-open --port 3099
```

如果 `dsh` 不在 PATH：

```bash
node ~/.dsh/cache/mayfly-cli-runtime/<runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --no-open --port 3099
```

stdout 会打印一次：

```text
dsh web: http://127.0.0.1:3099/?token=<token>
```

把整个 URL 保存到 `.p0/url`，权限设为 600：

```bash
umask 077
printf '%s' 'http://127.0.0.1:3099/?token=<token>' > .p0/url
```

> `.p0/` 已 gitignore。URL 里的 token 是 **owner 凭据**；不要提交、截图或粘贴到聊天里。
> Host 重启后 token 会变，需要重新保存。

## 2. 安装依赖

```bash
cd poc
pnpm install --store-dir ../.p0/pnpm-store
```

依赖说明：

- `ws`：Node 内置 WebSocket 不能自定义 `Cookie` 头，必须用 `ws`。
- 官方包固定为 `0.2.1-rc.2`；`import-check.mjs` 会验证哪些入口能在 Node 加载。

## 3. 运行

所有命令都从 `poc/` 目录运行，并读取 `DSH_URL_FILE`：

```bash
export DSH_URL_FILE=../.p0/url
```

| 命令 | 作用 |
|---|---|
| `node p0-client.mjs connect` | `/connect` → `$events` → `session/list` → `workspace/follow` baseline |
| `node p0-client.mjs list` | 打印 `session/list` |
| `node p0-client.mjs create [cwd]` | 新建 Session；默认 `../.p0/work` |
| `node p0-client.mjs prompt <sessionId>` | 发 prompt、收 follow 事件、读 page |
| `node p0-client.mjs history <sessionId>` | 读 follow snapshot 的最后 12 条事件 |
| `node p0-client.mjs page <sessionId>` | 测 `session/page` 两页 + 重叠检查 |
| `node p0-client.mjs workspace <absolutePath>` | 建 Workspace、follow baseline/upsert |
| `node p0-client.mjs reconnect` | 关 socket → 旧 Cookie 401 → 重新 `/connect` |
| `node p0-client.mjs none <sessionId>` | `interactions=none`；验证 `$events` 被拒、follow 可用 |
| `node p0-client.mjs none-prompt <sessionId>` | `none` 发审批类 prompt；**会悬挂**，用 timeout 跑 |
| `node p0-client.mjs detach <sessionId>` | 长任务开始后关客户端，验证 Host 继续 |
| `node p0-client.mjs cancel-task <sessionId>` | 长任务开始后 `session/cancel` |
| `node p0-client.mjs race <sessionId>` | 两个 answer 客户端审批竞态 |
| `node p0-client.mjs watch <sessionId> [seconds]` | `none` 客户端持有 follow，默认 20s |
| `node import-check.mjs` | 官方包 Node 导入检查 |

### 审批控制

`P0_APPROVAL`：

```bash
P0_APPROVAL=allow  node p0-client.mjs prompt <sessionId>   # 自动 allowed-once
P0_APPROVAL=reject node p0-client.mjs prompt <sessionId>   # 自动 rejected
P0_APPROVAL=manual node p0-client.mjs connect              # 只打印，不自动答
```

默认是 `manual`（`none`/`watch` 不涉及审批）。

### 自定义 prompt

```bash
P0_PROMPT='Use the bash tool to run: echo hello' \
  node p0-client.mjs prompt <sessionId>
```

## 4. 复现审批

让模型调用带 escalation 的 bash：

```bash
P0_APPROVAL=allow \
P0_PROMPT="Use the bash tool with sandbox_permissions set to 'danger-full-access' and justification 'P0 approval test' to run: echo P0_APPROVAL_OK. Do not use any other tool." \
  node p0-client.mjs prompt <sessionId>
```

应该看到：

```text
[waterfall] event=approval/request ...
[waterfall] approval answered allowed-once
```

## 5. 已知限制

- 这是 **raw wire probe**，没有使用 `installConnection` 或官方 `session-controller/client`；后者在 Node 下是浏览器 bundle。
- 不持久化 token；Host 重启后必须重新保存 URL。
- 只针对本地 loopback Host；没有测 TLS/反向代理/trustedHosts。
- `none-prompt` 的“悬挂”是实测发现，不是脚本 bug；请用 `timeout`。
- `assistantStream` 帧是 process-local，不适合作为唯一 transcript。

## 6. 安全

- `.p0/url`、`.p0/cookies.txt`、`.p0/dsh-home/` 都是 owner 凭据/本地状态，已 gitignore。
- 不要把 Host URL、Cookie、`clientId` 贴到 issue/聊天/日志。
- API Peer 是 owner；拿到凭据等于拿到 Host 控制权。

## 7. dshell-host spike（一个 Host + CLI）

目标不是再起一个 Host，而是给已经运行的 `dsh --profile web` 挂一个 Unix socket，让 CLI 和 Web 操作同一个 live Session。设计和里程碑见 [`../find/architecture.md`](../find/architecture.md)。

### 安装插件

```bash
cd <repo>
export DSH_HOME="$PWD/.p0/dsh-home"

# 本地包；dsh 会把它加入 profile 的 bundles
dsh plugin --profile web add "$PWD/poc/dshell-host"
```

如果 `dsh` 不在 PATH，用第 1 节的 runtime `bin.js` 替换 `dsh`。

启动 Host 后，stderr 应出现：

```text
[dshell-host] listening on /home/.../.p0/dsh-home/run/dshell.sock
```

socket 权限是 `0600`；CLI 不拿 token，也不读 Cookie。

### 运行 CLI

```bash
export DSH_HOME="$PWD/.p0/dsh-home"
export DSHELL_SOCKET="$DSH_HOME/run/dshell.sock"

node poc/dshell-cli.mjs list
node poc/dshell-cli.mjs attach <sessionId>
node poc/dshell-cli.mjs prompt <sessionId> 'Reply with exactly DSH_SOCKET_OK'
```

`prompt` 会先自动 attach，所以能看到这一轮的 `user/message`、`assistant/message`、`turn/end`。

### 已验证

- Web API 创建的 Session，CLI `list` 能看到；
- CLI `prompt` 写入的 `user/message`，Web 侧 `session/follow` 能读到；
- Web API `prompt` 后，CLI 的 `attach` 能实时收到事件和流式文本；
- CLI 断开后 Session 保持 live，Web 仍可继续；
- 冷 Session 由 `dshell-host` `resume`，插件持有 handle，不随 CLI 断开而销毁。

### 还没做

- CLI 审批回答（现在只能在 Web 回答；CLI 能看到 `approval/asked`）；
- `steer` / `cancel` / 多 Session 并行；
- TUI 渲染（历史、markdown、工具卡片、输入框）；
- 断线重连、版本握手、`SO_PEERCRED` 校验；
- 正式 npm 包名和 `dshell` bin（`dshell` 这个名字已被占用，需要用 scope）。
