# 审查落地记录

状态：**已完成**（2026-11-04）。范围仅为 dshell；两个固定的 DeepSeek Harness 源码目录、已安装 DSH、用户配置和运行中的 Host 均保持只读。审查证据与原始复现见同目录 `2026-11-04-full-audit.md`。

- [x] F01/F02/F17 print：按 request/turn 归属输出，客户端规范化 cwd，统一全阶段 deadline，并区分断连、超时、失败、待审批/提问等终态；只清理本请求。
- [x] F03 RPC：协商 `rpc-id`，响应与错误按请求关联；旧 Host 超时后隔离连接；限制 8 MiB 输入帧并加入写缓冲背压保护。
- [x] F04/F05/F06 配置：YAML CST 定位 `llm-pi-ai` owner，优先 `configEditor`，文件回退使用锁、revision 检测和原子 rename；`provider/save` 一次提交多字段与密钥，冲突稳定返回 `CONFIG_CONFLICT`，失败回滚新 key，成功后仅退役旧的 dshell-owned key。
- [x] F07/F08/F09/F16 交互：保留 question `detail`/`intent`，校验会话、call、问题批次与答案；pending snapshot 可重放，重连重新 claim；审批和提问均支持多个待办切换、草稿保存和 first-valid-answer-wins。
- [x] F10/F13/F14/F15 UI：无显式子命令时正确进入 TUI；编辑、选择和复制按 grapheme 处理组合字符、ZWJ 与旗帜；小屏 composer/问题向导使用可滚动 viewport；启动会话列表保持单一数据源并按 sessionId 保持选择。
- [x] F11/F12 历史与资源：Host owner 真分页，attach 有界尾页，TUI 滚动补页；Socket/Fake/Replay handle dispose 后注销并释放历史与 waiter。
- [x] R01/R02/R03：移除物理 delete 行为，使用 archive/restore；会话创建、恢复、prompt 和提问优先委托 Host owner；自定义 relay 不套用 DeepSeek 官方价格，Herdr 同时报告审批/提问 blocked 状态。
- [x] 解耦：新增 Harness event adapter 与 dshell 规范事件，未知事件降级为 diagnostic；拆分 `ConversationBackend`/`AdministrationBackend`，提供只读 `ReplayBackend`，并从 package `./backend` 导出稳定 contract。
- [x] 扩展：rename/archive/restore/pin/fork；每会话 draft、审批模式和折叠粘贴状态持久化；工具 renderer registry 与未知工具 fallback；typed text/image/file prompt contract；Provider source/diff/遮罩与单事务保存。
- [x] App Host preview：`SessionSummary.preview` 从 durable tail 解析最后一条真实用户 prompt，过滤注入上下文，折叠空白并截断为 60 字；24 行/1.5 秒批次预算与 5 分钟缓存均在 `sessionCache` 写入前完成。
- [x] 验证：`pnpm typecheck`、全量测试、Provider/preview 专项测试、打包安装验证、diff whitespace 检查和两个上游目录只读检查。

兼容边界：首批实现使用隔离 PluginContext、Unix socket 与录制/模拟 Host 路径验证；随后补充隔离真实 rc.2 Host 的模型切换与重新 attach 测试，以及用户流程与复合故障回归，详见 [用户流程验证记录](./2026-11-04-user-journeys.md)。没有重启或替换用户正在运行的真实 Host，也没有修改 DeepSeek Harness 源码。
