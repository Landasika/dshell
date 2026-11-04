# 队列取消最终验证

日期：2026-11-04。包版本：0.5.2。所有下列检查均在完成 Esc 队列继续、真实 Host 消息 ID 关联修复后执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0；272 tests，272 pass，0 fail / cancelled / skipped；22,242.819 ms |
| TUI user journeys | 23 项通过，包含本轮新增的 4 项队列交互流程 |
| 隔离真实 rc.2 Host + 本地 SSE 模型 | exit 0；Esc 和 `/cancel` 各验证 1 个取消轮次、2 个完成轮次 |
| `./scripts/verify-pack.sh` | exit 0；构建、打包、临时安装、CLI 和插件导入通过 |
| `git diff --check` | exit 0 |
| 两个上游源码快照 `git status --porcelain` | 均为空 |

真实 Host 脚本的额外断言包括：取消前两条消息都仍 pending；取消后同一个 requestId 各进入一次 user/message；实际 Host message ID 与取消前相同；模型请求顺序准确为 active、next、last；取消的 SSE 连接已关闭；inbox 的 nextTurn 和 nextStep 最终均为空。

使用 runtime：`@deepseek-ai/dsh@0.2.1-rc.2`，Node `v24.21.0`。加载仓库编译的 dshell-host，profile、会话与假凭据写入新建的临时 `DSH_HOME`，模型服务器只监听本地随机端口。未修改或重启用户真实 Host，未调用外部模型。

复现：

```bash
pnpm build
node docs/reviews/2026-11-04-evidence/queue-real-host.mjs /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
pnpm typecheck
pnpm test
./scripts/verify-pack.sh
git diff --check
```

验证包：`landasika-dshell-0.5.2.tgz`，322,536 bytes，SHA-256 `be3400c76af33f6013ac3d2409192a063525b5a4e4dbce7720324dfa082fabfa`。打包脚本完成后按设计清理了临时安装和 tarball；该 hash 记录本次验证产物，不保证后续不同时间重打包字节一致。

只读上游快照：

- `687f282e8625c6b8d11ff58211a90524be2e4317`
- `8bd073392eef6f54e921a093b95076248eb08cbb`

原始真实 Host 输出见 [queue-real-host.json](./queue-real-host.json)，实现与验证范围见 [修复记录](../2026-11-04-queue-cancel.md)。
