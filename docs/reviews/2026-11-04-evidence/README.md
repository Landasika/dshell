本目录保存 2026-11-04 审查使用的复现脚本和输出，对应提交 9205877b37cee494a5b355f9ee08d84bbd6995d8。

在仓库根目录执行：

    pnpm build
    node docs/reviews/2026-11-04-evidence/reproduce.mjs
    node docs/reviews/2026-11-04-evidence/ui.mjs
    node docs/reviews/2026-11-04-evidence/boundary.mjs

boundary.mjs 的 PTY 检查需要 Linux 和 python3。断言记录的是审查时存在的缺陷；修复相应功能后，部分断言预期会失败，应将对应场景转成正式回归测试。

reproduce.mjs 使用真实编译的插件、SocketBackend、HostConnection 和 Unix socket，但 DSH PluginContext 服务来自 support.mjs。CLI 场景使用模拟 wire server。support.mjs 从现有 tests/plugin-host.test.mjs 提取，并未加载真实 DSH Host。

ui.mjs 调用真实 runTui，使用 FakeBackend 和虚拟输入输出，截取 TerminalScreen.draw 的行与光标。ui-80x24.txt 是无 ANSI 的渲染结果，不是真实终端截图。boundary.mjs 额外使用真实 PTY 验证 CLI 分派。

脚本只向临时目录写入模拟配置与凭据；FAKE_SECRET_1/2 是固定假值，不访问用户的 DSH_HOME，不调用模型。ui.mjs 会更新本目录的 ui-80x24.txt。

reproduce.log、ui.log、boundary.log 是本次运行的原始输出。verification.txt 记录现有检查的结果与上游版本。报告中明确区分运行复现、静态实现证据和尚未进行真实 Host 验证的风险。
