本目录保存 2026-11-04 审查及后续修复使用的复现脚本和输出。初次审查对应提交 9205877b37cee494a5b355f9ee08d84bbd6995d8。

在仓库根目录执行：

    pnpm build
    node docs/reviews/2026-11-04-evidence/reproduce.mjs
    node docs/reviews/2026-11-04-evidence/ui.mjs
    node docs/reviews/2026-11-04-evidence/boundary.mjs

boundary.mjs 的 PTY 检查需要 Linux 和 python3。断言记录的是审查时存在的缺陷；修复相应功能后，部分断言预期会失败，应将对应场景转成正式回归测试。

reproduce.mjs 使用真实编译的插件、SocketBackend、HostConnection 和 Unix socket，但 DSH PluginContext 服务来自 support.mjs。CLI 场景使用模拟 wire server。support.mjs 从现有 tests/plugin-host.test.mjs 提取，并未加载真实 DSH Host。

ui.mjs 调用真实 runTui，使用 FakeBackend 和虚拟输入输出，截取 TerminalScreen.draw 的行与光标。ui-80x24.txt 是无 ANSI 的渲染结果，不是真实终端截图。boundary.mjs 额外使用真实 PTY 验证 CLI 分派。

以上三个脚本只向临时目录写入模拟配置与凭据；FAKE_SECRET_1/2 是固定假值，不访问用户的 DSH_HOME，不调用模型。ui.mjs 会更新本目录的 ui-80x24.txt。

reproduce.log、ui.log、boundary.log 是本次运行的原始输出。verification.txt 记录现有检查的结果与上游版本。报告中明确区分运行复现、静态实现证据和尚未进行真实 Host 验证的风险。

## Esc 与队列：真实 Host 验证

在仓库根目录执行，参数为已安装 DSH runtime 的绝对路径：

```bash
pnpm build
node docs/reviews/2026-11-04-evidence/queue-real-host.mjs /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

该脚本只读取 runtime，通过全新的临时 `DSH_HOME` 启动自己的 Host 并加载当前 `dist/plugin`。模型指向脚本内的本地 HTTP SSE 服务，使用固定假 key；不会发送外部或付费模型请求。它以真实 `SocketBackend` 和 `runTui` 执行 Esc、`/cancel`，在一个真实保持未结束的 SSE 请求后排入两个问题，核对首轮为 `aborted`、后两轮为 `completed`、FIFO、原 Host 消息 ID、每个请求只处理一次和最终空队列。

Host 还会请求会话标题并插入运行时上下文；脚本显式识别测试问题，标题请求单独完成，不会被误计为对话轮次。结束时仅停止脚本启动的 Host，清理临时 home 和本地模型服务。结果保存在 `queue-real-host.json`，其他最终检查见 `queue-verification.md`。
