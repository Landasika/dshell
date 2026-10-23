# P6 证据索引（兼容性与发布）

日期：2026-10-23
版本：`@landasika/dshell@0.1.0`（V1 candidate）
环境：Ubuntu 24.04.3 LTS，Node v24.21.0，pnpm 11.27.1
真实 Host：`.p0/dsh-home`，DSH `0.2.1-rc.2`

## 1. 测试与门禁

```text
$ ./scripts/ci.sh
...
ℹ tests 25
ℹ pass 25
ℹ fail 0
...
$ ./scripts/verify-pack.sh
dshell 0.1.0
installed plugin: dshell-host
b3499211449030d4005ad96b02bb0eca2072a888f2a3f71b792e7df38e569c76  /tmp/tmp.…/landasika-dshell-0.1.0.tgz
verified: landasika-dshell-0.1.0.tgz (85232 bytes)
```

本地 CI 包含：`pnpm install --frozen-lockfile`、typecheck、lint、test、
`verify-pack.sh`。Node 22 的 CI matrix 已配置；本机实际运行 Node 24.21.0。

## 2. tarball 内容断言

`verify-pack.sh` 断言：

```text
package/dist/plugin/index.js
package/dist/bin/dshell.js
package/cordis.patch.yml
```

且不包含：

```text
.p0 / .cache / docs/development / .credentials.yaml
```

## 3. 干净安装

在 `mktemp -d` 的独立 prefix 中：

```text
npm install --prefix "$tmp/app" --ignore-scripts landasika-dshell-0.1.0.tgz
$tmp/app/node_modules/.bin/dshell --version
# dshell 0.1.0
```

并直接 import 安装后的 plugin：

```text
installed plugin: dshell-host
```

## 4. 真实 Host 诊断

```text
$ DSH_HOME=.p0/dsh-home dshell doctor
[ok]   platform             linux
[ok]   node                 24.21.0
[ok]   DSH_HOME             /home/landasika/dshell/.p0/dsh-home
[ok]   socket               /home/landasika/dshell/.p0/dsh-home/run/dshell.sock
[ok]   socket mode          0600
[ok]   host                 plugin 0.1.0, dsh 0.2.1-rc.2
[ok]   protocol             2
[ok]   capabilities         list, attach, prompt, event, stream, status,
                            workspaces, create-session, history, cancel,
                            steer, approval
```

DSH 版本等于 `TESTED_DSH_VERSION`，没有 warning。

## 5. 版本矩阵

| dshell | DSH | 协议 | Node | OS | 结果 |
| --- | --- | --- | --- | --- | --- |
| 0.1.0 | 0.2.1-rc.2 | 2 | 24.21.0 | Ubuntu 24.04 x64 | 实测 |
| 0.1.0 | 0.2.1-rc.2 | 2 | 22.x | Ubuntu 24.04 | CI 配置，本机未跑 |
| 0.1.0 | 其他 | 2 | 22/24 | Linux | 未测试；doctor warning |

## 6. 发布产物

- `landasika-dshell-0.1.0.tgz`
- 85232 bytes
- SHA-256 `b3499211449030d4005ad96b02bb0eca2072a888f2a3f71b792e7df38e569c76`
- 该 hash 在本地 CI 的临时目录生成；CI/release workflow 会重新生成并写入
  `SHA256SUMS`。
- Git tag：`v0.1.0`（P6 合并后创建）。

## 7. CI / release 配置

- `.github/workflows/ci.yml`：Node 22/24 matrix，Ubuntu 24.04，包含
  `verify-pack.sh`。
- `.github/workflows/release.yml`：`v*` tag / manual，验证后上传
  `dshell-release` artifact（tarball + SHA256SUMS）。
- **GitHub Actions 未在本环境执行**；这里只验证了 workflow 文件与本地等价
  脚本。仓库远程推送和 Gitea PR 已执行。
- **npm publish 未执行**：需要 `@landasika` scope 凭据；`package.json` 已设置
  `publishConfig.access=public`。

## 8. 未覆盖

- macOS / Windows（V1 明确不支持）。
- 真实 npm registry 安装与 provenance/SBOM。
- DSH 其他版本的自动化矩阵（无可复现 tag 安装脚本）。
- 真实 pty 的 TUI 录制（沙箱限制，P4 Fake TTY 证据）。
