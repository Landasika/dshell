# P4 — Claude Code / Codex 风格 Terminal UI（完成）

- 状态：**完成**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/04-tui.md`](../development/04-tui.md)
- 前置阶段：[P0](./00-feasibility.md) · [P1](./01-packaging.md) · [P2](./02-adapter.md) · [P3](./03-session-core.md)
- PR：[Gitea #5](http://192.168.8.77:3000/Landasika/dshell/pulls/5)
- 证据：`find/p4-evidence.md`

## 1. 目标与边界

P4 把 `dshell` 从“命令集合”变成 Claude Code / Codex 风格的交互终端：

```text
$ dshell
┌ dshell · session-… · /work · idle ─────────────────────────────┐
│ you                                                            │
│ 帮我看看这个仓库                                               │
│                                                                │
│ dshell                                                         │
│ 我先读一下结构……                                               │
│ ✓ bash · ls -la                                                │
│ ...                                                            │
│ ❯ 继续                                                          │
└ enter steer/send · alt+q queue · ctrl+j newline · / commands ───┘
```

关键约束没有变化：

- TUI 只是 **Host 的第二个前端**；不持有 Agent 的所有权；
- 退出 TUI 只 dispose 本地 view/connection，**不 cancel** Host 正在跑的 turn；
- 所有 durable 内容来自 `session/event`，`assistant-stream` 只做实时预览；
- 审批只能通过 Host 的 bridge 回答，不能自己伪造 allow；
- V1 仍然只支持 Linux。

## 2. 代码结构

```text
src/tui/
  app.ts       TUI 主循环、命令、会话切换、审批、布局
  screen.ts    alternate screen、raw mode、resize、viewport
  keys.ts      xterm 按键/CSI/括号粘贴解析
  editor.ts    多行 composer、光标、历史、unicode 边界
  events.ts    durable events → transcript blocks
  markdown.ts  markdown / 代码块 / diff 渲染
  theme.ts     ANSI 样式（NO_COLOR 可关）
  width.ts     ANSI 清理、CJK/emoji 宽度、换行/截断
```

`src/cli/main.ts` 的默认命令改为 `tui`：

```bash
dshell                         # 有 TTY 时进入 TUI
dshell tui --resume <id>       # 直接打开会话
dshell --no-color              # 禁用颜色
```

非 TTY 下 `dshell` 不再尝试进入 TUI，而是打印帮助；交互式行为必须显式有终端。
这样 `dshell | cat` 不会把控制序列写进管道。

## 3. 渲染模型

### 3.1 Durable 优先

`buildBlocks(events, verbose)` 是纯 reducer：

- `user/message` → 用户块；注入的 system-reminder 不进入 transcript；
- `assistant/message` → 文本块；reasoning 单独显示为 `✻ thinking`，默认只显示
  一行摘要，`--verbose` 显示全文；
- `tool/call` + `tool/result` 按 `callId` 配对，工具卡显示
  `▸`（运行中）/ `✓`（成功）/ `✗`（失败）；默认折叠成一行
  `✓ Bash(<主参数>)`，输出不铺开——`Ctrl-O` 原地展开，或
  `Alt+↑/↓` 选中后 `Enter` 在详情面板里看；失败的调用仍显示前两行输出；
- `todo/write` → `☐ todos` 列表；
- `subagent/*` → 生命周期提示；
- `approval/asked` / `approval/decided` 默认折叠，`--verbose` 显示；
- 未知事件默认忽略，`--verbose` 才显示。

因为 reducer 只依赖 durable events，重连/切换回来不会重复输出。
`assistant-stream` 只追加在 transcript 末尾的 live 区，`assistant/message`
到达后清空；不会把同一段文字算成两条消息。

### 3.2 流式重绘

- `assistant-stream` 更新只设置 `renderScheduled`，由 33ms 定时器合并；
- 一帧只做一次完整 `\x1b[H` + 清行重绘，不 per-token 输出；
- transcript 只在内容变化时重算；
- 工具输出默认截断为 **12 行 / 1600 字符**，超出显示
  `… +N lines`，避免超长输出冲垮屏幕；
- 上下翻页用 `PgUp/PgDn`，viewport 保持 tail 模式，用户没有上翻时自动跟随新事件。

### 3.3 终端安全与宽度

- 所有模型/工具文本先 `sanitizeText()`：剥离 ANSI/OSC、C0/C1 控制字符，
  统一 CRLF；
- ANSI 样式的截断是 escape-aware，不会把 `\x1b[31m` 截成坏序列；
- CJK/emoji 按 2 cell 计算，组合字符按 0 cell；窄屏每行强制 wrap/truncate；
- `NO_COLOR` 或 `DSHELL_NO_COLOR` 关闭颜色；
- 终端 resize 重新计算 composer/transcript 高度；
- 启动时请求 kitty keyboard protocol（`\x1b[>1u`，escape 去歧义），
  `Ctrl+Enter`/`Shift+Enter`/`Ctrl+字母` 才不会被压成 Enter；退出时
  `\x1b[<u` 弹出该协议；
- 退出时恢复 cursor、关闭 bracketed paste、离开 alternate screen、关闭 raw mode。

## 4. Composer 与命令

- Enter 发送；`Ctrl+Enter`（或 `Ctrl-J`）插入换行；`Alt+Q` 排队（部分终端把 `Alt+Enter`
  抢去切全屏，所以排队用 `Alt`+字母，`Alt+Enter` 能收到时也照常生效）；
- 左右/Home/End/Delete/Backspace；`Ctrl-A/E/K/U/W` 行编辑；
- Up/Down 历史输入，保留 100 条内存历史；
- 括号粘贴一次插入多行；粘贴内容同样经过 sanitize；
- `Tab` 补全：
  - 以 `/` 开头时补全命令；
  - `@` 文件引用：从当前 CLI cwd 递归 2 层、最多 100 个候选，跳过隐藏目录、
    `node_modules`、`dist`；这不是 DSH 的语义替代，只是输入辅助；
- `Ctrl-C`：有输入先清空；turn 运行中则显式 cancel；否则退出；
- `Ctrl-D`：空输入时退出；
- 退出不 cancel；需要 cancel 要显式按 `Ctrl-C` 或 `/cancel`。

Slash commands：

```text
/help          /sessions      /workspaces
/resume        /new [cwd]     /attach <id>
/cancel        /clear         /reconnect
/model         /provider      /verbose
/quit
```

`/model`：目录 →（带 reasoning 档位的模型）档位列表 → `Enter`（或 `Shift+Enter`）一次提交
`{provider, model, reasoningEffort}`；档位列表里 `1`-`9` 直选第 n 档，`e` 重开
档位，`←` 退回，`d` 连同档位设为默认。档位按 `provider/model` 记忆，底栏显示 `provider/model · high`。

`/provider`：读取 Host 启动用的 patch 文件（`$DSH_HOME/cordis.patch.yml`，否则
当前 profile 的同名文件）中的 `llm-pi-ai` provider 行；`Enter` 编辑
`baseURL`/`apiKeyEnv`/`displayName`，`s` 定点改写 YAML 标量行后弹出“是否立即
重启 Host”，`y` 重新 exec Host 并自动 reattach，`n` 留待手动重启。`a` 追加一个
整块 provider（`id`、可选 `displayName`/`apiKeyEnv`、`baseURL`、模型 id 列表），
`x` 删除选中的 provider（最后一个不允许删），两者都复用同一个重启确认。写入
前后都会重新解析并比对 provider 列表，任何“意思变了”的改写都会被拒绝。密钥不
落在 patch 文件里，只有环境变量名。

`/clear` 只隐藏本地 transcript（记录 `clearedAtSeq`），不删除 Host 的 durable
history；重新 attach 会重新看到。

## 5. Session / Workspace Switcher

- 启动时优先恢复最近的 **live** Session；没有 live 就恢复最近 cold Session；
  一个 Session 都没有时，在 CLI cwd 创建一个；
- `/sessions` 打开列表（`/resume`、`/session` 是它的别名）：显示 20 字符 id、
  live/cold、cwd、相对时间；
  ↑/↓ 选择、Enter attach、`n` 新建；
- `/workspaces` 打开 workspace 列表：Enter 进入该 workspace 的 session 列表，
  `n` 在该 workspace 新建；
- 非活动 Session 的状态通过 5 秒一次的 `listSessions()` 轮询更新；
- 切换 Session 时旧 handle 只 dispose 本地连接，Host 继续运行；
- `--resume <id>` 直接打开指定 Session。

## 5.4 Slash Command 与 @ 文件补全

对齐 Codex TUI 的交互模型（参考 `codex-rs/tui/src/bottom_pane/chat_composer/slash_input.rs`
和 `command_popup.rs`）：

- 输入 `/` **立即**弹出命令面板，而不是等 Tab；
- 输入继续过滤，例如 `/se` 只剩 `/sessions`；
- `↑/↓` 移动高亮，`Ctrl-P/N` 同样可用；
- `Tab` 把高亮命令插入 composer；
- `Enter` 执行无参数命令；`/attach` 这类需要参数的命令插入 `/attach ` 后等待输入；
- `Esc` 只关闭面板，不清空草稿；
- 面板最多 9 行，选中项超出时窗口滚动；
- 输入 `@` 时显示当前 cwd 的文件候选，`Tab`/`Enter` 插入引用；
- 命令定义、过滤、上下文解析是纯函数（`src/tui/completion.ts`），有独立测试。

## 5.5 启动时的 Workspace / Session 选择

TUI 启动不再自动 attach 最近 Session。它先比较 CLI cwd（canonical path）和
Host 的 workspace 列表：

- **workspace 已存在**：列出该 workspace 的 Session，显示 live/cold、cwd、
  相对时间；`↑/↓` 选择，`Enter` 接入，`n` 新建 Session，`q`/`Esc` 退出；
- **workspace 未创建**：显示目录和“workspace not created”，`c`/`Enter`
  创建 workspace + 新 Session，`q`/`Esc` 退出；
- 已有 `--resume <id>` 或 `--new` 时跳过选择器；
- 选择器渲染期间键盘监听已安装，慢 Host 不会让界面看起来“无响应”。

这解决了“先自动选了错误 Session/在空目录里直接创建”的体验问题。

## 6. 审批弹层

当当前 view 出现 `pendingApproval` 时，自动覆盖全屏弹层：

```text
┌─ approval required ──────────────────────────────┐
│ tool: bash                                        │
│ reason: P4 TUI approval test                      │
│ request: approval-…                               │
│                                                   │
│ [a] allow once   [r] reject   [d] details         │
│ A timeout, disconnect, or non-TTY fails closed.   │
└───────────────────────────────────────────────────┘
```

- `a` → `allowed-once`，`r` → `rejected`；
- 同一 request 有 `approvalBusy` 防重复提交；
- `Esc` 不丢失审批，只提示仍 pending（必须显式 a/r 或等 Host 超时）；
- Ctrl-C 退出时关闭 watcher，Host 对最后一个 watcher 的 pending 审批
  fail closed；
- `approval` 覆盖层阻止输入被误发送；
- 审批 id 仍然来自 Host 的 `approval-request`，不是 durable `approval/asked`。

## 7. 验收

### 7.1 自动化

`pnpm test`：**30/30 通过**（P4 原始 20 个 + 启动选择器 2 个 + title 1 个 + completion 2 个；后续 P5 增加 5 个）：

- display width / ANSI 截断 / CJK wrap；
- markdown heading/bullet/fence/diff；
- durable events → blocks、tool result 配对、todo、重复渲染一致性；
- 工具输出截断；
- editor unicode/历史/多行；
- key parser（箭头、Ctrl、括号粘贴跨 chunk）；
- `@` 文件补全边界；
- **Fake TTY smoke**：启动、发送 turn、渲染 `echo: hello`、Ctrl-D 退出 0；
- **Fake TTY approval smoke**：渲染弹层、按 `a`、显示 allowed once、退出 0；
- **Fake TTY startup smoke**：已有 workspace 先显示选择器；缺失 workspace 显示创建/退出；
- **方向键 + Enter 选择**：CSI/SS3 上下键移动高亮，Enter attach 到第二个 Session；
- **Session title**：展示 Host `session/title` 投影，列表和标题栏使用最新标题；
- **Slash/file completion**：输入 `/` 立即显示候选，输入 `@` 显示文件候选；上下/Ctrl-P/N、Tab、Enter、Esc 行为与 Codex 风格一致。

### 7.2 真实 Host

在 `.p0/dsh-home` 的 Host 上，用可注入的 Fake TTY 驱动 `runTui`：

| 场景 | 结果 |
| --- | --- |
| `--resume <session>` | 进入 TUI，显示 session/cwd/状态 |
| 输入 `Reply with exactly P4_TUI_OK.` | transcript 出现 `P4_TUI_OK`，Exit 0 |
| 输入危险 bash 请求 | 自动出现 `approval required` |
| 按 `a` | 审批 allow，工具结果 `P4_TUI_APPROVED` 出现在 transcript |
| Ctrl-D | TUI 退出 0；Host 仍在运行（退出不 cancel） |

`script` 在当前 DSH 沙箱下无法创建 pty（`Permission denied`），所以真实终端
录制改用注入 Fake TTY；渲染/按键/审批路径与真实 TTY 共用同一 `runTui`。
`pnpm typecheck`、`pnpm lint` 通过。

## 8. 已知限制

1. **单活动会话**：只订阅当前 Session；其他 Session 仅 5 秒轮询状态，不会
   显示它们的实时流，也不会自动弹出非活动会话的审批。多 pane 是 V1 之后。
2. 没有鼠标、滚动条、图片、可展开 diff 面板；工具输出超过阈值直接截断，
   暂不支持“展开全部”。
3. 没有独立的 subagent pane；`subagent/*` 只显示生命周期提示，详细内容
   仍在工具卡/后续消息里。
4. Markdown 是终端友好的子集：标题、列表、引用、fence、diff；没有完整
   CommonMark、表格和 HTML。
5. `@` 只是文件名补全，不读取文件内容，也不替代 DSH 的引用语义。
6. `Ctrl-Z`/作业控制未处理；终端被 SIGKILL 时无法恢复 alternate screen，
   这是所有 TUI 的共同限制。
7. 真实 Host 的连接断开只会在下一次操作时报错；P4 提供 `/reconnect`，
   尚未做自动指数退避重连。
8. 终端宽度小于 20 列或高度小于 6 行时只保证不崩溃，不保证可读。

## 9. 下一阶段（P5）

P5 会把 TUI 下面的同一套 Backend 用于：

- `dshell -p "..."` 单次执行与 stdin 管道；
- `--output-format text|json|stream-json`；
- 稳定退出码、SIGINT/超时；
- 非交互审批策略（默认 fail closed）；
- 脚本/CI 友好的 stdout/stderr 分离。

P4 不修改 `docs/development/`，本文件与 `find/p4-evidence.md` 是新证据。
