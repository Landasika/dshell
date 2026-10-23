# P5 证据索引（Product CLI）

日期：2026-10-23
环境：Ubuntu 24.04.3 LTS，Node v24.21.0
Host：`.p0/dsh-home` 上的 `dsh --profile web --no-open --port 3111`
CLI：`node dist/bin/dshell.js`

## 1. 自动化（25/25）

P5 新增 `tests/print.test.mjs`，用一个 Unix socket fake Host 驱动真实 CLI
（不是直接调用内部函数）：

- text：stdout `PRINT_OK`，exit 0；
- json：单对象 `type=result`、`status=completed`、`text=PRINT_OK`、`exitCode=0`；
- stream-json：每行 JSON，首行 `start`，末行 `result`；
- stdin + approval：默认 reject，text 与 json 都 exit 5，`approvalsDenied=1`；
- timeout：`--timeout 150` 在 5s 内退出 4，`status=timeout`。

```text
$ pnpm test
ℹ tests 25
ℹ pass 25
ℹ fail 0
```

## 2. 真实 Host：text

```text
$ dshell -p --session <id> "Reply with exactly P5_TEXT_OK."
P5_TEXT_OK
$ echo $?
0
```

stderr 为空；stdout 没有事件或进度噪声。

## 3. 真实 Host：json

```text
$ dshell -p --session <id> --json "Reply with exactly P5_JSON_OK."
{"type":"result","sessionId":"session-…","requestId":"…","status":"completed","text":"P5_JSON_OK","exitCode":0,"approvalsDenied":0}
```

用 Python `json.load` 解析成功。

## 4. 真实 Host：stream-json

```text
$ dshell -p --session <id> --output-format stream-json "Reply with exactly P5_STREAM_OK."
{"type":"start",...}
{"type":"event","seq":31,"event":{...}}
...
{"type":"result","status":"completed","text":"P5_STREAM_OK","exitCode":0}
```

11 行，全部 `json.loads` 成功；result 为最后一行。

## 5. stdin

```text
$ printf 'Reply with exactly P5_STDIN_OK.\n' | dshell -p --session <id>
P5_STDIN_OK
$ echo $?
0
```

## 6. --new

```text
$ dshell -p --new --cwd <repo>/.p0/work --json "Reply with exactly P5_NEW_OK."
{"status":"completed","exitCode":0,"text":"P5_NEW_OK","sessionId":"session-…"}
```

## 7. 非交互审批 fail closed

```text
$ dshell -p --session <id> 'Call the bash tool ... sandbox_permissions "danger-full-access" ...'
$ echo $?
5
```

stdout 是模型对拒绝的说明；stderr 为空（默认不打印审批诊断）。工具没有执行。
P5 的实现会立即 `answerApproval(..., 'rejected')`，而不是等待或自动 allow。

## 8. 代码位置

| 内容 | 文件 |
| --- | --- |
| print 模式 / 输出格式 / 退出码 | `src/cli/print.ts` |
| CLI 参数与路由 | `src/cli/main.ts` |
| 后端复用 | `src/backend/socket.ts` |
| 端到端测试 | `tests/print.test.mjs` |

## 9. 未覆盖

- 真实 SIGINT 的交互录制（逻辑已实现；自动化测试覆盖 timeout，未发送 SIGINT）。
- `--output-format json` 在 handshake 失败时输出结构化错误（当前只 stderr + exit 1）。
- Model/Settings/Skills/MCP/Tools 的 discovery（依赖 Host 能力，P5 未新增平行系统）。
