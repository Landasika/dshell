**dshell 从界面到功能实现的审查，2026-11-04。** 当前最需要处理的是执行归属、工作目录、配置写入和交互状态完整性；扩展功能应排在这些问题之后。现有 socket/backend 分层值得保留，但还没有把 DeepSeek Harness 的数据契约和业务规则限制在适配层内。

本次只新增审查报告与复现附件，没有修改产品实现。被审查提交为 `9205877b37cee494a5b355f9ee08d84bbd6995d8`，包版本 `0.5.0`。生产代码约 1.6 万行，覆盖 CLI、print、socket 客户端/协议、Host 插件、配置与 skills、backend、TUI 渲染/编辑/状态/指标、打包及 CI。`app.ts` 4579 行，`plugin/index.ts` 2524 行，两处承担了大量状态和业务规则。

**判断依据是执行路径、数据结构和运行复现。** 注释和文档仅用于发现宣称的行为，再对照实现核实。例如注释宣称保留其他配置行，但模型同步会删除同级字段；接口宣称传输以下隔离 DSH 类型，但 SessionView 仍传递原始 SessionEvent。

对照的上游来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，实际下载并固定了两个版本：

| 用途 | 版本与提交 | 本地源码 |
| --- | --- | --- |
| 已声明支持的主要参考 | `dsh-v0.2.1-rc.2`，`687f282e8625c6b8d11ff58211a90524be2e4317` | `/tmp/dshell-audit-upstream-rc2` |
| 升级风险对照 | 检查时 HEAD，CLI `0.2.2-alpha.3`，`8bd073392eef6f54e921a093b95076248eb08cbb`，提交时间 2026-11-03 | `/tmp/dshell-audit-upstream-20261104` |

下文涉及计划正文、提问回答与模型恢复的判断，均有 rc.2 的实现依据，不把 alpha 的新功能误算成旧版本已承诺的兼容性。运行环境为 Linux、Node `24.21.0`、pnpm `11.27.1`。

**现有检查全部通过，但没有证明这些边界正确。** `pnpm test` 为 216/216；`pnpm typecheck` 通过；`scripts/verify-pack.sh` 通过，tarball 安装后的 CLI 与插件导出可用。现有性能脚本在 1k/10k/50k 历史、150 个流式帧下的单帧中位数约为 1.14/1.19/1.66ms。这只是本机脚本结果；脚本的 append 阶段包含固定 300ms 等待，不能把它直接当成真实追加延迟，也不能用一次 heap delta 代表内存峰值。

复现附件见 [运行说明](./2026-11-04-evidence/README.md)、[功能复现输出](./2026-11-04-evidence/reproduce.log)、[UI 输出](./2026-11-04-evidence/ui.log)、[补充边界输出](./2026-11-04-evidence/boundary.log)。插件探针使用真实编译模块和 Unix socket，DSH 服务使用测试替身；UI 探针使用真实 runTui 与虚拟终端，另有真实 PTY 验证启动参数。未启动用户的真实 Host、未调用付费模型、未移动用户会话目录；因此不声称完成了真实 DSH Host 的全部端到端兼容性验证。

以下 P1 表示会影响执行结果、项目作用域、配置/凭据或必要决策的高优先级问题；P2 表示特定条件下的可用性、资源管理和交互正确性问题。未确认跨用户或远程利用问题。

**F01 · P1 · print 可能把上一轮回答作为本次成功结果返回。** 位置：[print.ts](/home/landasika/dshell/src/cli/print.ts:207)。`-p` 可以复用正在运行的会话，`handle.send` 默认排队；订阅端却收集初始 cursor 后的所有 assistant 消息，并在任意 `turn/end` 时结束，没有把 prompt receipt 的 requestId、持久化用户消息和目标 turn 关联起来。复现 `print-wrong-turn` 中，本次 requestId 为 `new-prompt`，退出码为 0，text 却是 `ANSWER_TO_PREVIOUS_PROMPT`；本次 prompt 尚未开始执行。相同归属缺口还意味着 print 可能拒绝别的客户端当前轮次的审批，超时时取消当前运行的其他任务。建议先建立 prompt → admitted user message → turn 的归属链，再等待对应终态；短期可以对 busy session 明确报错或使用新会话，不能仅靠 cursor。

**F02 · P1 · print 新建会话时默认工作目录会落到 Host 所在项目。** 位置：[print.ts](/home/landasika/dshell/src/cli/print.ts:118)、[Host 创建会话](/home/landasika/dshell/src/plugin/index.ts:1940)。`--new` 和找不到可复用会话的分支，只在用户显式给 `--cwd` 时发送 cwd；Host 缺省使用自己的 `process.cwd()`。复现 `print-create-cwd`：CLI 在 `/tmp` 执行，创建请求没有 cwd，wire Host 按 `/host-project` 处理，命令仍成功。项目筛选阶段使用了客户端目录，但创建阶段丢掉它，这会把工具的文件操作作用域带到其他项目。建议无 workspaceId 时由客户端解析并显式传递当前目录；相对 `--cwd` 也应在客户端规范化。

**F03 · P1 · RPC 超时后，迟到响应会被下一次同类请求接收。** 位置：[socket-client.ts](/home/landasika/dshell/src/client/socket-client.ts:256)。当前 request 虽然串行执行，但响应只按 type/predicate 匹配；超时后连接与旧响应仍保留，没有独立 RPC correlation ID。`late-rpc-reply` 复现中，第一个 ping 超时，第二个 ping 收到了第一个请求的 `pong(time=1)`。这会使刷新、配置操作和错误归属不可靠，串行队列本身无法解决。建议每个请求、响应、错误都携带 RPC ID，广播不参与请求匹配；在协议升级前，超时应使连接失效并重建。这里的 RPC ID 与 prompt/turn ID 是两种不同的身份。

**F04 · P1 · Provider 模型同步会被自身校验拒绝。** 位置：[syncApply](/home/landasika/dshell/src/plugin/index.ts:1472)、[providerSignature](/home/landasika/dshell/src/plugin/index.ts:260)。同步生成了 after，却把变更前的 `providerRows()` 作为 expected；签名包含模型数量。只增加或只删除模型、导致数量改变时，合法同步被拒绝。`provider-sync-add` 返回 “refusing to write…expected providers”，文件未变。一增一删保持数量时可能通过，因此不能说全部同步都失败。建议按目标模型集合和字段计算预期结构，校验完整目标内容，不能继续比较旧计数。

**F05 · P1 · 配置编辑定位可能选错插件，模型同步还能删除合法同级字段。** 位置：[findProviderBlock](/home/landasika/dshell/src/plugin/profile.ts:85)、[syncProviderModels](/home/landasika/dshell/src/plugin/profile.ts:322)、[providerFileCandidates](/home/landasika/dshell/src/plugin/index.ts:1130)。定位器取第一个固定四空格的 `providers:`，不检查它属于哪个插件；读写依赖固定缩进和行模式，也没有使用 YAML 结构。`provider-wrong-block` 中，无关插件排在前面时，读取与编辑都落到其 providers 上。模型同步则从 models 一直重建到 provider 的末尾，把最后一个 model 后面的同级字段当成其续行：删除该 model 会一起删除这些字段。纯函数探针确认 baseURL、apiKeyEnv 均可丢失；这些字段在外层签名里，部分场景会被拦住。但 `provider-sync-persists-sibling-loss` 已通过真实插件写入路径确认：一增一删、baseURL 在前、`api: anthropic-messages` 在 models 后时，api 被删除，外层校验仍允许落盘。

此外，配置来源只在 home/profile 文件中猜选，不能反映 CLI `--patch`、bundle 及合成优先级，界面可能编辑一个被其他层覆盖的值。建议优先通过 configEditor/有效配置来源定位 owner row；必须直接改文件时，使用保留注释的 YAML AST/CST，明确目标插件路径、来源文件和 revision，按真实加载器 schema 验证，提交前展示 diff。用同一行解析器“回读校验”无法发现共同误解。

**F06 · P1 · 不同 Provider 的凭据引用会碰撞，并覆盖已有密钥。** 位置：[storeProviderKey](/home/landasika/dshell/src/plugin/index.ts:1329)。合法 ID `a-b`、`a.b` 都被归一化为 `A_B_API_KEY`。`credential-collision` 存储两个假密钥后，credential store 只有一个引用，两个 provider 都指向它，第二次覆盖第一次。代码还先执行 `store.set`，之后才检查 provider 能否修改和 patch 能否写入，失败可能留下凭据副作用。建议使用带命名空间、无碰撞的稳定引用，保留显式已有绑定，先验证再提交并提供失败回滚。此处是配置完整性缺陷，不是已证明的外部密钥泄漏。

**F07 · P1 · 计划审核丢掉计划正文，用户可能看不到批准对象。** 位置：[handleQuestion 映射](/home/landasika/dshell/src/plugin/index.ts:1775)。插件只复制 id/question/header/multiSelect/options，丢掉上游 `detail` 与 `intent`；协议 AskedQuestion 和向导也没有承载这两个字段。rc.2 的 [plan-mode 实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/plan/plan-mode/src/index.ts#L318) 已把计划放在 `detail: args.plan`，并带 `intent.kind=plan-review`，这不是未来版本才需要的字段。`question-detail-and-replay` 确认正文没有到达客户端。建议保留正文与意图，计划/审核正文有独立滚动区，并让用户能阅读完整内容后决策；未知意图至少展示通用正文。上游 alpha 的交互意图扩展会继续放大当前有损映射的问题。

**F08 · P1 · 回答问题未核对会话归属和问题身份，迟到回答绕开上游规则。** 位置：[answerQuestion](/home/landasika/dshell/src/plugin/index.ts:2173)。只检查全局 questionRequests 中有没有 callId，未核对 pending 的 sessionId 与请求 sessionId，也不核对完整问题 ID、选项、批次重复。`question-cross-session-answer` 用 s2 handle 回答 s1 的 q1，问题 ID 与选项均不存在，s1 的等待仍被成功 resolve。对于不在内存 pending 中的回答，插件自行构造 `user-question-reply` 并 steer，而不是委托上游 owner。

rc.2 的 [userQuestions.answer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-questions/src/index.ts#L165) 校验 live root、continued question、完整唯一问题 ID 和重复排队；它生成的模型消息还包含原问题。建议继续中的问题使用该 API，live 请求入口也统一校验所属 session、有效 batch 与选项约束；跨客户端回答以第一份有效回答为准。现有进程内 200 条 settledAsks 不能替代持久化去重。这是同一 Host 内的会话完整性问题，未证明可跨 Unix 用户越权。

**F09 · P1 · attach 不重放正在等待的审批/提问，提问还会独占 Web 回答通路。** 位置：[attach](/home/landasika/dshell/src/plugin/index.ts:1830)、[handleQuestion](/home/landasika/dshell/src/plugin/index.ts:1752)。attach 只发历史与 running/idle，没有 pending actions 快照。`approval-late-attach` 中，原 viewer 有 pendingApproval，新 viewer 没有；提问同样丢失。某些 ask_user_question 可由持久事件重建，但 plan-review 等请求不保证有对应的 ask_user_question 调用，无法通用恢复。原 viewer 留着请求时，新窗口却不知道仍有操作等待。

提问路径有 watcher 就不再调用 waterfall 的 next；`nextWebCalled=0` 已复现，与审批的竞争处理不一致。最后一个 TUI 断开会拒绝其 pending question，不能直接假定 Web 会接手。建议 attach 返回带 cursor/revision 的一致快照，其中包含有效 pending IDs、正文与等待信息，再接增量；审批/提问都使用同一 owner 状态，在 Web/TUI 间支持 first-valid-answer-wins 和断连交接。

**F10 · P2 · 省略子命令、只带选项启动时会进入 help。** 位置：[parseArgs](/home/landasika/dshell/src/cli/main.ts:192)、[Herdr 恢复命令](/home/landasika/dshell/src/tui/herdr.ts:69)。只要 argv 非空且没有 positional command，默认就是 help。因此文档示例 `dshell --resume ID`、`dshell --no-color`、`dshell --socket PATH`，以及 Herdr 生成的恢复命令都无法按预期进入 TUI。`implicit-tui-options-pty` 使用真实 PTY 验证：`--resume` 打印 Usage 并以 0 退出，没有尝试连接 Host。建议默认动作在解析后统一决定；没有显式子命令、没有 print/help/version 时进入 TUI，并检查文档中的每条启动命令。

**F11 · P2 · 历史加载没有真正分页，大会话可在客户端初始化时崩溃。** 位置：[attach 全读](/home/landasika/dshell/src/plugin/index.ts:1845)、[history 全读再切片](/home/landasika/dshell/src/plugin/index.ts:1879)、[applyAttached](/home/landasika/dshell/src/backend/socket.ts:725)。首次 attach 把全部 events 塞进一个 NDJSON frame；所谓 history 页也先 readSession 全部，再 slice，TUI 没有接入 loadOlder。客户端 `events.push(...message.events)` 还受函数参数上限约束。`long-history-attach` 将 150000 条事件送入真实 SocketSessionHandle 的 attached 路径，抛出 “Maximum call stack size exceeded”。这是适配器最小复现，不是对真实 Host 生成 15 万事件后的性能实测，具体上限依 Node 引擎而变。建议先移除 spread 参数式追加，再用有上限的尾页快照、真实分页、UI 滚动补页及 frame/backpressure 限制。

**F12 · P2 · 关闭的 SocketSessionHandle 一直被 Backend 保留。** 位置：[注册 handle](/home/landasika/dshell/src/backend/socket.ts:492)、[dispose](/home/landasika/dshell/src/backend/socket.ts:695)。openSession 把 handle 放入集合，dispose 没有注销，历史 events 也仍被持有，只有整个 backend.disconnect 才清集合。`disposed-handles-retained` 在同一 backend 里打开/关闭 10 次，仍保留 10 个已关闭 handle 和 10 份历史数组。FakeBackend 则有 forget 回收，测试替身行为更理想，掩盖了真实 backend 的问题。建议通过注册注销回调统一生命周期，dispose 释放缓存和 pending waiters，并把两种 backend 的资源行为纳入同一 contract。

**F13 · P2 · Unicode 选择/复制和垂直编辑会切断代理对，复杂 emoji 宽度错误。** 位置：[columnSlice](/home/landasika/dshell/src/tui/width.ts:183)、[highlightColumns](/home/landasika/dshell/src/tui/width.ts:240)、[moveVertical](/home/landasika/dshell/src/tui/editor.ts:48)。前一阶段按 code point 计数，后面却用 UTF-16 slice；垂直移动也直接用 UTF-16 列。`unicode-copy-editor` 里，对 `🐳a` 选择前两显示列得到孤立 `\ud83d`，第三列得到 `\udc33`；`x\n🐳` 从第一行末向下移动，光标落到第二行 emoji 的代理对中间；family emoji 宽度算成 8。建议统一 grapheme cluster、显示 cell、UTF-16 offset 的映射；覆盖组合字符、ZWJ、旗帜、中文、tab 和 ANSI，不要只改一处 slice。

**F14 · P2 · 长问题和小高度终端会裁掉操作与输入光标。** 位置：[askWizard](/home/landasika/dshell/src/tui/app.ts:3658)、[布局与最终裁切](/home/landasika/dshell/src/tui/app.ts:4436)。向导没有接收可用高度，正文/选项无 viewport；主布局给 transcript 至少 3 行，最后整体 `slice(0, rows)`。真实 runTui 的 headless 渲染中，80×24 长中文问题加 8 个选项，只能看到 CHOICE_1—6，7、8 与 Submit 被裁掉；80×12 的 8 行输入把光标算到第 13 行，最后一行输入不可见。见 [80×24 渲染文本](./2026-11-04-evidence/ui-80x24.txt)。建议先给输入和必要操作区分配高度，再给 transcript；问题正文与选项分别滚动，光标始终跟随选项 viewport，小高度使用紧凑布局。

**F15 · P2 · 启动会话列表刷新了数据，却没有刷新当前显示的列表。** 位置：[refreshSessions](/home/landasika/dshell/src/tui/app.ts:872)、[prepareStartup](/home/landasika/dshell/src/tui/app.ts:928)、[startup 渲染](/home/landasika/dshell/src/tui/app.ts:4282)。启动时将 state.sessions 复制到 startup.sessions；后续 focus/poll 仅更新前者，渲染读后者。`startup-focus-refresh` 让 backend 返回新标题后，界面仍显示 ORIGINAL_TITLE。prepareStartup 还按 createdAt 重排，覆盖 refreshSessions 的 updatedAt 排序。建议列表保持单一数据来源，用 sessionId 保存选择，在刷新后继续按最后活动时间排序。

**F16 · P2 · 较新的问题结束后，较早尚未解决的问题会被隐藏。** 位置：[pendingQuestions](/home/landasika/dshell/src/tui/events.ts:410)。维护了 open map，却只记一个 newest ID；newest 已结束就直接返回 undefined，没有向前寻找仍开放的项。`older-pending-question-hidden` 中 older 仍开放、newer 已完成，最终返回 null。建议状态模型显式维护 pending 队列，支持切换和数量提示；不能仅把最后出现的 ID 当成当前所有待办。

**F17 · P2 · print 断连被误报超时，超时预算和非交互提问路径不完整。** 位置：[runPrint](/home/landasika/dshell/src/cli/print.ts:188)。只等待 turn/end 或 timer，没有订阅 backend disconnect。`print-disconnect-reported-as-timeout` 在 Host 断开后返回 exitCode 4、status timeout，reason 甚至还是默认的 completed。timer 还在 send receipt 后才开始，连接、会话选择与发送不包含在用户 timeout 里；pendingAsk 也未提供明确的非交互退出策略。建议从操作开始设统一 deadline，用明确终态区分断连/取消/超时/工具失败，对非交互提问及时给出稳定错误和结构化结果，并把所有阶段的错误纳入相同输出契约。

**解耦判断：安装与传输边界已经建立，数据和业务边界仍泄漏。** CLI 没有引入 DSH runtime，也不会下载另一份引擎；SocketBackend、FakeBackend、协议层以及“关闭 TUI 不 dispose Host agent”的客户端行为是良好的基础。审批已有 fail-closed deadline 和竞争处理，socket 权限/现有监听者/inode 清理也有专门逻辑，打包验证可用。这些应保留。

但下面几类耦合会让上游升级继续影响 UI 和行为：

| 耦合位置 | 当前实际依赖 | 后果与建议 |
| --- | --- | --- |
| UI 数据模型 | [SessionView](/home/landasika/dshell/src/backend/types.ts:149) 传原始 events；[SessionEvent](/home/landasika/dshell/src/protocol/messages.ts:140) 的 data 为 unknown；events、metrics、inbox、activity 等自己推断 DSH 事件形状 | 后端只隔离了调用形式。应让适配器输出 dshell 定义的消息块、工具状态、usage、pending actions、模型选择与队列，不让多个 UI 模块各自解析上游私有结构 |
| Host API 类型 | [插件本地 Like 接口](/home/landasika/dshell/src/plugin/index.ts:87) 与运行时断言代替真实上游 contract 编译 | 自己定义的接口和 fake 可以彼此一致，却同时偏离上游。开发期对固定上游类型编译，运行期做输入校验和 capability 探测 |
| 会话控制 | [create/resume/compose](/home/landasika/dshell/src/plugin/index.ts:661) 自行挂 preset、恢复模型和创建 agent；迟到提问自行 steer | 重复上游 owner 的生命周期、claim、恢复与去重规则。把这些操作收拢到版本适配器，优先委托 sessionController/userQuestions |
| 配置管理 | [profile 行编辑](/home/landasika/dshell/src/plugin/profile.ts:85)、credential 命名、Host restart 与 llm-pi-ai 格式 | 配置的来源、schema、事务语义进入通用产品层。分离配置管理能力，走有效配置和 owner 编辑接口 |
| 存储管理 | [session/delete](/home/landasika/dshell/src/plugin/index.ts:719) 直接扫描并 rename DSH session 目录，插件另存 tombstone | 把磁盘布局当 API；见下面 R01。列表整理优先使用上游归档，不由视图插件维护另一套存储事实 |
| 协议演进 | [protocol v2](/home/landasika/dshell/src/protocol/messages.ts:1) 的 capability 粒度较粗，无统一 RPC identity、schema、revision/幂等约定 | 同类型响应串线已有复现。补独立请求身份、稳定错误和广播 envelope，能力按实际行为拆分；无法强制旧端理解的新语义应升级协议 |
| 扩展接口 | [DshellBackend](/home/landasika/dshell/src/backend/types.ts:216) 同时包含会话交互与 Provider/Host 管理；package exports 只有 plugin/protocol 等 | 接第二后端需要伪装一批 DSH 管理能力。拆 ConversationBackend 与可选 AdministrationBackend，验证后再导出稳定 client/backend contract |

**R01 · 高优先级源码风险：物理删除跨过了存储 owner。** [deleteSession](/home/landasika/dshell/src/plugin/index.ts:743) 根据 `$DSH_HOME/sessions/<group>/session-uuid` 扫描并 rename，再用进程内 trashedIds 过滤列表。record.live 仅说明驻留，不等于正在运行；idle resident 会一直被提示“等待完成”。检查与 rename 之间也没有 writer lease 的原子保护，路径检查没有对父分组做 realpath。这个命令当前未进入公开 backend/protocol/UI，暴露面有限；没有对用户数据执行删除，也未声称复现了数据丢失。

rc.2 已有 [workspaceRegistry.archiveSession/unarchiveSession](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/workspace/workspace/src/index.ts#L365)，实现内部串行状态修改与活动校验。归档与物理删除语义不同；用于列表整理应先提供归档。真正 purge 需由上游存储 owner 提供受保护的接口和恢复机制，不应继续扩大本地目录猜测方案。

**R02 · 高优先级源码风险：恢复路径遗漏官方模型选择和生命周期逻辑。** [liveAgent](/home/landasika/dshell/src/plugin/index.ts:683) 只取 modelSelection.lastUsed；rc.2 的 [projection](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/model-selection-projection.ts#L65) 明确 `next = pending ?? lastUsed`。官方 [composeAgent](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts#L387) 还会 installSelection，插件的同名流程只挂 preset。对“切换模型但尚未使用、随后恢复”的场景，当前流程不能保证与官方一致。

另外 resuming singleflight 在 observe/compose 的 await 之后才登记，并发入口仍可能同时走 resume；官方 controller 还有 claim 与 subagent ownership 的处理。插件卸载时 [dispose 自建的 agent handles](/home/landasika/dshell/src/plugin/index.ts:2511)，所以“退出 TUI 不影响任务”不能推导成“热更 Host 插件也不影响任务”。上述属于实现差异和运行风险，未进行真实模型恢复/热更验证，不与 F01—F17 的运行复现混为一谈。

**R03 · 源码风险与体验缺口：信息存在多个本地事实来源。** 本地 modelOverride、从历史推导的 pending、会话缓存、硬编码的模型价格和上游实时状态并行存在。Web 更改模型后 TUI 可能继续显示 override；自定义 Provider 的费用不能仅按模型名推断；Herdr 状态报告主要识别审批，提问等待也应呈 blocked。Provider 草稿中的原始密钥应提供遮罩；保存模型为默认值的成功标记应确认真实持久化结果，不能把内存切换成功等同于后台保存成功。这些可作为后续专项验证点，本次不把每项都列为已复现缺陷。

**推荐渐进架构是将 DSH 知识收拢到一个版本适配层。** 保留 Unix socket，不必为了“解耦”立即重写传输或复制引擎：

~~~mermaid
flowchart TD
    UI["TUI / CLI"]
    VIEW["dshell 自有视图与动作契约"]
    RPC["RPC: id · version · capabilities · errors"]
    ADAPTER["DeepSeek Harness 版本适配器"]
    CONTROL["sessionController / userQuestions"]
    ADMIN["workspaceRegistry / configEditor / credentials"]
    UI --> VIEW --> RPC --> ADAPTER
    ADAPTER --> CONTROL
    ADAPTER --> ADMIN
~~~

视图契约可以从 MessageBlock、ToolState、PendingAction、ModelSelection、Usage、QueueItem、SessionSnapshot/Delta 开始；审批与提问有独立稳定身份。snapshot 带 revision/cursor，delta 可检测重复和缺口。原始未知事件可以作为诊断或通用工具卡片保留，但不要求每个 UI 模块理解它。模型调用、会话恢复、答案去重及存储写入由 owner 决定；客户端只表达动作和显示已确认状态。

落地顺序建议为：先把上游调用集中到适配器并修复结果归属/配置完整性；再输出规范化的 snapshot/delta，逐个移除 UI 中的上游事件解析；随后拆分配置管理；最后通过第二个小型 backend 验证边界是否实际成立。第二 backend 可以是另一个引擎或独立回放器，先验证会话/流式/取消/交互能力，再决定 SDK、ACP 或其他协议，避免预设某个协议已经覆盖所有管理能力。

**扩展建议按用户价值和依赖顺序排列。**

| 阶段 | 建议交付 | 可验收的结果 |
| --- | --- | --- |
| 立即修复正确性 | F01/F02/F03；F04—F09；F10 | 忙会话 print 不会读错轮次，默认 cwd 可预测，超时不串线，配置不误写/误删，计划完整可读，重新进入能继续处理待办 |
| 交互可靠性 | 真分页、资源回收、Unicode、小屏布局、单一列表来源、多 pending inbox、统一断连终态 | 长会话可打开，反复切换内存不线性持有历史；任意尺寸下输入/选项可达，待办不会隐藏 |
| 会话工作流 | 搜索、重命名、归档/恢复、pin、fork；每会话草稿持久化与审批模式 | 优先复用上游已有能力，退出与切换可恢复上下文，常用会话可快速定位 |
| 交互扩展 | 完整 plan review、工具 renderer registry、未知工具 fallback、有类型的附件与媒体块、跨 Web 同步 | 新工具不必改巨大 app；TUI 能解释支持或不支持的内容，实际状态与其他客户端一致 |
| 配置体验 | 展示有效配置来源/覆盖层、草稿 diff、事务保存、密钥脱敏、独立“应用/重启”状态 | 用户能判断编辑的是哪个来源、修改何时生效；失败不会部分提交 |
| 可移植性 | 导出稳定 contract，第二 backend，窄屏/无色/本地化与键位策略；之后再评估远程传输和更多平台 | 扩展后端无需伪造 DSH 管理功能，界面不依赖引擎私有事件 |
| 预算与指标 | Provider 提供价格/能力元数据，明确估算与实记，处理 cache/reasoning/自定义模型 | 自定义 relay 不会被套用错误模型价格；用户能理解费用来源和误差 |

**测试的主要缺口是替身与真实 owner 的行为差异。** 当前 216 项测试覆盖了许多单功能与模拟 socket 路径，但 fake 的 cwd、dispose、projection 和交互状态，比真实跨进程情形更简单，无法代表上游契约。建议增加以下具有独立判断依据的验证，而不是继续堆与实现同构的断言：

- 固定 rc.2 的真实 Host 无密钥 contract smoke：加载插件、创建/恢复、cwd 传递、分页/重连和稳定错误；需要模型的场景另列，不能把 smoke 当全部兼容证明。
- 固定上游类型/schema 的构建检查及录制事件 trace 回放，分别覆盖 message、tool、subagent、usage、model selection、plan review 和未知事件。
- print 的 busy session/多客户端 turn 归属、执行期间断连、deadline 全阶段、审批和提问的非交互结果。
- 多客户端同时回答、回答后断连重连、pending snapshot/增量竞态、错误 session/callId、完整 batch 和重复排队。
- Provider 使用真实 YAML 解析器和上游 schema 做独立 oracle：错误 owner、缩进变体、models 后字段、合成来源、凭据碰撞、写入失败与 revision 冲突。
- 真实 PTY 的 resize、粘贴、多行输入、中文/emoji/组合字符、无色和长问题 viewport；资源生命周期采用可解释的引用/订阅计数及必要的内存测量。
- 兼容矩阵按实际运行结果维护：rc.2 基线、rc.3 与当前上游分别记录，升级不能仅看 welcome capability。

文档与发布也应收敛到同一事实来源：README 记录的测试数、SUPPORTED-VERSIONS 的 149 测试及 dshell 0.2.0 表格，已与本次 0.5.0/216 项不一致；docs/dev 与 docs/development 内容重复，旧的 find 链接也需核验。建议发布时从 CI 生成版本/测试记录，并检查打包后的 README 资源链接与 skills 安装指引。现有文档明确要求手工 symlink skill，不能把“未自动安装”当成已经承诺功能的缺陷。

这份审查给出了可复查的缺陷与升级边界，不代表已穷尽所有真实模型、终端和平台行为。下一轮最有价值的工作是先按优先级修复执行与配置完整性，再用真实上游 contract 和多客户端场景验证适配层。
