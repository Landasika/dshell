# P6 — 兼容性、测试、质量与发布（完成）

- 状态：**完成（V1 candidate `0.1.0`）**
- 完成时间：2026-10-23
- 原始计划：[`docs/development/06-compatibility-release.md`](../development/06-compatibility-release.md)
- 前置阶段：[P0](./00-feasibility.md) · [P1](./01-packaging.md) · [P2](./02-adapter.md) · [P3](./03-session-core.md) · [P4](./04-tui.md) · [P5](./05-product-cli.md)
- PR：[Gitea #7](http://192.168.8.77:3000/Landasika/dshell/pulls/7)
- 证据：`find/p6-evidence.md`

## 1. 版本矩阵

V1 只承诺 **Linux x64 + 已测试的 DSH/Node 组合**：

| dshell | DSH | 协议 | Node | OS | 状态 |
| --- | --- | --- | --- | --- | --- |
| `0.1.0` | `0.2.1-rc.2` | 2 | `^22.19.0 \|\| >=24.0.0` | Ubuntu 24.04 x64 | **Tested** |

实际验证环境：

```text
Ubuntu 24.04.3 LTS
Node v24.21.0
pnpm 11.27.1
DSH 0.2.1-rc.2
Mayfly CLI runtime 0.1.4-rc.1-0.2.1-rc.2-linux-x64
```

CI 覆盖 Node 22 / Node 24 的 **构建、类型、测试、打包和干净安装**，但不启动
真实 DSH Host；真实 Host 契约由 P0–P5 的手工/集成证据覆盖。P6 没有 DSH 的
可下载 tag 清单来跑多版本矩阵，因此不虚构“支持范围”：只声明
`0.2.1-rc.2`，其他版本由 `doctor` 给出 untested 警告。

macOS / Windows 明确 **不支持**：

- 传输是 Unix domain socket；
- 插件用 `chmod`/文件 mode 控制访问；
- 没有平台抽象层或 Windows named pipe 实现。

`docs/SUPPORTED-VERSIONS.md` 是面向用户的版本承诺；本文件记录依据。

## 2. 兼容策略

1. **Capability first**：Host `welcome` 的 capabilities 决定可选功能；缺失时
   返回 `UNSUPPORTED_CAPABILITY`/`CAPABILITY_MISSING`，不猜测。
2. **协议版本 fatal**：CLI 与插件协议不一致直接
   `PROTOCOL_MISMATCH`，不做半兼容。
3. **Core fail closed**：审批超时、断线、非 TTY、非交互模式都不会自动
   allow。
4. **DSH 版本仅诊断**：`dshell doctor` 对比
   `TESTED_DSH_VERSION = 0.2.1-rc.2`；不一致显示 `[warn] dsh version`，
   不硬拒绝，因为真正的契约是 capability handshake。
5. **无 DSH peerDependency**：插件在 Host 内部运行；CLI 不 import DSH。
   安装 dshell 不会拖入第二棵 DSH 依赖树（P1 的 556 包问题因此消失）。
6. **降级只改 Adapter**：DSH 升级时优先改 `src/plugin` 与
   `src/backend/socket.ts`；CLI/TUI 只依赖 `DshellBackend`。

## 3. CI 与发布流水线

### 3.1 CI

`.github/workflows/ci.yml`：

```text
Ubuntu 24.04 × Node 22, 24
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm lint
  pnpm test                 # 25 tests
  pnpm pack
  ./scripts/verify-pack.sh
```

`verify-pack.sh` 是发布门禁，不是普通的 `npm pack`：

- 构建 tarball；
- 断言包含 `dist/plugin/index.js`、`dist/bin/dshell.js`、
  `cordis.patch.yml`；
- 断言不包含 `.p0`、`.cache`、`docs/development`、`.credentials.yaml`；
- 在临时目录 `npm install` 该 tarball；
- 运行安装后的 `dshell --version`；
- 导入安装后的 plugin，断言导出 `dshell-host`；
- 输出 SHA-256 和字节数。

### 3.2 Release workflow

`.github/workflows/release.yml` 在 `v*` tag 或手动触发时：

1. 重复完整 CI；
2. 运行 `verify-pack.sh`；
3. 在 `dist/release/` 生成 tarball 和 `SHA256SUMS`；
4. 上传 `dshell-release` artifact。

**不自动 npm publish**：仓库没有配置 `NPM_TOKEN`，也没有宣称已经发布。
发布者需要手动执行：

```bash
npm publish --access public dist/release/landasika-dshell-0.1.0.tgz
```

（`package.json` 已设置 `publishConfig.access = "public"`；实际发布需有
`@landasika` scope 权限和 2FA。）

## 4. 干净安装与升级

### 4.1 从 tarball 安装

```bash
npm install -g ./landasika-dshell-0.1.0.tgz
dsh plugin --profile web add @landasika/dshell
dshell --version
dshell doctor
```

本地开发也可以 `dsh plugin --profile web add "$PWD"`，但这是路径安装，不是
发布产物的验证路径。

### 4.2 升级

1. 停 Host；
2. 安装新 CLI/插件；
3. 重新执行 `dsh plugin --profile web add @landasika/dshell`；
4. 启动 Host，`dshell doctor`；
5. 跑一个 TUI turn 和一个 `-p` smoke test；
6. 协议版本变化时 CLI 与插件必须一起升级。

### 4.3 降级 / 卸载

```bash
npm uninstall -g @landasika/dshell
dsh plugin --profile web remove @landasika/dshell
```

`DSH_HOME` 下的 Session durable history 不受 dshell 卸载影响；dshell 不拥有
Session 存储。重装后仍可 `list/attach`。

### 4.4 产物

本次本地发布候选：

```text
landasika-dshell-0.1.0.tgz
85232 bytes
SHA-256 b3499211449030d4005ad96b02bb0eca2072a888f2a3f71b792e7df38e569c76
```

该 hash 对应 P6 最终构建；CI 每次会重新计算。发布页应附 `SHA256SUMS`。

## 5. TUI / CLI / 脚本一致性

- 三种入口共享 `SocketBackend`/`SessionHandle`：
  - TUI：一个活动 Session，后台 5s 轮询其他 Session；
  - `-p`：一次 turn，结构化输出；
  - `prompt/steer/cancel`：低层命令。
- 它们都通过同一个 Host 的 `ctx.agents`/`ctx.sessions` 读写，durable event
  只有一份。
- 审批策略一致：TTY 询问、非 TTY 拒绝、`-p` 拒绝、断线 fail closed。
- 两个终端加一个脚本同时连接同一 Host 时，不会产生第二份业务真相；P3 的
  多 watcher 验证覆盖同一 Session 的 fanout。

## 6. 质量门禁与测试

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint`（TS noEmit） | 通过 |
| `pnpm test` | **25/25** 通过 |
| `scripts/verify-pack.sh` | 通过；安装后 `dshell 0.1.0`、plugin `dshell-host` |
| Node 22 | CI matrix 配置；本地实际 Node 24 |
| Node 24 | 本地与测试通过 |
| 真实 Host 连接/流/审批/取消/steer | P3–P5 证据 |
| 非交互审批 fail closed | P5 测试 + 真实 Host exit 5 |
| 无 pty 的 TUI | Fake TTY smoke；真实 pty 受沙箱限制 |
| macOS/Windows | 不支持，doctor 明确报错 |

测试分布：

- protocol/client: 6；
- backend: 4；
- TUI: 10；
- print/CLI: 5；
- 合计 25。

## 7. V1 最终验收对照

| 计划验收项 | 结果 |
| --- | --- |
| 安装一个 dshell npm 包即可获得 CLI，无需修改 DSH 本体 | 包结构/干净安装已验证；npm 发布为手动步骤 |
| 连接既有 Host 并使用多 Workspace/Session | P3 验证 |
| 断开终端不终止 Host；重连无明显历史丢失 | P3/P4 设计 + dispose/attach 证据 |
| 完整审批/权限策略与 Host 一致 | 共用 Host bridge，first-answer-wins |
| TUI、headless、文本/结构化输出可用 | P4/P5 |
| 声明支持的 DSH 版本与 OS | `0.2.1-rc.2` / Linux |
| 不支持版本有可理解诊断 | `doctor` warning / protocol mismatch |

## 8. 已知限制与风险

1. **仅 Linux x64 实测**；其他 Linux 架构未跑矩阵。
2. **DSH 多版本未自动化**：没有可复现的 DSH tag 安装脚本；只有
   `0.2.1-rc.2` 证据。CI 不启动真实 Host。
3. **npm 未发布**：发布需要 scope 权限；仓库只产出可验证 tarball。
4. **TUI 真实 pty 录制**受 DSH 沙箱限制；使用 Fake TTY 覆盖数据路径。
5. **TUI 单活动 Session**；非活动 Session 只轮询状态，不实时 fanout 审批。
6. **协议 v2 是私有协议**；DSH 升级可能改 `ctx.agents`/approval waterfall，
   需要按 P2 的 Adapter 边界修复。
7. **Node 22 未在本机运行**；CI 配置覆盖，实际证据是 Node 24。
8. 没有 npm provenance/SBOM 自动生成；`SHA256SUMS` 是当前校验手段。

## 9. 发布检查清单

- [x] `package.json` 版本 `0.1.0`，`private:false`，`publishConfig.access=public`
- [x] `CHANGELOG.md`
- [x] `docs/SUPPORTED-VERSIONS.md`
- [x] CI matrix Node 22/24
- [x] `verify-pack.sh` 干净安装
- [x] release workflow artifact + SHA256SUMS
- [x] README Quickstart / Troubleshooting / Support
- [x] `pnpm test` 25/25
- [x] 本地 tarball hash 记录
- [ ] 真实 npm publish（需要 scope 凭据，不在本仓库自动执行）
- [x] Git tag `v0.1.0`（合并后打 tag；见 release evidence）
