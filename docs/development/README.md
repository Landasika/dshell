# dshell 开发目录（V1）

> 目标：一个独立发布的 Node.js/TypeScript npm 包，以 DSH 原生插件/Bundle 方式集成，连接已有 DSH Host，提供 Claude Code / Codex 风格的 CLI/TUI。文档是实施计划，并不表示对应能力已经实现。

## 架构边界

- **一个 npm 包**：CLI、TUI、Client Adapter 和（必要时）Cordis Host 插件入口在同一发布单元内。
- **不捆绑或 fork DSH Runtime**；不修改 DSH 源码，不复制 DSH 的 Agent Loop / Session Persistence / Tools / Policies。
- **Host 保有权威状态**；dshell 只保存本地 UI 选择、草稿、显示设置等临时状态。
- **复用 DSH 对外的 Connection / Remote API / React-free Client Models**；全部 DSH 依赖通过 `adapter/` 隔离。
- **dshell 退出不等于取消 Session**：DSH Host 存活时，已启动任务继续按 DSH 规则运行；审批待处理不能自动放行。
- **版本兼容靠测试与功能协商**：不承诺兼容所有未来 DSH 版本，不假设某个私有导出永远稳定。

## 七阶段目录

| 阶段 | 文档 | 可验收成果 | 依赖 |
| --- | --- | --- | --- |
| P0 | [00-feasibility.md](./00-feasibility.md) | Node 客户端跨进程连接与审批 PoC | 无 |
| P1 | [01-packaging.md](./01-packaging.md) | 单 npm 包 + CLI/插件安装路径 | P0 |
| P2 | [02-adapter.md](./02-adapter.md) | 稳定的 DshellBackend 适配层 | P0–P1 |
| P3 | [03-session-core.md](./03-session-core.md) | 无复杂 UI 的多 Workspace / 多 Session CLI | P2 |
| P4 | [04-tui.md](./04-tui.md) | Claude Code / Codex 风格 TUI | P3 |
| P5 | [05-product-cli.md](./05-product-cli.md) | 完整命令与自动化模式 | P3–P4 |
| P6 | [06-compatibility-release.md](./06-compatibility-release.md) | 多版本兼容性验证与 V1 发布 | P0–P5 |

## 目录建议（**一个** npm 包，并非多个安装包）

```text
dshell/
├── package.json
├── src/
│   ├── bin/                 # dshell 可执行命令
│   ├── plugin/              # 必要时的 DSH Cordis / Bundle 入口
│   ├── adapter/             # 唯一直接接触 DSH 客户端 API 的边界
│   │   ├── connection/
│   │   ├── session/
│   │   ├── workspace/
│   │   ├── interactions/
│   │   └── compatibility/
│   ├── application/         # 用户命令、活动视图、导航、退出行为
│   ├── presentation/        # 与终端库解耦的展示模型
│   ├── tui/                 # terminal 组件、渲染、输入和快捷键
│   └── print/               # 非交互文本 / JSON / NDJSON
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   └── e2e/
└── docs/development/       # 本目录
```

`cordis.patch.yml` 和 `package.json:dsh.bundle.patch` **只有在确实需要 DSH Host Bundle 时才添加**。不要仅为了“看上去像插件”而在 Host 上复制业务服务。CLI 可执行入口与 DSH Bundle 是同一个 npm 包中的两个用途。

## 总验收场景

1. DSH Host 独立运行；dshell 作为 Node.js Client 连接。
2. 两个 dshell 终端能连接同一 Host、观察不同或相同 Session。
3. 在 Session A 执行任务期间关闭终端 A，Host 不停止；重新连接后状态与历史一致。
4. Session B 与 Session A 可以在 DSH 允许的范围内并行运行。
5. 同一审批请求不被两个客户端重复有效处理，权限由 Host 决定。
6. 交互模式与 `-p` 非交互模式共享同一后端接口和安全策略。
7. 对已验证的 DSH 版本给出兼容矩阵；不支持的版本报可理解的错误。

## 设计参考（以实测为准）

- DSH: https://github.com/deepseek-ai/deepseek-harness
- DSH Web Client 架构: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md
- DSH Connection: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md
- DSH Session Controller: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md
- DSH App Boot/Profile: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md
- Mayfly (交互经验参考): https://github.com/Ephemeral-AI-Lab/mayfly
