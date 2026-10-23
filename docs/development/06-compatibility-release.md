# P6 — 兼容性、测试、质量与发布

**目标**：在单 npm 包基础上提供可明确验证的 DSH 兼容范围，形成可长期升级的产品。

## 工作包

- [ ] 建立 DSH 版本测试矩阵：最低支持版、最新验证版、候选版（有发布时）。
- [ ] 对每个版本运行连接、权限、Session/Workspace、实时流、恢复、取消与审批契约测试。
- [ ] 固定 CI 的 DSH tag/commit，定期在新版本上重复验证；发现变更仅修改 Adapter。
- [ ] 若 DSH 提供并使用 `peerDependencies` 兼容校验，声明实际测试过的 semver 范围。
- [ ] macOS / Linux / Windows 的构建、终端显示、打包产物与基础交互回归。
- [ ] 从 Mayfly 迁移交互回归测试与有价值的纯渲染模块；清理旧同进程依赖。
- [ ] 完成 `npm pack`、干净安装、升级/降级、卸载流程。
- [ ] 撰写 README、Quickstart、Troubleshooting、Supported DSH Versions 与 CHANGELOG。
- [ ] 发布预发布版本进行验证，再发布 V1；后续兼容扩展只在测试通过后宣传。

## 版本策略

- dshell 自己使用独立 SemVer，例如 `0.x` 开发阶段、成熟后 `1.x`。
- DSH 版本不与 dshell 版本一一对应。
- 只承诺**测试通过的兼容版本范围**，不保证所有未来升级都无影响。
- Host 功能缺失时优先按 capability 降级；不安全或不可兼容的核心功能必须 fail closed。

## V1 最终验收

- [ ] 安装一个 dshell npm 包即可获得 CLI，且无需修改 DSH 本体。
- [ ] 连接既有 Host 并使用多 Workspace / Session。
- [ ] 断开终端不终止 Host；重新连接无明显历史/状态丢失。
- [ ] 完整审批/权限策略与 DSH Host 一致。
- [ ] TUI、headless、文本/结构化输出可用。
- [ ] 至少覆盖声明支持的 DSH 版本与计划发布的操作系统。
- [ ] 对不支持的 DSH 版本提供可理解的诊断与升级建议。
