# P1 — 单 npm 包与原生插件集成（完成）

- 状态：**完成（scaffold + 可安装 tarball）**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/01-packaging.md`](../development/01-packaging.md)
- 设计记录：[`find/p1-revision.md`](../../find/p1-revision.md)
- 验收记录：[`find/p1-implementation.md`](../../find/p1-implementation.md)

## 1. 交付形态

一个 npm 包，两种用途：

| 用途 | 入口 |
| --- | --- |
| CLI | `bin.dshell` → `dist/bin/dshell.js` |
| DSH Host 插件 | `dist/plugin/index.js` + `cordis.patch.yml` |
| 协议类型 | `@landasika/dshell/protocol` |

`package.json` 中 `dsh.bundle.patch` 指向 `cordis.patch.yml`，因此：

```bash
dsh plugin --profile web add @landasika/dshell
```

会把插件加入 `dsh.profile.bundles`，由 DSH 原生 profile 机制加载；不复制、不捆绑 DSH Runtime。

## 2. 关键实现

- TypeScript + Node ESM，`engines.node = ^22.19.0 || >=24.0.0`；
- CLI 入口带 shebang，构建后由 npm 保留可执行权限；
- 默认 socket：`$DSH_HOME/run/dshell.sock`；
- 目录 `0700`、socket `0600`，不使用 token/Cookie；
- `doctor` / `list` / `attach` / `prompt` 四个 P1 命令；
- 插件在 Host boot 时加载，CLI 不 spawn 第二个 Host；
- cold session resume 使用 `agentPresets` + `agentDefaultModel` 组装 preset/model。

## 3. 构建与检查

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm pack
```

`pnpm test` 当前为 6 个测试：协议常量、socket 路径解析、fake socket 握手/list/prompt、错误映射、缺 socket 映射。

CI 配置见 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)：

- Ubuntu 24.04；
- Node 22 与 24 matrix；
- `pnpm install --frozen-lockfile`、`typecheck`、`lint`、`test`、`pack`。

本地一键检查：`scripts/ci.sh`。

## 4. 干净环境 tarball 验收

使用 `npm pack` 产物安装到临时全局 prefix，并使用全新的 `DSH_HOME`：

```text
npm pack                      → landasika-dshell-0.1.0.tgz (23,594 bytes, 43 files)
临时 prefix 安装              → @landasika/dshell 0.1.0
全新 profile 安装插件         → dsh plugin --profile web add <tarball>
Host 启动                     → [dshell-host] listening on .../run/dshell.sock
dshell doctor                 → 全部 [ok]
dshell list                   → session-... live
dshell prompt                 → TARBALL_OK
Host 重启后 cold session      → TARBALL_RESUME_OK
```

在干净环境里 `dshell` 可以连接外部已运行的 DSH Host，未修改 DSH 源码，未捆绑 DSH Runtime。

## 5. 依赖策略

- 运行时只依赖 Node 内置模块；
- 不在 `dependencies` / `peerDependencies` 中声明整套 DSH 包；
- `@types/node` 与 `typescript` 仅为 devDependencies；
- 移除 `peerDependencies` 的原因：pnpm 会自动安装 500+ 个 DSH 包，破坏“外部 Host”边界。兼容性由启动时握手/版本检查负责，P6 再补正式矩阵。

## 6. 已知限制

1. `@landasika/dshell` 尚未发布到 npm；当前用本地路径或 tarball 安装。
2. 没有 `dshell setup`；安装插件仍需 `dsh plugin --profile web add`。
3. 重复 Host 启动时插件会报 “already listening”，但 Cordis 只警告、Web 仍会启动；不要手动启动第二个 Host。
4. P1 不含审批回答、TUI、`-p`；这些在 P3–P5 完成。

## 7. 验收对照

| 计划验收项 | 结果 |
| --- | --- |
| 单 TypeScript/ESM 项目 | 完成 |
| `bin.dshell` 与 shebang | 完成 |
| CLI 安装 + 连接已有 Host | 完成（本地路径 + tarball） |
| `./plugin` 导出 + Bundle/Patch | 完成 |
| 不捆绑 DSH Runtime | 完成 |
| 依赖策略 | 完成 |
| build/test/typecheck/lint/pack | 完成 |
| 干净目录 tarball 测试 | 完成 |
