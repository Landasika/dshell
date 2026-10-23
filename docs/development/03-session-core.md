# P3 — 多 Workspace / 多 Session 与交互语义

**目标**：不依赖 TUI 组件也能作为功能完整的多会话 Coding Agent CLI 核心工作。

## 工作包

- [ ] Workspace 发现、选择、切换：不要假设本地 CWD 等于 Host 工作目录（远程 Host 情况尤甚）。
- [ ] Session 创建、列出、检索、恢复、归档与切换（以 DSH 能力为准）。
- [ ] 每个 Client 可同时订阅多个 Session；只有一个 `activeSessionId` 用于当前终端视图。
- [ ] 同一 Host 中多个独立 Session 可并发；UI 切换不取消非活动 Session。
- [ ] Prompt、Queue、Cancel、历史分页、运行状态与通知。
- [ ] Approval / Ask User 的等待、响应、拒绝、过期，遵循 Host 权限和请求身份。
- [ ] 多 Client 同时观察相同 Session：避免重复动作和本地假状态覆盖 Host 真值。
- [ ] 设计 Client 退出语义：仅断开连接，除非用户明确执行 Cancel/Stop。
- [ ] 把 Session/Workspace 本地视图偏好与业务事实状态彻底分开。

## 验收标准（场景驱动）

1. Session A 与 B 同时运行，切换到 B 后 A 继续工作。
2. 关闭 dshell A 后，Host 仍运行 A；在新的 dshell 中打开 A 看到完整历史与当前状态。
3. 同一 Session 同时在 Web 和 dshell 查看，状态一致。
4. 两个客户端对同一审批只允许按 Host 规则完成一次有效处理。
5. 错误的 Workspace/Session/权限请求有明确错误，不把错误当成功。

## 建议先实现的文本命令（目标接口）

```text
dshell sessions
dshell sessions --workspace <id>
dshell attach <session-id>
dshell -p "检查当前项目"
```
