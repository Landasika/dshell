# dshell 0.7.1 演示 · 分镜与录制

约 1 分 42 秒，1080p30，无音轨。用真实 TUI 和脚本化的会话展示键盘操作，字幕为中文。

| 时间 | 画面 |
| --- | --- |
| 0:00–0:13 | 片头、历史会话和中文输入，按 `Enter` 发送 |
| 0:13–0:30 | 工具调用折成一行，连续中文边输出边折行，随后展示 Markdown 表格和代码块 |
| 0:30–0:44 | `Alt+↑` 选中工具调用，`Enter` 看详情，`Ctrl+O` 展开，`?` 查键位 |
| 0:44–0:58 | 运行中按 `Enter` 插话，`Alt+Q` 排队，`Esc` 停止当前回合并接续队列 |
| 0:58–1:05 | 输入 `$` 查看技能菜单，`Tab` 补全，发送时转换为 Host 的 `/name` 语法 |
| 1:05–1:17 | `/model` 切换模型；单选问题用方向键移动，`Enter` 确认 |
| 1:17–1:28 | `/sessions` 查看会话列表并切换会话 |
| 1:28–1:34 | 终端收到审批，按 `a` 允许一次 |
| 1:34–1:42 | 片尾与快捷键 |

## 重新录制

运行 `docs/promo/record.sh`。需要 Node.js、pnpm、ffmpeg、Python 3、Pillow、fontTools 和 Noto Sans Mono CJK 字体。

`demo.mjs` 用 `FakeBackend` 向真实 `runTui` 提供脚本化事件，将 ANSI 输出和字幕记入 `out/`。不需要连接 DSH Host 或模型。`render.py` 按 15 fps 回放终端输出，加上窗口边框和字幕，再用 ffmpeg 编码为 1080p30。

提交的产物是 `out/dshell-promo.mp4` 和 `out/poster.png`。帧和时间戳是可重新生成的中间文件。改演示内容或字幕时，编辑 `demo.mjs` 中的台词和 `caption()` 调用，再重新录制。
