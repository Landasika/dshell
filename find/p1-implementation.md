# P1 实现记录：`@landasika/dshell`

> 状态：P1 scaffold 已实现并通过本机验收。
> 设计输入见 [`p1-revision.md`](./p1-revision.md)；本文只记录“实际做成了什么、怎么验证、和设计有什么差异”。

## 1. 交付物

```text
仓库根目录 = 一个 npm 包 @landasika/dshell@0.1.0
├── package.json            # bin + plugin 双入口、dsh.bundle.patch
├── cordis.patch.yml        # Host 插件挂载行
├── tsconfig.json
├── src/
│   ├── bin/dshell.ts       # CLI shebang 入口
│   ├── cli/                # doctor / list / attach / prompt
│   ├── client/             # Unix socket 客户端 + 握手/错误映射
│   ├── protocol/           # protocol 1、NDJSON 消息、错误码
│   ├── plugin/             # dshell-host Cordis 插件
│   └── shared/             # socket 路径、包版本
├── tests/                  # 协议 + socket 客户端测试
├── dist/                   # tsc 产物（gitignore）
└── README.md
```

`package.json` 关键点：

- `bin.dshell = ./dist/bin/dshell.js`
- `main` / `exports["."]` / `exports["./plugin"]` = `./dist/plugin/index.js`
- `dsh.bundle.patch = ./cordis.patch.yml`
- `files = ["dist/", "cordis.patch.yml", "README.md"]`

## 2. P1 命令

```bash
dshell doctor
dshell list
dshell attach <sessionId>
dshell prompt <sessionId> <text...>
```

全局选项：

```text
--socket <path>     覆盖 control socket
--timeout <ms>      prompt 等待 turn/end 的超时，默认 120000
--verbose           打印上下文/生命周期事件
```

## 3. 已验收的路径

### 3.1 构建与单测

```text
pnpm install
pnpm build
pnpm test
```

结果：`6` 个测试全部通过。

覆盖：

- protocol 1 / capabilities；
- `DSH_HOME` 推导 socket 路径；
- `--socket` 覆盖 `DSHELL_SOCKET`；
- 真实 Unix socket 上的 `hello → welcome → list → prompt`；
- Host 握手 `error` 映射为 `DshellError`；
- 不存在的 socket 映射为 `HOST_NOT_RUNNING`。

### 3.2 本地路径安装 + 真实 Host

在一个临时 `DSH_HOME` 中：

```bash
dsh plugin --profile web add "$PWD"
dsh --profile web --no-open --port 3099
```

验证：

- Host stderr 出现 `[dshell-host] listening on .../run/dshell.sock`；
- profile `bundles` 自动追加 `@landasika/dshell`；
- `dshell doctor` 全绿：

```text
[ok] platform / node / DSH_HOME / socket / socket mode
[ok] host      plugin 0.1.0, dsh 0.2.1-rc.2
[ok] protocol  1
[ok] capabilities list, attach, prompt, event, stream, status
```

- `dshell list` 能看到 Web 创建的 session；
- `dshell prompt <id> "Reply with exactly P1_OK..."` 输出：

```text
[accepted] dshell-...
[user] ...
[assistant] P1_OK
[turn] completed
```

- `dshell attach <id>` 回放历史并保持监听，Ctrl-C 退出。

### 3.3 `npm pack` + 干净安装

```bash
npm pack
npm install -g --prefix /tmp/dshell-prefix /path/to/landasika-dshell-0.1.0.tgz
```

验证：

- 临时前缀下 `dshell --version` 输出 `dshell 0.1.0`；
- 在全新 `DSH_HOME` 中 `dsh plugin --profile web add <tarball>` 成功；
- 启动 Host 后 `dshell doctor` 全绿，`dshell list` 正常；
- tarball 中只包含 `dist/`、`cordis.patch.yml`、`README.md`、`package.json`。

### 3.4 同一 Host、两个前端

用 Web 侧 raw `session/follow` 跟随同一个 session，同时从 CLI 发 prompt：

```text
CLI: [user] ... [assistant] CONCURRENT_OK [turn] completed
Web: event 3 agent/inbox/spliced
     event 4 turn/start
     ...
     event 18 assistant/message
     event 20 turn/end
```

结论：Web 和 CLI 看到的是同一个 Host 中的同一条 session 事件流；CLI 不是只读看板。

### 3.5 冷会话恢复

Host 重启后 session 变成 `cold`：

```text
$ dshell list
session-...  cold  /path/to/work

$ dshell attach session-...
[attached] ... history=22
# attach 只读历史，不会为了看历史而 resume Agent

$ dshell prompt session-... 'Reply with exactly RESUME_OK...'
[accepted] dshell-...
[assistant] RESUME_OK
[turn] completed
```

`prompt` 恢复 cold session 时，插件会：

1. 用 `sessionQuery.observeSession(..., { projectionMode: 'all' })` 读取 `agentPreset` 和 `modelSelection.lastUsed`；
2. 用 `agentPresets.resolve()` + `agentPresets.mount()` 组装 preset；
3. 把 session 的模型选择（缺省时回退到 `agentDefaultModel.currentSelection()`）传给 `ctx.agents.resume()`。

没有这一步时，`agents.resume()` 会报：

```text
prompt variable "{{model}}" has no value for this assembly
```

### 3.6 清理

- Host 停止后 `$DSH_HOME/run/dshell.sock` 被删除；
- `dshell list` 在 Host 停止后返回 `HOST_NOT_RUNNING`，不会自动 spawn；
- CLI 断开不会 dispose Host 中的 Agent；CLI 断开后 `dshell list` 仍显示 `live`。

## 4. 与设计稿的差异

1. **包名已确定**：`@landasika/dshell`，命令名仍是 `dshell`。
2. **源码在仓库根目录**，不是设计稿里的独立 `bin/` + `src/` 顶层结构；构建产物统一进 `dist/`。
3. **`peerDependencies` 暂不声明**：本机 pnpm 会自动安装 peer，导致仓库被 500+ 个 DSH 依赖污染；P1 改为由 `welcome.dshVersion` 报告版本，兼容性硬校验放到发布前。
4. **`attach` 只做 snapshot + 后续事件**：没有分页、cursor 回填、重连。
5. **没有 TUI、审批回答、`-p`、命令、todo/plan/subagent 面板**；这些仍在 P2–P4 / M2。
6. **`SO_PEERCRED` 未实现**；P1 依赖 `0700` 目录 + `0600` socket + 同 UID。
7. **插件 inject 了 `agentPresets` 和 `agentDefaultModel`**：这是 cold resume 正确组装 preset/model 所必需的；P1 以 Web profile 为目标，headless profile 不作为验收对象。
8. **同一 socket 上的消息串行处理**：插件用 per-socket promise 链保证 `attach`/`prompt` 顺序，避免并发 resume 同一 session。

## 5. 已知问题

- **重复 Host 不会 fatal**：第二个 Host 用同一个 `DSH_HOME` 启动时，`dshell-host` 的 `apply()` 抛错，Cordis 只记录 `1 entry did not activate`，Web 仍会继续启动。此时 dshell 仍连旧 Host；不要手动启动第二个 Host。
- `doctor` 要求 socket mode 精确为 `0600`；如果用户改了 umask/权限，会报错而不是自动修复。
- `npm pack` 在本机需要可写 npm cache，这是环境问题，不是包问题。
- 审批仍未桥接。没有 answerer 时审批会挂起；CLI 现在不回答审批，只显示 `[approval]`。

## 6. 下一步

按优先级：

1. **M2 审批桥接**：`approval/request`、first-answer-wins、`eventId` 幂等、超时 fail-closed；
2. **P2 历史/控制**：`history/page`、`session/cancel`、`session/steer`、命令列表；
3. **P3 产品化**：TUI 布局、工具卡片、todo/plan/subagent 渲染；
4. **发布前**：确认 `@landasika` scope、补 peer 兼容性策略、CI（Ubuntu 24.04 + Node 22/24）。
