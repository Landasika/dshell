# P5 — 完整 CLI 与自动化工作流

**目标**：TUI 是一种界面，CLI 自身也要能用于 Shell 脚本、CI 和其他 Agent。

## 工作包

- [ ] 正式定义命令与兼容策略（示例：`dshell`、`dshell -p`、`dshell sessions`、`dshell attach`）。
- [ ] 交互式 `dshell`、单次 `-p`、stdin 管道三种入口共享同一 Adapter。
- [ ] `text`/`json`/`stream-json` 等输出格式；定义 NDJSON schema 和事件顺序规则。
- [ ] 标准输出/错误输出划分、退出码、SIGINT 与超时规则。
- [ ] Session 恢复、指定 Workspace/Host、无权限或失联时的明确提示。
- [ ] Model/Settings/Skills/MCP/Tools 发现与常用操作优先沿用 DSH Host 能力。
- [ ] Slash Commands、`@` 文件路径与历史补全保持与 TUI 一致。
- [ ] 对不支持交互审批的非交互模式执行明确策略（失败/显式用户配置），不可静默通过。

## 验收标准

- `dshell -p "..."` 可用于 Shell Pipeline 并返回稳定退出码。
- `--output-format stream-json` 产物可被逐行 JSON 解析；诊断不会污染 stdout。
- CLI 与 TUI 的权限决策一致，非交互模式不会绕过审批。
- 两个终端及一个脚本同时连接同一 Host，不产生重复业务真相。
