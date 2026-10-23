# P4 — Claude Code / Codex 风格 Terminal UI

**目标**：打造“对话优先”的轻量终端体验。Mayfly 作为展示和交互测试的参考，而不是继续使用其旧的同进程 Agent Controller。

## 工作包

- [ ] 选择终端渲染引擎（优先评估 Mayfly 现有 pi-tui 实现的复用和许可证），并建立终端测试 harness。
- [ ] Inline Transcript、交互式 Composer、多行编辑、历史输入、自动建议/补全。
- [ ] 实时 Markdown、代码块、Tool Call、执行结果、Diff、Subagent 状态展示。
- [ ] 流式重绘策略：不每 token 全屏重画、不重复输出 settled 消息。
- [ ] 确认/批准/拒绝弹层；通知、快捷键提示、错误提示与焦点恢复。
- [ ] Session Switcher、Workspace Switcher；非活动 Session 背景状态提示。
- [ ] `/` 命令与 `@` 文件引用：先复用 DSH 已有语义，不创造平行配置系统。
- [ ] TTY/非 TTY 区分；终端尺寸变化、Ctrl+C / Ctrl+D、Raw Mode 恢复。
- [ ] 终端安全：脱敏日志、控制序列处理、路径转义与宽字符/CJK 处理。
- [ ] 保留 Mayfly 的重要行为回归用例；不硬性复刻旧 UI Node/Pane/Overlay 协议。

## 体验验收

- 打开后可以直接输入请求；流式输出、工具事件与 Diff 可辨认。
- 窄屏、长历史、超长工具输出无明显错乱；上下滚动正常。
- 取消当前运行是显式动作；退出 TUI 不取消 Host 正在执行的任务。
- 审批弹层能正确处理并发更新与断线重连；不会对过期审批二次提交。

## 非目标（V1 前期）

不以多 Pane Dashboard、复杂布局插件生态或复刻所有 Web React 页面为首要目标。
