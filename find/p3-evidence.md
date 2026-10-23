# P3 证据索引（Session Core）

日期：2026-10-23
环境：Ubuntu 24.04.3 LTS，Node v24.21.0，pnpm 11.27.1，DSH 0.2.1-rc.2
Host：`dsh --profile web --no-open --port 3111`，`DSH_HOME=<repo>/.p0/dsh-home`
插件：本仓库 `dist/plugin/index.js`，通过 `cordis.patch.yml` 插入 `dshell-host`
CLI：`node dist/bin/dshell.js`，socket `<DSH_HOME>/run/dshell.sock`

## 1. 自动化

```text
$ pnpm test
✔ FakeBackend exposes workspaces, sessions, streaming, and approval
✔ SocketBackend maps list, attach, prompt, and stream over a Unix socket
✔ SocketBackend supports history paging, steer, cancel, and approvals
✔ SocketBackend reports unsupported capabilities clearly
✔ handshake, list, and prompt over a Unix socket
✔ handshake error is surfaced as DshellError
✔ missing socket maps to HOST_NOT_RUNNING
✔ protocol v2 advertises the P3 capabilities
✔ socket path follows DSH_HOME
✔ explicit socket override wins over DSHELL_SOCKET
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

`pnpm typecheck` 与 `pnpm lint` 均通过。

## 2. 真实 Host 命令

### 2.1 doctor / workspaces / new

```text
$ dshell doctor
platform  linux x64
node      v24.21.0
socket    /home/landasika/dshell/.p0/dsh-home/run/dshell.sock
status    ok
protocol  2
dsh       0.2.1-rc.2
plugin    0.1.0

$ dshell workspaces
ab147eae-4f5a-4d97-9734-a99747e53add  14 sessions  work  /home/landasika/dshell/.p0/work

$ dshell new /home/landasika/dshell/.p0/work
[created] session-de2f71b1-968b-4da6-b221-4289268484cb  /home/landasika/dshell/.p0/work

$ dshell list <workspaceId>
session-519bf0cb-f8e3-4c25-9b84-a9a75f32df3c  live  /home/landasika/dshell/.p0/work
session-de2f71b1-968b-4da6-b221-4289268484cb  live  /home/landasika/dshell/.p0/work
...
```

### 2.2 prompt / attach

```text
$ dshell prompt <sessionId> "Reply with exactly P3_OK."
[accepted] ...
[user] Reply with exactly P3_OK.
[assistant] P3_OK
[turn] completed

$ dshell attach <sessionId>
[attached] session-... cursor=21 history=22
...
[attached] listening; press Ctrl-C to exit
```

### 2.3 两个 Session 并发

```text
$ dshell prompt <A> "Reply with exactly A_OK." > /tmp/p3-a.out &
$ dshell prompt <B> "Reply with exactly B_OK." > /tmp/p3-b.out &
$ tail /tmp/p3-a.out
[assistant] A_OK
[turn] completed
$ tail /tmp/p3-b.out
[assistant] B_OK
[turn] completed
$ dshell list
session-4eb494ff-...  live  /home/landasika/dshell/.p0/work
session-a9e2c7ad-...  live  /home/landasika/dshell/.p0/work
```

### 2.4 两个 CLI 同时 watch 同一 Session

```text
$ dshell attach <A> > /tmp/p3-w1.out &
$ dshell attach <A> > /tmp/p3-w2.out &
$ dshell prompt <A> "Reply with exactly MULTI_WATCH_OK."
$ grep -c MULTI_WATCH_OK /tmp/p3-w1.out
2
$ grep -c MULTI_WATCH_OK /tmp/p3-w2.out
2
```

### 2.5 cancel

```text
$ dshell prompt <sessionId> "Write a very long essay..."
...
$ dshell cancel <sessionId>
[cancelled] <sessionId> turn aborted
```

（原 prompt 输出以 `[turn] aborted` 结束。）

### 2.6 steer

```text
# 先启动一个长 turn
$ dshell prompt <sessionId> "Write a 3000-word ... Do not stop early." &
# turn 运行中
$ dshell steer <sessionId> "Stop writing now and reply with exactly STEERED."
[steered] ec14e968-d8e5-4890-a72e-f233a8982ee6
...
[user] Stop writing now and reply with exactly STEERED.
[assistant] STEERED
[turn] completed
```

`steer` 在非 running turn 上会返回 `BAD_REQUEST`，提示改用 `prompt`。

### 2.7 审批 allow

```text
[tool/call] bash {"command":"echo P3_APPROVED",...}
[event] approval/asked
[approval] id=approval-4e8093fb-159b-4984-a849-8df5081c2233 tool=bash
[approval] allowed-once sent
[event] approval/decided
[event] job/registered
[event] job/settled
[event] tool/result
[event] turn/end
```

### 2.8 审批 reject（fail closed）

```text
[tool/call] bash {"command":"echo P3_APPROVED",...}
[event] approval/asked
[approval] id=approval-95cf62ae-da56-44e9-8a72-a85ab571976b tool=bash
[approval] rejected sent
[event] approval/decided
[event] tool/result
[event] turn/end
```

非 TTY 下 CLI 不会等待输入，直接 reject；不会被自动 allow。

## 3. 代码位置

| 内容 | 文件 |
| --- | --- |
| 协议 v2 | `src/protocol/messages.ts` |
| Host 插件 / 审批桥 | `src/plugin/index.ts` |
| Socket 后端 | `src/backend/socket.ts` |
| 后端接口 | `src/backend/types.ts` |
| CLI 命令 | `src/cli/main.ts` |
| 输出格式 | `src/cli/output.ts` |
| 测试 | `tests/backend.test.mjs`、`tests/protocol.test.mjs`、`tests/client.test.mjs` |

## 4. 关键调试记录

1. 审批 listener 最初没有 `{global:true, prepend:true}`，导致 Web answerer
   先挂起、CLI 永远收不到。修复后 allow/reject 都通过真实 Host 验证。
2. 最初用 durable `approval/asked` 的 id 回答，Host 报
   `pending=0 found=false`。现在只用 Host `approval-request` 生成的 id。
3. `send(...,{mode:'steer'})` 的 `accepted` 最初没回传 mode，测试断言失败；
   已在 `SendReceipt` 增加 `mode?`。
4. `list <workspaceId>` 最初用 cwd 拼 `workspace:<path>` 过滤，和 Host 的
   workspace id 不一致；现在保留 Host 返回的 `workspaceId` 再过滤。
5. CLI abrupt exit 曾让 Host 因 `ECONNRESET` 崩掉；`jsonLine` 已对
   `destroyed`/不可写 socket 做保护，readline `error` 触发 cleanup。连续
   3 次强制退出后 Host 仍存活。

## 5. 未覆盖

- 审批超时的真实 120s 等待（单元测试只覆盖协议路径；超时逻辑在插件内，
  真实等待成本高，P4 的 TUI 测试会补可控 timer）。
- Web UI 手动选择同一 Session 的双前端截图；P3 只验证了 CLI 侧多 watcher
  和 Host 的 fanout。
- macOS/Windows（V1 明确 Linux only）。
