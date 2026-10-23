# P1 修订：Linux 优先的 CLI + Host 插件发布单元

> 状态：设计决策，尚未实现。  
> 本文只修订 `docs/development/01-packaging.md` 的方向，不改原文档；原始计划保留作历史对照。

## 0. 已拍板的范围

**V1 只支持 Linux。**

- 只保证 Linux 上的 Unix domain socket、文件权限和进程行为；
- 不承诺 macOS、Windows；
- Windows named pipe、macOS 打包和签名放到后续版本；
- Node 版本沿用 DSH 的要求：`^22.19.0 || >=24.0.0`，CI 以 Linux + Node 24 为主。

这意味着 P1 的验收环境是：

```text
Linux
  ├─ Node 24.x
  ├─ pnpm 11.x
  └─ dsh 0.2.1-rc.2 (profile web)
```

## 1. P1 目标重写

原目标：

> 确保 dshell 是一个独立发布的 npm 包，而不是捆绑 DSH Runtime 的发行物。

新目标：

> 发布一个 npm 包，同时提供 **CLI 前端**和 **DSH Host 控制面插件**；CLI 通过同机 Unix socket attach 到已运行的 DSH Host，成为 Web 之外的第二个完整前端。

关键词：

- **一个包，两个入口**：`bin.dshell` + `./plugin`；
- **一个 Host**：CLI 不启动第二个 Host；
- **同机**：只走 Unix socket，不走 HTTP token；
- **可安装、可诊断、可卸载**：P1 的交付边界。

## 2. 安装拓扑

```text
                    npm tarball: @scope/dshell
                    ├─ bin/dshell.mjs          → 全局 CLI
                    └─ plugin/index.js         → DSH profile 插件
                              │
              ┌───────────────┴───────────────┐
              │                               │
   npm i -g @scope/dshell          dsh plugin --profile web add @scope/dshell
              │                               │
        dshell 命令                  profile 的 bundles 增加 @scope/dshell
                                              │
                                     dsh --profile web 启动时加载
                                              │
                                     $DSH_HOME/run/dshell.sock
                                              │
                                        dshell CLI attach
```

### 为什么是两次安装

- 全局安装提供 `dshell` 可执行文件；
- profile 安装把**同一个包**放进 Host 的模块解析路径，并通过 `dsh.bundle.patch` 自动挂载插件；
- 只做全局安装，Host 不知道插件存在；
- 只做 profile 安装，终端里没有 `dshell` 命令。

P1 先接受两步安装，后续可以加 `dshell setup` 封装，但 P1 不依赖它。

### profile 安装后的期望状态

`profiles/web/package.json`：

```json
{
  "dependencies": {
    "@scope/dshell": "0.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@scope/dshell"
      ]
    }
  }
}
```

`profiles/web/node_modules/@scope/dshell` 指向安装产物；`dsh.bundle.patch` 指向包内的 `cordis.patch.yml`。

## 3. 包结构

```text
dshell/
├── package.json
├── cordis.patch.yml          # Host 插件挂载行
├── bin/
│   └── dshell.mjs            # CLI 入口，shebang
├── src/
│   ├── cli/                  # 参数、命令、doctor
│   ├── client/               # Unix socket 客户端
│   ├── protocol/             # NDJSON 消息类型、版本、错误码
│   ├── plugin/               # dshell-host Cordis 插件
│   └── shared/               # 两端共享的纯类型/常量
├── tests/
│   ├── unit/
│   ├── protocol/
│   └── e2e/
└── README.md
```

`package.json` 的关键字段：

```json
{
  "name": "@scope/dshell",
  "type": "module",
  "bin": { "dshell": "./bin/dshell.mjs" },
  "exports": {
    ".": "./src/client/index.js",
    "./plugin": "./src/plugin/index.js",
    "./protocol": "./src/protocol/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "bin/",
    "src/",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh": "0.2.1-rc.2"
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  }
}
```

注意：

- `./plugin` 不能 import CLI 的 TUI/终端代码；
- CLI 不能 import `@deepseek-ai/dsh` 的 Host-only 模块；
- 两端只共享 `src/protocol` 和 `src/shared`；
- `@deepseek-ai/dsh` 只作为 peer，不捆绑 Runtime。

## 4. Host 插件契约

### socket 路径

默认：

```text
$DSH_HOME/run/dshell.sock
```

`DSH_HOME` 缺省时使用 `~/.dsh`。  
CLI 支持 `DSHELL_SOCKET` 覆盖，便于测试和多实例。

### 权限

- `$DSH_HOME/run/`：`0700`
- `dshell.sock`：`0600`
- 只允许同一 UID 访问；
- 不提供 TCP 监听；
- 不提供 token / Cookie / HTTP 认证。

P1 先依赖文件权限。`SO_PEERCRED` 需要 Node 原生扩展或非公开 handle，P1 不承诺；放到后续安全加固。

### 启动与退出

- 插件在 Host boot 时加载；
- 监听成功后输出：

```text
[dshell-host] listening on /home/<user>/.dsh/run/dshell.sock
```

- 启动时若 socket 已存在：
  - 先尝试 `connect`；
  - 能连上：说明已有 Host，报错退出，不抢占；
  - 连不上：视为 stale socket，删除后重建。
- 插件卸载时关闭 server、删除 socket，并 dispose 自己 resume 出来的 Agent handle；
- 不 dispose Web 拥有或别的 owner 创建的 Agent。

### 版本握手

`hello` / `welcome` 必须带：

```json
{
  "type": "welcome",
  "protocol": 1,
  "pluginVersion": "0.0.0",
  "dshVersion": "0.2.1-rc.2",
  "capabilities": ["list", "attach", "prompt", "event", "stream", "status"]
}
```

CLI 检查：

- `protocol` 不等于 1：`PROTOCOL_MISMATCH`
- 缺少必需 capability：`CAPABILITY_MISSING`
- 版本不在支持矩阵：`DSH_VERSION_UNSUPPORTED`

## 5. P1 协议范围

P1 只做“能看、能发、能诊断”，不做完整 TUI。

### CLI → Host

```json
{"type":"hello","protocol":1}
{"type":"ping"}
{"type":"list"}
{"type":"attach","sessionId":"session-..."}
{"type":"detach"}
{"type":"prompt","sessionId":"session-...","text":"...","mode":"queue"}
```

### Host → CLI

```json
{"type":"welcome","protocol":1,"pluginVersion":"...","dshVersion":"...","capabilities":[...],"sessions":[...]}
{"type":"pong","time":0}
{"type":"sessions","sessions":[...]}
{"type":"attached","sessionId":"...","header":{},"cursor":21,"events":[]}
{"type":"accepted","sessionId":"...","requestId":"..."}
{"type":"event","sessionId":"...","event":{}}
{"type":"stream","sessionId":"...","frame":{}}
{"type":"status","sessionId":"...","status":"running"}
{"type":"error","code":"...","message":"...","action":"..."}
```

### 错误码

| code | 含义 | CLI 动作 |
|---|---|---|
| `HOST_NOT_RUNNING` | socket 不存在 | 打印启动 Host 的命令 |
| `SOCKET_PERMISSION_DENIED` | 权限不足 | 提示检查 UID / `DSH_HOME` |
| `PLUGIN_MISSING` | 连上了但不是 dshell-host | 提示安装 profile 插件 |
| `PROTOCOL_MISMATCH` | 协议版本不一致 | 提示升级 CLI/插件 |
| `DSH_VERSION_UNSUPPORTED` | DSH 版本不在矩阵 | 打印已验证版本 |
| `SESSION_NOT_FOUND` | session 不存在 | 回到 `dshell list` |
| `SESSION_ALREADY_LIVE` | 重复 resume（内部错误） | 提示 attach 而不是 resume |

P1 不把底层异常直接抛给用户；错误必须带可操作提示。

## 6. `dshell doctor`

P1 必须包含，因为三种失败很容易混淆：

- CLI 没装；
- 插件没装；
- Host 没起 / 协议不对。

检查项：

```text
[ok]   node                 v24.x
[ok]   platform             linux
[ok]   DSH_HOME             /home/<user>/.dsh
[ok]   socket               /home/<user>/.dsh/run/dshell.sock
[ok]   socket mode          0600
[ok]   host process          running
[ok]   plugin version        0.0.0
[ok]   protocol              1
[ok]   dsh version           0.2.1-rc.2
[ok]   capabilities          list, attach, prompt, event, stream, status
```

失败时给出下一步命令，例如：

```text
[error] socket not found
        start the host: dsh --profile web
        install plugin: dsh plugin --profile web add @scope/dshell
```

## 7. 验收标准（替换原 P1 验收）

在干净 Linux 环境：

1. `npm pack` 生成 tarball；
2. 在临时目录 `npm i -g <tarball>` 后，`dshell --help` 可用；
3. 在临时 `DSH_HOME` 初始化 `web` profile；
4. `dsh plugin --profile web add <tarball>` 成功，`bundles` 包含 `@scope/dshell`；
5. 启动 `dsh --profile web`，stderr 出现 `[dshell-host] listening on ...`；
6. `dshell doctor` 全绿；
7. `dshell list` 能看到 Web 创建的 Session；
8. `dshell attach <id>` 收到历史；
9. CLI `dshell prompt <id> "..."` 后，Web 侧 `session/follow` 能看到同一条 `user/message`；
10. Web 侧发 prompt，CLI `attach` 实时收到事件；
11. 停掉 Host，`dshell list` 返回 `HOST_NOT_RUNNING`，不自动启动 Host；
12. 移除 profile bundle 后，socket 不再出现，CLI 明确报错；
13. `dshell` 进程退出不影响 Host 中的 Agent。

## 8. P1 明确不做

- TUI 布局、键盘、输入框、历史滚动；
- todo / plan / subagent / commands 的完整 UI；
- 审批回答（放到 M2，必须先于 `-p`）；
- `-p` 非交互模式；
- MCP / hooks / rewind 兼容；
- Windows / macOS；
- `SO_PEERCRED`；
- 自动 spawn Host；
- 自动安装插件。

## 9. 对 P2 的连带修订

原 P2 假设：

> 引入官方 Connection、Gateway、React-free Session Client Model。

修订为：

- 主路径是 `DshellSocketClient`，不是 HTTP Connection；
- `DshellBackend` 接口保留，但实现换成 socket；
- 错误模型改为：
  - `HOST_NOT_RUNNING`
  - `PLUGIN_MISSING`
  - `PROTOCOL_MISMATCH`
  - `DSH_VERSION_UNSUPPORTED`
  - `SOCKET_PERMISSION_DENIED`
- 官方 React-free Client Model 只作为语义参考，不作为运行时依赖；
- `SessionHandle` 的 `send/cancel/subscribe` 映射到 socket 消息；
- 历史分页、cursor、重连在 P2 定义，P1 只做 snapshot。

## 10. 对 P3/P4 的连带修订

- P1 的 `attach` 只返回当前 snapshot + 后续事件；
- P3 再加 `history/page`、`session/cancel`、`session/steer`、`command/list`、`command/run`；
- P4 再做 TUI 渲染、工具卡片、todo/plan 面板、subagent 树；
- 审批桥接（M2）独立于 P1，但必须早于 P3 的交互验收。

## 11. 待定

- 最终 npm scope 和包名（`dshell` 已被占用）；
- 是否在 P1 增加 `dshell setup`（建议 P1 后再做）；
- 是否在 P1 支持 `--socket` 参数（建议支持，等价于 `DSHELL_SOCKET`）；
- Linux 发行版矩阵（建议先 Ubuntu 24.04 + Node 24，CI 再加一个 Node 22）。
