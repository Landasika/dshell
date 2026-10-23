# P1 — 单 npm 包与原生插件集成

**目标**：确保 dshell 是一个独立发布的 npm 包，而不是 Mayfly 那种捆绑 DSH Runtime 的发行物。

## 工作包

- [ ] 建立 TypeScript + Node.js ESM 项目，锁定最低 Node 版本并由 CI 验证。
- [ ] `package.json` 提供 `bin.dshell`；打包时确保 shebang 与可执行权限正确。
- [ ] 明确安装方案：CLI 本地/全局安装、连接已运行 DSH Host；可选 DSH 插件安装用于补足 Host 能力。
- [ ] 如需 Host 插件，提供 `./plugin` 导出与适配 DSH 的 Bundle/Patch 清单；使用原生 Profile 安装方式。
- [ ] 不随包解压或安装私有 DSH Runtime；不自建不可控的 DSH 守护进程。
- [ ] DSH 包依赖策略：区分运行时客户端依赖、peerDependencies 与仅用于测试的 devDependencies。
- [ ] 建立 `pnpm build`, `test`, `typecheck`, `lint`, `pack`。
- [ ] 用 `npm pack` 的产物做“干净目录”安装测试，避免仅在 monorepo 中可运行。

## 交付物

- 一份可发布的 npm tarball（包含 CLI 和必要时的插件入口）。
- 完整的本地安装、Host 配置、启动与卸载说明。

## 验收标准

在干净环境中安装打包产物，执行 `dshell --help`，能连接外部现有 DSH Host，不修改 DSH 源码，不捆绑 DSH Runtime。

## 兼容提醒

DSH App Boot 当前文档说明会按 `peerDependencies` 对 `@deepseek-ai/dsh*` 的范围进行 Profile admission 检查；**不能只靠 `engines.dsh` 作为兼容保证**。以实际选用版本的运行校验为准。
