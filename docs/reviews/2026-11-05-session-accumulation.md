# 会话积累：现状测量与清理路径

测量时间：2026-11-05 11:16–11:40 (+08:00)
测量对象：本机真实 `$DSH_HOME=/home/landasika/.dsh`，DSH `0.2.1-rc.2`，dshell `0.5.2`（9 个本地提交未推送）
性质：**只读测量**。本文没有删除、移动或修改任何会话文件。

> **数字会漂移**：下面的会话份数与体积是测量时刻的快照。写作过程中同一个 Host
> 还在跑（本次对话本身就在写会话），实测期间日志从 515 份涨到 517 份、
> `sessions/` 从 267 MB 涨到 268 MB。量级与结论不受影响，比对时请以当下
> `du` / `find` 的实测值为准。

## 1. 结论先说

1. **积累是真的，而且已经压到列表查询的预算线上。** 磁盘上有 **515 份会话日志**，其中 **249 个是主会话**（Host 会列出）、**266 个是 subagent 子会话**（按设计不列出）。加上投影缓存，会话相关占用 **约 430 MB**。
2. **`dshell` 的 CLI 没有任何清理入口。** 没有 `archive` / `pin` / `rename` / `fork` / 删除命令，也没有 `--archived` 开关；`dshell list` 永远只列主会话。会话管理只有 TUI 里的 `/archive`、`/pin`、`/fork`、`/archived`。
3. **归档只改标记，不释放空间。** `session/delete` 在 Host 侧被明确拒绝（`UNSUPPORTED_CAPABILITY`，返回"physical deletion is unavailable; archive the session instead"）。归档只往 `workspace.json` 的 `archivedSessionIds` 加一条 id。
4. **列表慢的真正原因已定位：同一份记录被列举了两遍。** `controller.list()` 内部又调一次 `sessionQuery.listSessions()`，与 dshell 自己的列举**串行叠加**（实测 `controller` 段 1.6–8.9 秒，占 49%）。决定性证据：只有 **2 个会话可见**的查询也要 **12.4 秒**。已修：两段改为并行 + 列表改为索引优先。详见 §4。
5. **投影缓存可以清空，但它不是慢的原因**。上游文档明确"会话日志始终是权威"、陈旧记录"读作不存在"。**会话日志不能随便删**——它们是唯一真相。
6. **竞品的共同解法是"索引与正文分离"**：Claude Code 用 436 KB 的 `history.jsonl` 对应 522 MB 正文（1:1200），Codex 用 `state_5.sqlite` 的 `threads` 表（1:630）。dshell 原来的投影缓存是 **172 MB 对 270 MB 正文（1:1.6）——索引做反了**。改后索引 60 KB（1:4500），列表读取 1 ms。详见 §7.2 / §7.3。

## 2. 磁盘到底占在哪

```
$DSH_HOME 总占用            6.4 GB
├── blackboard/             6.0 GB   ← 真凶，与会话无关（见 §6）
├── sessions/               267 MB   ← 515 份 session.v4.jsonl.zstd
│   ├── 主会话 249 份        183 MB
│   └── subagent 266 份      76.5 MB
├── storages/session_projcache/  172 MB   ← 523 份投影缓存
│   ├── 主会话 249 份        115 MB
│   └── subagent 274 份      55.8 MB
├── storages/workspace.json   12 KB   ← 归档/置顶/工作区注册表
└── logs/                   1.4 MB
```

**会话相关合计约 430 MB**（267 + 172）。其中 subagent 的日志+缓存就占 **132 MB**。

### 2.1 主会话的年龄分布

| 年龄段 | 会话数 | 日志占用 |
|---|---|---|
| ≤ 7 天 | 34 | 71.3 MB |
| 8–30 天 | 215 | 112.1 MB |
| > 30 天 | 0 | 0 MB |

最老的可用会话是 **2026-10-12**。也就是说：这套 home 只用了三周多，就已经 249 个主会话、183 MB 日志——**增长曲线很陡**，不是多年陈账。

### 2.2 体量集中度

- 60 份日志 ≥ 1 MB，合计 **182 MB**（占日志总量 70%）
- 最大的 10 份合计 **67 MB**
- 101 份日志 < 1 KB（几乎空的会话，合计不到 100 KB）
- 单份最大 5.8 MB（`session-4d063520-…`，dshell 工作区）

### 2.3 投影缓存比日志还散

`storages/session_projcache/sessions/` 下 **523 个 JSON**，比日志还多 8 个。其中 10 个在磁盘上**已经没有对应日志**，2 份日志还没有缓存——两边并不同步。最大一份缓存 **16.3 MB**（`session-dc4112ba-…`），比它对应的日志大得多。

### 2.4 subagent 子会话的分布

266 份 subagent 日志全是 `"origin":"subagent"`、`delegationDepth:1`。它们**不出现在任何列表里**，用户既看不见也删不掉。分布很集中：

| 工作区 | 全部日志 | 被列出 | 未列出(subagent) |
|---|---|---|---|
| `--home-landasika-qwbwp--` | 76 | 3 | **73** |
| `--home-landasika-tmp-wdc--` | 68 | 3 | **65** |
| `--home-landasika-banchmark--` | 49 | 10 | 39 |
| `--home-landasika-agent-master--` | 60 | 38 | 22 |
| `--home-landasika-phprce--` | 18 | 6 | 12 |
| `--home-landasika-hackathon--` | 32 | 20 | 12 |

`qwbwp` 和 `tmp-wdc` 两个工作区里，**主会话只剩 3 个，但各自堆了 65–73 个 subagent 会话**。这是典型的工作区：开过几次大任务，一堆子 agent 各留一份日志，之后再没人回来。

### 2.5 孤立的工作区目录

`workspace.json` 里只注册了 15 个工作区路径，但 `sessions/` 下有 **37 个目录**。以下 22 个目录**没有任何工作区引用**（会话记录仍在，但界面里已经没有入口）：

```
--data2-hm-vuln--                     --home-landasika-loc-allinone--
--data2-openharmony-nova13pro--       --home-landasika-phprce--
--home-landasika--                    --home-landasika-prompt--
--home-landasika-agent-master--       --home-landasika-prompt-seccontext--
--home-landasika-app-mayfly--         --home-landasika-stateforge--
--home-landasika-app-mayfly-mayfly-server--  --home-landasika-tmp-1--
--home-landasika-evo--                --home-landasika-tmp-wdc--
--home-landasika-ezssrf-ctf-challenge-deploy--  --home-landasika-typst--
--home-landasika-ezssrf-ezphp--       --home-landasika-xyzw--
--home-landasika-fuckstar--           --tmp--
--home-landasika-hackathon--          
--home-landasika-hackathon-gk--
```

注意 `/home/landasika/ezssrf` 在注册表里，但 `sessions/` 下是两个**子路径**目录（`ezssrf-ctf-challenge-deploy`、`ezssrf-ezphp`）。`qwbwp` 的情况又不同：它在注册表里只有 2 个 sessionId，磁盘上却有 76 份日志。

## 3. 已有的清理手段（Host 侧）

| 手段 | 命令 | 释放空间？ | 说明 |
|---|---|---|---|
| 归档 | TUI `/archive` 或 `session/archive` | ❌ | 只加进 `archivedSessionIds`，日志与缓存原封不动 |
| 取消归档 | TUI `/archived` 里 `x` | ❌ | 反向操作 |
| 置顶 | TUI `/pin` | ❌ | 只影响排序 |
| 分叉 | TUI `/fork` | ❌ | **反而增加**一份新会话 |
| 物理删除 | `session/delete` | — | **Host 明确拒绝**，返回 `UNSUPPORTED_CAPABILITY` |

`archivedSessionIds` 当前是**空数组**——也就是说这 249 个会话**一个都没归档**，全都还挂在正常列表里。

## 4. 15 秒超时的真正来源（已定位、已修）

### 现象

```
visible=2   listed=2297ms controller=6509ms title+needs=2401ms preview=1200ms total=12407ms
visible=249 listed=3150ms controller=8873ms title+needs=4242ms preview=1937ms total=18202ms
```

**决定性证据：`visible=2` 也要 12407 ms。** 只有两个会话可见却要 12 秒，
所以"会话太多"不是主因——会话体积是结果，不是原因。

### 归因

| 环节 | 耗时 | 占比 |
|---|---|---|
| `sessionQuery.listSessions()` | 1.2–3.2 s | 20% |
| **`controller.list()`** | **1.6–8.9 s** | **49%** |
| 标题快照 + 状态判定 | 2.4–4.2 s | 23% |
| preview | 1.2–1.9 s | 11% |

真凶是**同一份记录被列举了两遍**。`dsh-api-session-controller` 的 `list()` 第一件事
就是自己再调一次 `sessionQuery.listSessions(signal)`：

```js
async list(signal) {
  const records = await this.ctx.sessionQuery.listSessions(signal);  // ← 第二次全量列举
  for (const record of records) { ... this.summarizeCold(record) }   // 再逐条算投影
```

dshell 先自己列一遍（`listed`），再等 controller 列一遍（`controller`），两段
**串行相加**。而且 `setTimeout(abort, 4000)` 形同虚设——`signal.throwIfAborted()`
只在循环里检查，卡住它的是循环**之前**那次 `await listSessions()`。

### 已修

1. **两段并行发起**，总耗时从"两段之和"降到"两段中较慢的那段"；
2. **列表改为索引优先**（见 §7.3）：命中索引 1 ms 返回，慢路径降级为后台补全。

### 附带发现（之前判断错的）

- **subagent 前置过滤是伪优化**：过滤本来就在 `src/plugin/index.ts` 的 `visible`
  链里，提前只省微秒级，已回退；
- **preview 不是主因**：实测只占 11%（撞单条 1200 ms 超时）；
- **清 172 MB 投影缓存不治本**：`controller.list()` 每次仍要逐条 `summarizeCold`；
- **早先"解压很快"的测量是错的**：`zlib.zstdDecompressSync` 只解**第一帧**，
  而会话日志是增量追加的多帧格式。真实是 35.3 万事件，不是 515。

## 5. 安全的清理路径（未执行，供决策）

> 以下命令**全部未执行**。执行前请先 `systemctl --user stop dsh-host`，并确认没有 dshell TUI 在跑（`pgrep -a dshell`）。有 6 个 dshell 进程正在运行，写这些目录会互相打架。

### 5.1 第一步：清投影缓存（最安全，约 172 MB）

上游 `@deepseek-ai/dsh-session-projection-cache` 的 README 明确：

- "会话日志始终是权威"；缓存"不依赖会话持久化后端，不调用 `locate`，也不检查逐会话目录"；
- "畸形或陈旧的记录读作不存在；需要冷值的消费方负责提供日志以重新折叠"；
- 它**自己没有淘汰或保留接口**："记录按会话持续累积；清理已存储检查点属于带外维护"。

所以这块缓存就是设计上留给运维手动清的。删掉只会让下次列表变慢，不会丢数据。

```bash
# 停 Host 后
du -sh ~/.dsh/storages/session_projcache      # 先记下清理前体积
mv ~/.dsh/storages/session_projcache/sessions \
   ~/.dsh/storages/session_projcache/sessions.bak-$(date +%F)   # 先改名，别直接删
# 重启 Host 观察几天没问题再真的删掉 .bak
```

缓存由 base bundle 的 `session-projection-cache` 提供（`writeEveryEvents: 200`、`writeIntervalMs: 5000`），**不是** dshell 装的，所以清掉它不影响任何 dshell 功能。重建是按需的：会话创建、`turn/end`、会话释放这三个必写点会重新写入；**再也不会被访问的冷会话就一直没缓存**，只是列表读得慢一点，不影响正确性。

### 5.2 第二步：清 subagent 子会话（约 132 MB，但需要确认）

这 266 份是 `origin:subagent`，**不出现在任何会话列表里**。但要小心：它们并非无用文件。TUI 的 `Ctrl-G`（子 agent 花名册）在 `src/tui/app.ts:1932` 里是这样做的：

```ts
const handle = await backend.openSession(agent.agentId)   // openAgentView
```

也就是说，**查看一个子 agent 的完整转录，读的正是它自己那份日志**。删掉这些文件，父会话照常打开、历史照常回放，但老的子 agent 转录就再也打不开了（`Ctrl-G` 里点进去会打不开）。

所以这是"能清，但会丢掉一部分可回看的历史"的级别，不是免费清理。如果你从不回看子 agent 转录，删掉无妨；如果要保留，就跳过这一步。

建议先做**只读核对**，而不是直接删：

```bash
# 1) 找出所有 subagent 日志（路径相对 ~/.dsh，无 ./ 前缀）
cd ~/.dsh
find sessions -name 'session.v4.jsonl.zstd' | while IFS= read -r f; do
  h=$(zstd -dc "$f" 2>/dev/null | head -1)
  case "$h" in *'"origin":"subagent"'*) printf '%s\n' "$f" ;; esac
done > /tmp/subagents.txt

wc -l < /tmp/subagents.txt           # 应接近 266
du -cb $(cat /tmp/subagents.txt) 2>/dev/null | tail -1   # 总字节

# 2) 按工作区统计，确认没有你还在用的
#    路径形如 sessions/<workspace>/<id>/session.v4.jsonl.zstd，故工作区是第 2 段
cut -d/ -f2 /tmp/subagents.txt | sort | uniq -c | sort -rn
```

确认后再删。`rm -rf` 之前**先逐条回显**，并且只删目录、不碰父会话：

```bash
# 干跑：把将要删的目录打出来，确认没有父会话混进来
while IFS= read -r f; do dirname "$f"; done < /tmp/subagents.txt | tee /tmp/subagent-dirs.txt
# 每个目录里都应有 session.v4.jsonl.zstd；抽查几条 header 确认 origin=subagent
head -3 /tmp/subagent-dirs.txt

# 真删（只删这些子会话目录本身）
while IFS= read -r d; do
  [ -f "$d/session.v4.jsonl.zstd" ] || { echo "skip $d"; continue; }
  rm -rf -- "$d"
done < /tmp/subagent-dirs.txt
```

注意两点：
- 用 `cut -d/ -f2` 而不是 `awk -F/ '{print $2}'`——如果路径带 `./` 前缀，`$2` 会变成 `sessions` 本身；
- `rm -rf -- "$d"` 要带 `--` 和引号：目录名里可能含 `-` 开头的片段（如 `--home-…--`），不加 `--` 会被当成选项。

### 5.3 第三步：归档 + 按工作区清理主会话（约 112 MB）

主会话是真实用户历史，只能一个个判断。三个维度：

- **按工作区**：`qwbwp`（3 主会话）、`tmp-wdc`（3）、`banchmark`（10）、`phprce`（6）这类已经收尾的项目，整个目录可以打包后删除；
- **按年龄**：8–30 天的 215 个会话占 112 MB，是清理主力；
- **按体量**：60 份 ≥1 MB 的日志就占 182 MB，先看这 60 份的标题再决定。

```bash
# 备份到一处再动手。注意 sessions/ 是 268 MB 的高熵压缩日志，
# gzip 基本压不动（它们本身已是 zstd），加 -z 只会白烧 CPU。
tar -cf ~/dshell-sessions-$(date +%F).tar -C ~/.dsh sessions storages/workspace.json
# 确认 tar 可读后再删目录；workspace.json 里存着归档/置顶/工作区映射，务必一起备份
tar -tf ~/dshell-sessions-$(date +%F).tar | head
```

### 5.4 第四步：修掉孤立工作区（不占空间，清列表）

22 个目录没有工作区引用（§2.5）。它们的会话不会再出现在任何列表里，属于"不可达但占空间"。处理方式和 5.3 一样：打包后删。

## 6. 另一件事：6.0 GB 的 blackboard 与会话无关

`$DSH_HOME` 一共 6.4 GB，**其中 6.0 GB 在 `blackboard/workspace/wifi/`**，是黑板机制的产物，不是 dsh 会话：

```
~/.dsh/blackboard/workspace/wifi/board/artifacts/evidence/W1-03-v7/
  w103v2_3.log   1.16 GB
  w103v2_2.log   1.11 GB
  w103v2_1.log   1.06 GB
  w103_plain_3.log  628 MB
  w103_plain_4.log  596 MB
```

这 5 个文件就占 4.5 GB。如果目标是"清点空间"，先把这里处理掉比清会话划算 10 倍——但那是另一条工作流（`blackboard` skill 的证据目录），不在本次会话清理范围内。

## 7. 该补的 CLI 能力（建议新增）

当前 CLI 的会话管理是空白。按投入产出排序：

| 命令 | 价值 | 难度 |
|---|---|---|
| `dshell list --archived` | 让 CLI 能看见归档区，现在完全不可达 | 低（后端已有 `includeArchived`） |
| `dshell archive <id>` / `--restore` | 不必开 TUI 就能收尾项目 | 低（`sessionAction` 已支持） |
| `dshell prune --dry-run` | 按年龄/工作区/大小出报表，先给数字再动手 | 中（需要枚举 + 统计） |
| `dshell prune --before 2026-10-20 --workspace qwbwp --apply` | 真正的批量清理 | 中 |
| 分页 + subagent 前置过滤 | 修掉 §4 的超时 | 中 |

其中第一条和第二条只是把已有的后端能力接到 CLI 上，几行命令分发的事。

## 7.1 顺带发现的两个 CLI 缺陷（与会话无关，但都在本轮验证）

### (a) `dshell install` 认不出"有 dshell-host 但缺 wsPort"

`appendWsConfig()` 只用 `hasEntry(text,'dshell-host')` 判断"配过了没"，**不看 wsPort 是否存在**：

```
有 dshell-host 但没 wsPort  -> undefined   （判定"已配置"，什么都不做）
有 dshell-host 且 wsPort=8792 -> undefined   （正确）
```

后果：手工装过、或旧版 `install` 留下的 profile 里若 `dshell-host` 条目缺少 `wsPort`，`dshell install` 会报"已配置 wsPort"然后什么都不改，而 `dshell remote` 随后会失败并提示"配置里有 wsPort: 8792"——用户明明"装过了"，却怎么都连不上。修法是把判断改成"条目存在 **且** 该条目下有 wsPort"，缺则补上。

### (b) 配对二维码里的指纹永远是空的

Host 的 `/api/health` 只回 `{ok, plugin, protocol}`，**没有 fingerprint**；指纹只在 `/api/pair/claim` 的响应里回带。而 `dshell remote` 的 `probeHealth()` 是去 `/api/health` 找 `fingerprint` 的：

```
$ curl -s http://127.0.0.1:8792/api/health
{"ok":true,"plugin":"dshell-host","protocol":2}

prepareRemote() -> fingerprint="" 
payload -> dshell-pair://192.168.8.200,10.13.0.1,10.254.0.14|8792|8KBP56ZK||landasika
                                                        fp 位为空 ↑
```

App 端 `PairPayload` 把 fp 当可选字段（`getOrNull(3)?.takeIf { it.isNotBlank() }`），所以不会崩；配对成功后 `applyClaim` 会用 claim 响应里的 `out.fingerprint` 兜底。**净效果**：扫码配对这条路拿不到指纹，只有走 claim 响应才有。如果指纹的用途是"让 App 提前知道连的是哪台机器"，那它现在在扫码阶段是失效的。

修法二选一：让 `/api/health` 也回 `fingerprint`（一行），或让 `remote.ts` 改用 `/api/pair/claim` 的响应——但后者要消耗一个配对码，不适合探测。

## 7.2 竞品做法调研（Claude Code / Codex）

> 下面全部基于本机真实安装与数据目录的只读观察，外加一份第三方事故记录。

### Claude Code（2.1.318）

**1. 列表不读正文。** `~/.claude/history.jsonl` 只有 **436 KB**，存每条用户 prompt 的
`display` 全文 + `project` + `sessionId` + `timestamp`（实测 1990 条 / 116 会话），
而 `~/.claude/projects/` 的 transcript 是 **522 MB**。列列表读索引，不碰正文。

**2. 有明确的保留期。** 二进制里写着：

```
cleanupPeriodDays must be at least 1. To keep transcripts for a long time,
set a large number (e.g. 3650 for ~10 years). ... (0 is rejected because it
previously silently disabled all transcript writes, which users setting it to
mean "never clean up" did not expect.)
```

配套 `.last-cleanup` 时间戳（本机为 `2026-11-05T01:16:36Z`）。

**3. 子会话嵌在父会话目录里。**

```
projects/<workspace>/<session-id>.jsonl
projects/<workspace>/<session-id>/subagents/agent-xxx.jsonl
```

实测本机 13 个 `subagents/` 目录，**孤立数 0**——删父会话必然连带子会话。

### Codex（0.166.0）

**1. `state_5.sqlite` 的 `threads` 表就是索引**，列即列表所需一切：

```sql
CREATE TABLE threads (
  id, rollout_path, created_at, updated_at, source, model_provider, cwd,
  title, sandbox_policy, approval_mode, tokens_used, archived, archived_at,
  first_user_message, preview, is_pinned, thread_section_id, project_id, ...
)
```

**2. 父子关系是独立边表**，subagent 是一等公民：

```sql
CREATE TABLE thread_spawn_edges (
  parent_thread_id TEXT NOT NULL,
  child_thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
)
```

**3. rollout 按 `YYYY/MM/DD/` 分层**；`thread_history_projection_state` 记录
`next_rollout_byte_offset`，是**增量投影**而非全量重算。

### 第三方事故记录：同款问题怎么修的

[Codex Session Index Memory Spikes](https://github.com/kzahel/yepanywhere/blob/a0687394d861047ea0a76a391e09102423586950/docs/tactical/038-codex-session-index-memory.md)
记录了冷索引 4 GB OOM 的事故，结论与 dshell 的处境几乎逐条对应：

- 元数据扫描用 `readFirstLine()`（**只读首行**），但 `getSessionSummary()` 会
  `readFile → trim → split` **整份文件**；
- 一条冷索引请求能解析并保留多 GB transcript，**即使可见列表只有一条会话**；
- 修法：**流式逐行解析**、只累加 summary 状态、summary 路径不写 entryCache；
- 再加**解析并发队列**（默认并发 1）与进度上报。

实测：warm 请求 0.60–0.75 秒，冷索引 32.8 秒 / 峰值 1.5 GB。

### 三方对比

| | 索引体积 | 正文体积 | 比例 | 列表时读什么 |
|---|---|---|---|---|
| Claude Code | 436 KB | 522 MB | 1 : 1200 | 索引 |
| Codex | `state_5.sqlite` 几十 KB 级 | 32 MB+ | 1 : 630 | 一条 SQL |
| dshell（改前） | **172 MB** 投影缓存 | 270 MB | 1 : 1.6 | 515 份 header + 24 份全量解压 |
| **dshell（改后）** | **60 KB** | 270 MB | **1 : 4500** | 索引 |

## 7.3 已实施的改动（本次改动，未重启 Host 验证）

### (a) 新增会话轻索引 `src/plugin/session-index.ts`

JSONL 边车，**只存列表需要的字段**（`title` / `preview` / `firstUserMessage` /
`createdAt` / `updatedAt` / `cwd` / `origin` / `parentSessionId` / `delegationDepth`）。

设计要点：

- **追加式**：一行一条，新行覆盖旧行，写入是 O(1) `appendFile`；
- **容错**：坏行跳过，不让一条坏记录毁掉整份索引；
- **可压实**：按**磁盘行数**（不是去重后行数）超过阈值时重写；
- **可丢弃**：删掉只是下次列表慢一次，日志仍是唯一权威。

真实数据实测（515 份会话，写到临时目录）：

```
headers:        515
scan sessions/: 53 ms
index write:    2 ms
index read:     1 ms      <-- 列表路径的成本
index size:     60.1 KB
per-row bytes:  119
```

### (b) 列表改为索引优先

`listSessions()` 命中索引就直接返回（1 ms），同时后台跑一次慢路径补全。
索引为空（首次运行）时才走原来的慢路径。`running` / `status` 这类"此刻状态"
索引给不了，保持 `undefined`（= 不知道），**不写成 `idle`**（= 确认没在跑）。

### (c) 子会话父子边

索引记录 `parentSessionId`，新增 `session/children` 请求按父会话查子 agent。
对应 Claude 的目录嵌套 / Codex 的 `thread_spawn_edges`，把 dshell 原来 266 份
平铺的"孤儿"变成可查询的归属关系。

### (d) 保留期 `cleanupPeriodDays`

抄 Claude 的语义：**最小 1 天，0 被抬到 1**（不把 0 当"永不清理"）。
只用于索引侧的过期标记与 `session/index-stats` 报表，**不自动删日志**。

### (e) 修掉双重列举

`controller.list()` 内部第一件事就是自己再调一次
`sessionQuery.listSessions()`，原来与 dshell 自己的列举**串行**叠加：

```
实测：records 1.2–3.2s + controller 1.6–8.9s = 3–12s（吃掉 15s 预算）
```

改为并行发起后，总耗时从"两段之和"降到"两段中较慢的那段"。

### 验证

- `npx tsc --noEmit` 通过；
- **334 项测试全过、0 失败**（原 314 + 新增 19 索引测试 + 1）；
- 端到端脚本用真实 `~/.dsh` 目录结构验证索引读写，**写到临时目录**；
- **未重启 Host**，`dsh-host.service` 仍是从 12:36:50 起运行的同一进程，
  改动只在源码与 `dist/`，等用户决定何时重启生效。

## 7.4 Server API 变更清单

这一轮对 dshell-host 的协议只做**增量**改动：`PROTOCOL_VERSION` 仍是 **2**，
老客户端不受影响。但新增了两个请求、两个响应、两个能力位。

### 7.4.1 新增请求

| 请求 | 载荷 | 响应 | 能力位 |
|---|---|---|---|
| `session/children` | `{ sessionId: string }` | `session-children` | `session-children` |
| `session/index-stats` | `{}` | `session-index-stats` | `session-index` |

**`session/children`** 按父会话列出子 agent：

```ts
interface SessionChildrenMessage {
  type: 'session-children'
  sessionId: string
  children: Array<{
    sessionId: string
    title?: string
    cwd?: string
    createdAt?: number
    updatedAt?: number
    delegationDepth?: number
  }>
}
```

对应 Claude Code 的 `projects/<ws>/<session>/subagents/` 目录结构与 Codex 的
`thread_spawn_edges(parent_thread_id, child_thread_id)` 边表。**这是原来完全
缺失的能力**——266 份子会话在磁盘上是平铺的，客户端既列不出、也归不到任何
父会话，属于"不可达但仍占空间"。

**`session/index-stats`** 是轻索引与保留期的只读报表：

```ts
interface SessionIndexStatsMessage {
  type: 'session-index-stats'
  indexed: number           // 索引总行数
  mainSessions: number      // 主会话
  subagents: number         // 子会话
  orphanSubagents: number   // 父会话缺失或已不在索引里的子会话
  cleanupPeriodDays?: number
  expired: number           // 按保留期判定的过期数
  expiredSample?: string[]
}
```

**只统计、不删除。** 与 dsh 上游"清理已存储检查点属于带外维护"的立场一致：
dshell 负责把"哪些过期了"算清楚，删不删由用户决定。

### 7.4.2 新增能力位

```ts
'session-children',
'session-index',
```

能力表从 **28 项变成 30 项**。这是客户端判断"这个 Host 支不支持某功能"的
唯一依据，后端在发请求前先查：

```ts
if (!connection.welcome.capabilities.includes('session-children')) {
  throw new BackendError('UNSUPPORTED_CAPABILITY',
    'this Host cannot list a session\'s subagents',
    'restart the Host to load the current dshell-host plugin')
}
```

> **一个我自己造成的疏漏，记录在此**：第一次实现时只加了请求、没加能力位。
> 那会让客户端只能靠"收到 unknown message type"才发现不支持——那是错误路径，
> 不是协商。是复核时才补上的（见 §7.4.5 的实测证据）。

### 7.4.3 没有变化的部分

- **`session/list` 的线格式完全没变**：仍是 `sessions: SessionSummary[]`；
- `welcome` / `session/action` / `session/rename|archive|restore|pin|fork` 都未改动；
- **`PROTOCOL_VERSION` 仍是 2**（纯增量，老客户端不受影响）。

### 7.4.4 行为变化（非格式）

- **`session/list` 命中索引时快得多**（实测 1 ms 对十几秒），代价是**不再保证
  立刻反映最新状态**：索引是派生数据，后台补全有延迟；
- 走索引时 `running` / `status` 字段为 `undefined`（= **不知道**），而不是
  `'idle'`（= **确认没在跑**）。客户端应沿用上次已知状态，而不是清零——
  这条语义在 `817c854` 那次提交里已经立过规矩，这里继续遵守。

### 7.4.5 实测证据：老 Host 的拒绝路径

直接探测仍在运行的 Host（PID 728904，12:36:50 启动，跑的是旧代码）：

```
protocol: 2   pluginVersion: 0.5.2
has session-children: false
has session-index   : false
total capabilities  : 28
```

即**新接口要重启 Host 才会出现**（会变成 30 项）。重启前客户端会拿到干净的
`UNSUPPORTED_CAPABILITY`，不会挂起、也不会误判成"没有子会话"。

### 7.4.6 尚未完成的部分（如实记录）

- **`Backend` 接口已声明 `listSessionChildren?()` / `sessionIndexStats?()`**，
  `SocketBackend` 已实现，但 **CLI 还没有对应子命令**（`dshell children`、
  `dshell index-stats` 都不存在）。目前只能用脚本或客户端代码调用；
- `FakeBackend` / `ReplayBackend` 未实现这两个可选方法（接口上是 `?`，
  调用方需判空）；
- 索引路径默认 `$DSH_HOME/dshell-ws/session-index.jsonl`，可用
  `sessionIndexFile` 覆盖；保留期用 `cleanupPeriodDays`（最小 1 天）。

## 8. 复现脚本

```bash
export PATH=/home/landasika/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/landasika/dshell

# 体量
du -sh ~/.dsh/sessions ~/.dsh/storages/session_projcache

# 日志数 vs 列出数
node dist/bin/dshell.js list | wc -l
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' | wc -l

# 超时复现
node -e "
const {SocketBackend}=await import('./dist/backend/index.js');
const b=new SocketBackend(process.env.HOME+'/.dsh/run/dshell.sock');
await b.connect();
const t=Date.now();
try { console.log('all=',(await b.listSessions(undefined,true)).length, Date.now()-t+'ms') }
catch(e){ console.log('FAIL', e.code, Date.now()-t+'ms') }
await b.disconnect(); process.exit(0)
"

# 删除被拒绝
node -e "
const {HostConnection}=await import('./dist/client/socket-client.js');
const c=await HostConnection.connect(process.env.HOME+'/.dsh/run/dshell.sock');
try { await c.request({type:'session/delete',sessionId:'x'},x=>x.type==='session-updated',8000) }
catch(e){ console.log(e.code,'|',e.message) }
c.close(); process.exit(0)
"
```

## 9. 测试基线

Node 24 下全量 **335 项通过、0 失败**（`node --test tests/*.test.mjs`）。注意：默认 `node` 是 v18，
直接跑会在 WebSocket 测试上假失败 8 项（`WebSocket is not defined`）——那是环境问题，不是回归。

基线变化：改动前 314 项 → 改动后 335 项（新增 19 项索引测试 + 1 项能力表断言 + 1 项协议测试）。
