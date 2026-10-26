# P4 证据索引（TUI）

日期：2026-10-23
环境：Ubuntu 24.04.3 LTS，Node v24.21.0，pnpm 11.27.1
Host：`.p0/dsh-home` 上的 `dsh --profile web --no-open --port 3111`
入口：`node dist/bin/dshell.js`（无子命令即 TUI）

## 1. 自动化结果

```text
$ pnpm test
✔ display width handles ANSI, CJK, and truncation without leaking escapes
✔ wrapText hard-breaks long tokens and keeps CJK within the width
✔ markdown renderer handles headings, bullets, fences, and diffs
✔ durable events become stable blocks and pair tool results by callId
✔ tool output is truncated and summarizeTool uses common arguments
✔ editor supports unicode boundaries, history, and multiline composers
✔ key parser handles arrows, control keys, and bracketed paste across chunks
✔ file completion is bounded and skips hidden/ignored directories
✔ TUI smoke: starts, renders a turn, and quits without a PTY
✔ TUI smoke: renders and answers an approval overlay
✔ TUI startup asks before creating a missing workspace
... P0–P3 tests ...
ℹ tests 30
ℹ pass 30
ℹ fail 0
```

`pnpm typecheck`、`pnpm lint` 通过。

## 2. 真实 Host 驱动（Fake TTY）

当前沙箱下 `script -qec` 创建 pty 失败：

```text
script: failed to create pseudo-terminal: Permission denied
```

因此使用与 `runTui` 相同的代码路径，注入 Fake TTY：

```js
const app = runTui(backend, {
  cwd: '/home/landasika/dshell/.p0/work',
  resume: sessionId,
  color: false,
  input: fakeInput,
  output: fakeOutput,
})
```

### 2.1 普通 turn

```text
$ node /tmp/tui-real.mjs <session>
TUI real render contains P4_TUI_OK
exit 0
```

说明：TUI 打开会话、输入 prompt、渲染 assistant 文本、Ctrl-D 退出 0。

### 2.2 审批

```text
$ node /tmp/tui-real-approval.mjs <session>
TUI approval overlay shown
TUI approval answered; tool result visible
exit 0
```

模型调用 bash（`sandbox_permissions: danger-full-access`）→ TUI 自动显示
`approval required` → 按 `a` → `P4_TUI_APPROVED` 出现在 transcript。
（该测试脚本在 Host 仍执行 turn 时被 `timeout` 包住，进程清理出现一次
环境相关的 linger；TUI 本身在普通 turn 下已自然退出，见 2.1。）

## 2.3 启动选择器（post-P6）

真实 Host 上通过注入 Fake TTY 验证：

```text
# 当前 cwd 已有 workspace
$ node /tmp/tui-picker.mjs /home/landasika/dshell PICK_B
picker shown for existing workspace
picker attach + turn OK
exit 0

# 当前 cwd 尚无 workspace
$ mkdir -p /tmp/dshell-new-work
$ node /tmp/tui-new-workspace.mjs A
missing workspace prompt shown
create workspace + turn OK
exit 0
```

启动时不再自动 attach；已有 workspace 显示 Session 列表，缺失 workspace
显示创建/退出选项。键盘监听在第一次 Host 请求之前安装，早期输入会排队。

## 2.4 Slash completion（post-P6）

在 Fake TTY 下输入 `/`，实际渲染（去 ANSI）：

```text
┌─ commands ─────────────────────────────────────────────┐
│ ▸ /help            show keys and commands              │
│   /sessions        switch session                      │
│   /workspaces      switch workspace                    │
│   /new             create a session                    │
│   /attach          attach by id                        │
│   /cancel          cancel the running turn             │
│   /clear           clear the local transcript view     │
│   /reconnect       reattach the current session        │
│   /verbose         toggle reasoning and lifecycle ...  │
│   /quit            leave the TUI (does not cancel ...) │
│ ↑/↓ select  tab insert  enter run/select  esc close    │
└────────────────────────────────────────────────────────┘
❯ /
```

输入 `q` 后过滤到 `/quit`，`Enter` 执行并退出，证明菜单不是静态提示。
Codex 参考实现位于 `/tmp/codex-src/codex-rs/tui/src/bottom_pane/chat_composer/slash_input.rs`
与 `command_popup.rs`：核心也是“输入即弹出、过滤、上下选择、Tab 补全、
Enter 执行、Esc 关闭”。

## 3. 无 TTY 行为

```text
$ node dist/bin/dshell.js </dev/null | head -3
dshell 0.1.0

Usage:
  dshell                  interactive TUI (same as 'dshell tui')
```

不会把 ANSI 控制序列写入管道。

## 4. 代码位置

| 内容 | 文件 |
| --- | --- |
| TUI 主循环 | `src/tui/app.ts` |
| alternate screen / viewport | `src/tui/screen.ts` |
| 按键解析 | `src/tui/keys.ts` |
| composer / 光标 | `src/tui/editor.ts` |
| durable event 渲染 | `src/tui/events.ts` |
| markdown / diff | `src/tui/markdown.ts` |
| CJK 宽度 / ANSI 安全截断 | `src/tui/width.ts` |
| 默认入口 | `src/cli/main.ts` |
| 测试 | `tests/tui.test.mjs` |

## 5. 未覆盖

- 真实 pty 的 resize/信号/括号粘贴录制（沙箱限制；逻辑有单测，Fake TTY
  覆盖数据解析）。
- 非活动 Session 的实时 fanout / 审批（P4 明确只轮询状态）。
- 超长工具输出的展开 UI（当前截断）。
