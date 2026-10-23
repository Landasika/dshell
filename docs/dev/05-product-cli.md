# P5 — 完整 CLI 与自动化工作流（完成）

- 状态：**完成**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/05-product-cli.md`](../development/05-product-cli.md)
- 前置阶段：[P0](./00-feasibility.md) · [P1](./01-packaging.md) · [P2](./02-adapter.md) · [P3](./03-session-core.md) · [P4](./04-tui.md)
- PR：[Gitea #6](http://192.168.8.77:3000/Landasika/dshell/pulls/6)
- 证据：`find/p5-evidence.md`

## 1. 入口模型

P5 之后，`dshell` 有三种入口，共享同一个 `DshellBackend` / `SessionHandle`：

```text
dshell                         TTY → P4 TUI
dshell -p "..."                单次执行，stdout 只有结果
printf ... | dshell -p        stdin 管道
dshell -p --json ...          结构化结果
dshell prompt <id> "..."      P1/P3 兼容的低层命令
```

三者都只连接 **已经运行的** `dsh --profile web` 上的 dshell Host 插件，不会
spawn 第二个 Host，也不会把 Agent 所有权从 Host 拿走。

## 2. 单次执行

```bash
dshell -p "总结这个仓库"
printf '总结这个仓库\n' | dshell -p
dshell -p --session <sessionId> "继续"
dshell -p --new --cwd /path/to/project "初始化项目"
dshell -p --workspace <workspaceId> "在这个 workspace 新建会话"
```

选择 Session 的顺序：

1. `--session <id>`：直接 attach；
2. `--new`：创建新 Session（`--cwd` / `--workspace` 生效）；
3. 否则选择最近的 **live** Session；没有 live 选择最近 cold Session；
4. 一个都没有时，在 CLI 的 `process.cwd()` 创建一个。

`--session` 的 cold Session 也可以直接用：`openSession` 只读历史，发送 prompt
时由 Host 按原 preset/model 恢复；CLI 不自己 resume。

## 3. 输出格式

### 3.1 text（默认）

- stdout：最终 assistant 文本（可能包含多个 assistant message，按出现顺序拼接）；
- stderr：错误和 `--verbose` 诊断；
- 不输出事件、进度条、token；
- 没有 assistant 文本时 stdout 为空。

```text
$ dshell -p --session <id> "Reply with exactly P5_TEXT_OK."
P5_TEXT_OK
```

### 3.2 json

stdout 是 **一个** JSON 对象：

```json
{
  "type": "result",
  "sessionId": "session-…",
  "requestId": "…",
  "status": "completed",
  "text": "P5_JSON_OK",
  "exitCode": 0,
  "approvalsDenied": 0
}
```

`status`：`completed | failed | cancelled | timeout`。
失败时额外带 `reason`。

### 3.3 stream-json

stdout 是逐行 JSON（NDJSON），每行独立可解析：

```json
{"type":"start","sessionId":"session-…","created":false}
{"type":"event","sessionId":"session-…","seq":31,"event":{…}}
{"type":"approval","action":"rejected","requestId":"…","toolName":"bash"}
{"type":"result","sessionId":"session-…","requestId":"…","status":"completed","text":"…","exitCode":0,"approvalsDenied":0}
```

- `start` 在 attach 后、发送 prompt 前；
- `event` 是 durable `session/event`，顺序按 `seq`；
- `approval` 只在非交互模式触发了拒绝时出现；
- `result` 始终最后一行；
- 诊断只写 stderr；stdout 不会混入人类可读日志。

## 4. 退出码

| 码 | 含义 |
| --- | --- |
| `0` | turn completed |
| `1` | 连接/权限/Host/协议/内部错误 |
| `2` | 参数错误（未知选项、空 prompt、缺少 sessionId 等） |
| `3` | turn 非 completed 结束（失败、取消、异常） |
| `4` | `--timeout` 超时；CLI 会请求 cancel 后退出 |
| `5` | 非交互模式遇到审批并 fail closed（默认 reject） |
| `130` | SIGINT（CLI 请求 cancel 后退出） |

退出码是稳定的脚本契约；P6 会在兼容性文档中固定。

## 5. 非交互审批策略

`-p` 没有可交互 answerer，因此 **默认 reject**，不会静默 allow：

- 收到 `pendingApproval` → 立即 `answerApproval(..., 'rejected')`；
- durable `approval/decided` 仍由 Host 记录；
- 任何一次 rejection 都把最终退出码设为 `5`；
- `--json` / `stream-json` 会报告 `approvalsDenied` 和 `approval` 行；
- 不会因为模型换了说法、重试或超时而自动改成 allow。

这是 P0 的 fail-closed 要求在 CLI 上的落实。需要人工审批时用 TUI 或 Web；
Plan 没有提供 `--dangerously-allow-all`。

## 6. 超时与信号

- `--timeout <ms>` 默认 120000，覆盖整个 turn 等待；
- 超时 → `handle.cancel()` → 等待流程收尾 → 退出 `4`；
- `SIGINT` → 设置 `interrupted`、请求 cancel、结束等待 → 退出 `130`；
- 定时器在完成时清理，避免脚本进程被 120s timer 拖住；
- 退出前 dispose 本地 handle，Host 的 Agent 不会被 dispose。

## 7. stdout / stderr 划分

| 流 | 内容 |
| --- | --- |
| stdout | text 结果 / JSON / NDJSON |
| stderr | `dshell:` 错误、`--verbose` 诊断、action hint |
| stdin | `-p` 无参数时的 prompt；最多由管道提供，尾随换行会去掉 |

Shell pipeline 示例：

```bash
dshell -p "只输出 OK" | tr -d '\n'
dshell -p --json "..." | jq -r .text
dshell -p --output-format stream-json "..." \
  | jq -c 'select(.type=="event") | .event.type'
```

## 8. 兼容与限制

- `dshell prompt <id> <text>` 仍保留；它是“看事件流”的低层命令，不等价于
  `-p` 的稳定结构化输出。
- `-p` 的 `--session` 与 `--new` 互斥使用：同时给出时 `--session` 优先。
- `--cwd` / `--workspace` 只影响新建 Session，对已有 Session 不生效。
- `--output-format json` 在连接/handshake 失败时没有 result 对象；错误走
  stderr + 退出码 1。这是为了避免把 Host 诊断误当成模型结果。
- Model / Settings / Skills / MCP / Tools 的 discovery 仍以 DSH Web/现有
  Host 能力为准；P5 不复制一套平行配置系统。
- TUI 的 Slash Commands 与 `@` 补全在 P4；`-p` 的 prompt 是普通文本，
  不会把 `/help` 当命令执行。
- 仍然 Linux only；P6 会做版本矩阵与发布。

## 9. 验收

| 计划验收项 | 结果 |
| --- | --- |
| `dshell -p` 可用于 shell pipeline，稳定退出码 | 完成 |
| `stream-json` 逐行可解析，诊断不污染 stdout | 完成 |
| 非交互不绕过审批 | 默认 reject，退出 5 |
| TUI/CLI/脚本共享同一 Host，不重复业务真相 | 共用 Backend/Host，P3 多 watcher 已验证 |
| Session/Workspace 选择 | `--session`/`--new`/`--cwd`/`--workspace` |
| 文本/JSON/NDJSON | 完成 |
| SIGINT/超时 | cancel + 130 / 4 |

自动化：`pnpm test` **25/25**，其中 P5 新增 5 个 print 端到端测试：

- text 输出与 exit 0；
- json 单对象；
- stream-json 每行 JSON、start/result 顺序；
- stdin + approval fail closed（text 与 json 均 exit 5）；
- timeout exit 4 且进程不挂起。
