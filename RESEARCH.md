# dsh-codex-handoff 调研报告

> 历史基线提示（2026-10-02）：本报告的原始调研日期与当时记录的 DSH `0.1.3-alpha.1` pin 保留作历史证据；该 pin 和相关兼容结论已被当前 DSH `0.2.0-rc.2` 实现基线取代。最新回传决策见[增量 SPEC](./docs/2026-10-roundtrip-spec.md)与[实施计划](./docs/2026-10-roundtrip-plan.md)，不要把下文旧版本结论当成当前兼容声明。

> 调研日期：2026-09-05（Asia/Shanghai）  
> 结论状态：实现前基线；所有技术结论均来自固定 commit 的一手源码、官方文档或本机只读结构抽样。  
> 范围限制：本报告不记录任何本机对话正文、命令、凭据、用户名或仓库内容。

## 1. 执行摘要

项目可行，但必须按当前 DeepSeek Harness（下称 DSH）的真实扩展模型实现，不能复制旧导入器的持久化写法。

最关键的结论如下：

1. DSH 目前是 developer preview，公开 API 仍可能破坏性变化；本项目必须锁定已验证版本并设置启动期兼容探针。
2. 当前 DSH session format 是 `2`。`ctx.sessions.create()`（core SessionStore）只创建内存 Session，明确不负责持久化；Web Client 的 `ctx.sessions.create()` 也只接受 workspace/cwd/sessionId，不接受 seed。
3. 可持久化、可正常出现在列表且可 resume 的导入路径是 Host 侧 `ctx.agents.create({ sessionId, seed, meta, setup })`。Agent factory 把 Agent、Session、持久化 writer 和生命周期作为一个事务发布。
4. DSH 的 seed 必须从 `seq=0` 连续、JSON 可无损序列化、没有开放的 turn/step、没有悬空 tool call。因此 Codex 的未配对工具调用不能伪造成功结果；应降级为带诊断的普通历史说明。
5. 历史 `tool/call` / `tool/result` 只作为 seed 记录，不会触发执行。导入后新 Agent 才使用正常 DSH 工具。
6. 官方 UI 稳定扩展点足够实现 MVP：`sidebar.footer.action` 作为入口，`shell.overlay` 承载浏览器/预览/模式选择；没有发现稳定的第三方顶级页面路由 API。
7. DSH 提供真实的 `ctx.llm.stream(GenerateOptions)`，可用当前已配置 provider/model 做 Smart Handoff 的语义提取；没有 provider/model 或调用失败时必须回退到确定性提取，不能阻塞导入。
8. Codex 当前 JSONL 是异构、可扩展的 rollout envelope。解析器必须流式、容错、保留未知记录诊断，且以首个 `session_meta` 为该 rollout 的 canonical metadata。
9. 参考项目验证了 discovery、seed、workspace、UI slot 的可行性，但三个导入项目仍在写 format v0 或带有当前 API 不兼容假设；只可借鉴算法和 UX，不可复制其 persistence 层。
10. 产品差异点不是“再做一个聊天导入器”，而是把对话证据与实时 Git/filesystem 事实进行冲突消解，生成有 provenance、受 token budget 约束、可直接执行下一步的 handoff。

## 2. 研究方法与可复现基线

### 2.1 固定版本

| 项目 | 所有者/来源 | 固定 commit | 观察到的版本/日期 | 用途 |
|---|---|---|---|---|
| DeepSeek Harness | `deepseek-ai/deepseek-harness` | `d347e703908d0406b7a7ef80e3a0e594d86b2215` | `dsh-v0.1.3-alpha.1`; commit 2026-09-04 | 目标平台唯一技术权威 |
| OpenAI Codex | `openai/codex` | `de7874067fe8cb8f4846dd4d8b848965ce79070f` | commit 2026-09-04 | Codex rollout/session 格式权威 |
| dsh-codex-migrate | `polarskicpl/dsh-codex-migrate` | `3e56b0804770794f376f7254e93ba3f6163b9913` | package 2.0.0; commit 2026-08-28 | 迁移/bridge/UI 参考 |
| dsh-import-agents | `Chang-Tong/dsh-import-agents` | `238d1a650a3f403e1c05227dd73be527728bc699` | package 0.3.0; commit 2026-08-29 | 多 Agent 导入参考 |
| dsh-plugin-session-import | `huguangyu666/dsh-plugin-session-import` | `13139abe5820ea07bf5a89cef36801ee17987aa0` | package 0.1.1; commit 2026-08-16 | Discussion #1087 实现参考 |

固定源码入口：

- [DSH README](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/README.md)
- [DSH repository AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/AGENTS.md)
- [Codex rollout history types](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/history/src/lib.rs)
- [Codex protocol ResponseItem / SessionMeta](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/protocol/src/protocol.rs)

### 2.2 本机结构抽样方法

对 `CODEX_HOME` 默认位置下近期 4 个 rollout JSONL 以及 `session_index.jsonl` 做了只读、字段级抽样：只统计键名、类型、行长和是否可解析；没有输出或复制任何消息正文、工具参数、命令、文件路径或隐私字段。

观察到：

- 每行 envelope 包含 `timestamp`、可选 `ordinal`、`type`、`payload`。
- 顶层类型包括 `session_meta`、`turn_context`、`response_item`、`event_msg`、`world_state`、`token_usage_record`、`inter_agent_communication_metadata`。
- `response_item.payload.type` 包括 `message`、`reasoning`、`custom_tool_call`、`custom_tool_call_output`、兼容期的 `function_call`、`function_call_output`。
- 消息块出现 `input_text`、`output_text`、`encrypted_content`；角色出现 developer/user/assistant。
- 单行可非常大；样本中见到约 372k 和 963k 字符的行，证明不能 `readFile` 后整体 `split`。
- `session_index.jsonl` 行包含 `id`、`thread_name`、`updated_at`，可作为标题加速索引，但不是历史事实源。

## 3. DeepSeek Harness：能力、契约与限制

### 3.1 项目成熟度与插件形态

官方 README 把 DSH 标为 developer preview；根 AGENTS.md 进一步说明公开 API 仍是 pre-stable，Session JSONL 的演进必须通过相邻 migration。结论：本插件应锁定 `0.1.3-alpha.1` 的兼容范围，并在运行时检查关键服务/方法，而不是假定任意未来版兼容。

可分发第三方插件的官方形态是静态 Cordis bundle：package 声明 `dsh.bundle.patch`，Host row 由 patch 组合；有浏览器代码时再声明 `dsh.client`（`platform: web`、`inject`、导出 `./client`）。安装命令是 `dsh plugin --profile web add <package>`。参考：[Publishing plugins](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/user/develop/basic/publish.md)。

动态 extension runner 是 Agent 在运行中生成/挂载扩展的能力，不是本项目的发布或持久化机制。

### 3.2 Session 与 Agent

当前 `SESSION_FORMAT_VERSION = 2`。`SessionHeader` 只允许：version、id、createdAt、可选 cwd、parentSession、isSeeded、subagent origin/delegationDepth、agentPreset；不能塞任意 source metadata。参考：[session types](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts)。

`SessionStore.create()` 的源码注释明确表示 persistence 不在该服务中实现；单独发布到 session store 的 Session 不会自动持久化。参考：[SessionStore](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/index.ts)。

`AgentRegistry.create()` 的 `CreateAgentOptions` 支持：

- caller 提供的 `sessionId`；
- `meta.cwd` / agentPreset 等合法 header 字段；
- `seed: readonly SessionEvent[]`；
- 可选 `inheritedEventCount`；
- `agentOptions`、`signal`、`setup`。

它要求 seed 序列连续、可无损 JSON 化、turn/step 全部闭合且无 dangling tool call；factory 在 setup 完成后原子发布 Agent 与 Session，并挂接正常生命周期。参考：[AgentRegistry and CreateAgentOptions](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/src/index.ts)。

因此目标导入流程必须是：

```text
Client UI
  -> typed plugin Remote
  -> Host validates and compiles seed
  -> ctx.agents.create({ sessionId, seed, meta: { cwd }, setup: preset.mount })
  -> workspace.attachSession(sessionId)
  -> Client refresh + ctx.sessions.open(sessionId)
```

不能采用：Client `ctx.sessions.create(seed)`（该参数不存在）、core `ctx.sessions.create()`（不持久化）、直接写 `.jsonl/.zst`、直接调用 `sessionPersistence.create({version: 0})`。

### 3.3 事件、历史工具与 resume

当前基本 surface 历史包含 user/assistant message、tool result；tool call 是 log-only 关联事件，靠 callId 与 result 配对。完成历史需要平衡的 `turn/start` → 可选 step → messages/tools → `turn/end`。

构造 seed 只把记录交给 Session 验证和持久化；不会把历史调用重新交给 tool runner，所以工具不会 replay。后续用户在创建出的普通 Agent session 中发送新输入时，DSH agent loop 才会使用当时 preset 中注册的普通 DSH tools。

正常恢复走 `ctx.agents.resume({ resumeSessionId, ... })`；Session Controller 通过正常 query/list 看见已持久化的 session。列表出现、load、resume 和新工具执行都必须纳入真实集成测试，而不能只检查文件存在。

对于源 Codex 中开放 turn 或没有 result 的 tool call，导入器不能制造一个“成功”结果来骗过 DSH seed validator。正确降级是：不生成 DSH tool/call，改成明确标记为 incomplete historical action 的普通文本节点并产出 diagnostic。

### 3.4 Workspace 和 cwd

官方 workspace API 支持 `ctx.workspaceRegistry.resolveByPath(path)`、`create(path, title?)` 和 `workspace.attachSession(sessionId)`。Workspace 是 UI 分组；SessionHeader 的绝对 `cwd` 才决定新 Agent 的执行目录。参考：[Workspace subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/subsystems/workspace.md)。

创建顺序必须是：先校验绝对 cwd 并创建 Agent/Session，再 resolve/create Workspace 并 attach。attach 失败不应回滚已成功持久化的 session；应返回 `created_unattached` 警告并允许用户打开它。cwd 缺失则不允许 Smart Handoff 写入一个猜测目录，须让用户选择已存在目录。

### 3.5 Web UI 扩展点

官方 Slots 文档和源码确认以下稳定 slot：

- `sidebar.footer.action`：root-scoped additive list，适合作为 `Continue from Codex` 全局入口；
- `shell.overlay`：root-scoped additive list，适合 session browser/modal/wizard；
- `conversation.session.header.actions`：session-scoped list，只适合已打开会话的动作；
- `settings.section`：适合设置，不适合主要导入流程。

参考：[Slots subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/subsystems/slots.md)。未发现稳定的第三方顶级 router/page slot，MVP 不承诺独立导航页，也不做 DOM patch。

客户端导入完成后的真实导航接口是 `ctx.sessions.open(id)`；其契约要求 id 已在 list 或保留的 subagent address 中。因而 Remote 成功后应 `await ctx.sessions.refresh()`，确认列表出现，再 `ctx.sessions.open(id)`。参考：[Client sessions contract](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/api/session-controller/src/client/contract/sessions.ts)。

`ConversationNodeDefinition` 定义的是已存在 conversation event 的渲染/折叠节点，不是路由、页面或导入入口。

### 3.6 当前模型调用

`ctx.llm.stream(options)` 是公开 Host service；`GenerateOptions` 明确允许 hand-built one-shot messages，并包含 provider、model、messages、system、tools、maxTokens、signal、可选 sessionId/purpose。参考：[LLM runtime](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm/src/index.ts) 与 [GenerateOptions](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm/src/types.ts)。

官方 compaction 代码展示了正确模式：从 session 最近 request header 或 agent options 解析 provider/model，通过 `BlockAssembler` 收集 stream，并把 error/aborted/max-token/空输出当作失败。参考：[basic compaction summarizer](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/compaction/compaction-basic/src/summarizer.ts)。

限制：`purpose` 当前仅声明 `compaction | session-title`，本插件不能伪造新的 purpose。Smart extractor 的调用可不传 purpose，并通过 feature probe 检查 `ctx.llm`、provider/model。当前模型不可用时走 deterministic fallback。

## 4. Codex session 格式

### 4.1 路径和 canonical identity

官方目录是 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`，另有 `$CODEX_HOME/archived_sessions`；冷 rollout 还可能只有 `.jsonl.zst` 表示。官方 `open_rollout_line_reader` 会透明打开 plain/compressed sibling，且压缩切换存在短暂的 representation race。`CODEX_HOME` 优先取环境变量，否则 OS home 下 `.codex`。参考：[rollout list](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/list.rs)、[rollout compression](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/compression.rs)、[rollout constants](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/lib.rs)、[home resolution](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/utils/home-dir/src/lib.rs)。

当前官方逻辑把 rollout 的第一个 `SessionMeta` 视为本文件 canonical metadata；导入历史可能在后续再次出现 `SessionMeta`，不能让它重定义根 session。第三方按“最后一个 meta”分组会误归类。另一个关键区别是 stable thread id 与 immutable rollout revision id：普通线程两者相同；`thread/revert` 保持 `SessionMeta.id`/thread id 稳定，但创建带 `_rollout-id` 后缀的新 rollout。官方 filesystem fallback 对 stable thread 选择最新 revision，而 `history_base` 按 rollout id 指向另一 immutable file 的 ordinal prefix。参考：[thread/rollout lookup](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/list.rs) 与 [rollout metadata helpers](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/metadata.rs)。因此产品需要 logical-thread resolver，不能把每个文件当成独立 session，也不能把 `history_base` 一概误判成 fork parent。

`SessionMeta` 当前包括 session/thread id、cwd、timestamp、originator、cli_version、source、provider、base instructions、history/fork/subagent/context-window 字段。解析器只能依赖其需要且已经验证的字段，其余保留为未知/诊断。参考：[SessionMeta](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/protocol/src/protocol.rs)。

### 4.2 RolloutItem 与 ResponseItem

官方 `RolloutItem` 当前包括 SessionMeta、ResponseItem、InterAgentCommunication、Compacted、TurnContext、TokenUsageRecord、WorldState、SecurityRiskScore、RetainedContext、EventMsg、RealtimeItem 等。解析器必须以 allow-known / preserve-unknown-diagnostic 方式处理，而不是遇到未知 type 失败。参考：[RolloutItem](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/history/src/lib.rs)。

`ResponseItem` 当前至少覆盖 message、reasoning、local shell、function call/output、custom tool call/output、tool search、web search 等。函数参数在 wire 上是 JSON 字符串；不能用正则替换后再解析。reasoning 只保留可读 summary；`encrypted_content` 不解密、不进入 handoff。参考：[ResponseItem](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/protocol/src/models.rs)。

`CompactedItem` 带 summary message，并可能带 replacement_history、retained_context 等。MVP 把 message 作为已有历史摘要并标注 provenance；若 replacement_history 可安全解析，可按官方顺序替换被压缩段，但不能声称恢复不存在或加密的原始历史。

`session_index.jsonl` 是名字更新索引，最近一条 wins；它只用于显示标题，不覆盖 rollout 的 cwd、时间或消息。参考：[session index](https://github.com/openai/codex/blob/de7874067fe8cb8f4846dd4d8b848965ce79070f/codex-rs/rollout/src/session_index.rs)。

### 4.3 解析器要求

由官方类型和本机抽样共同得出的要求：

- 使用 line stream，限制单行字节、总读取字节、记录数、工具结果预览字节；
- 单个 malformed line 产出带 line/ordinal 的 diagnostic，尽可能继续；
- 首个合法 `session_meta` 是 identity/cwd 权威；缺失时仍可预览，但创建前要求用户确认 source identity/cwd；
- callId 配对 function/custom tool call 与 output；孤儿 output 丢出 tool 轨迹并记录诊断；悬空 call 降级文本；
- system/developer/environment 注入默认不作为用户意图；只提取明确的约束，并保留来源类型；
- 未知 record 不崩溃，不擅自映射为消息；
- 对路径、参数、输出做展示/模型输入前 redaction；
- fingerprint 基于已读取的源文件身份与内容哈希，不能只用 mtime。

## 5. 现有项目分析

### 5.1 dsh-plugin-session-import / Discussion #1087

Discussion #1087 宣布多源 session import、列表/搜索/批量、超大内容保护、工具配对和 workspace。源码确实提供 `sidebar.footer.action` + modal，Host 发现/搜索和 `ctx.agents.create({ seed, setup })`，证明大方向可行。[Discussion #1087](https://github.com/deepseek-ai/deepseek-harness/discussions/1087)；[repository](https://github.com/huguangyu666/dsh-plugin-session-import/tree/13139abe5820ea07bf5a89cef36801ee17987aa0)。

不能直接复用的部分：

- Codex parser 对工具参数做字符串/正则重写，存在信息损失和误解析风险；
- orphan result 被丢弃，unconvertible tool 被折成 note，诊断与 provenance 不足；
- 截断算法偏“保留头部几个 user anchor + tail”，不是基于事实优先级；
- 每次随机目标 session id，重复导入会产生副本；
- client 使用手写 bundle 和直接 fetch Host 路由，不是当前强类型 Remote；
- 元数据/API 形状针对旧 DSH，需按当前 v2 重做；
- 没有 repository reconciliation、failed-attempt/decision 专门建模和可执行 next state。

### 5.2 dsh-import-agents / Discussion #1362

该项目支持 pi/opencode/codex/claude，多 Agent session 同步、稳定源 id、工具轨迹、workspace attach 和一个同步按钮。[Discussion #1362](https://github.com/deepseek-ai/deepseek-harness/discussions/1362)；[repository](https://github.com/Chang-Tong/dsh-import-agents/tree/238d1a650a3f403e1c05227dd73be527728bc699)。

可借鉴：递归发现、标准化消息块、call/result 配对、稳定 identity、幂等思路。

当前硬风险：writer 复制 DSH 物理 JSONL/zstd，并写 `version: 0`；目标 DSH 已是 format 2。它还按最后一个 SessionMeta 推导 root，和当前 Codex 的首 meta canonical 规则冲突。UI 是同步动作，不是有搜索、预览、模式选择的 handoff 产品。

### 5.3 dsh-codex-migrate

2.0.0 是更广泛的单向迁移/可选双向 bridge：Codex 配置、MCP、memory、project、session inventory、设置页、归档和 bridge。它正确声明 `dsh.bundle` / `dsh.client`，使用 Typert Remote、`ctx.sessions.open()` 和设置 slot。[repository](https://github.com/polarskicpl/dsh-codex-migrate/tree/3e56b0804770794f376f7254e93ba3f6163b9913)。

可借鉴：active/archived inventory、增量 fingerprint cache、typed Remote、双语 locale、安装打包、目标导航。

当前硬风险：Codex→DSH 路径仍调用 `sessionPersistence.create({ version: 0 })` + append；bridge 也直接追加物理事件。这对当前 format 2 不安全。它主要把会话转换为 Markdown/结构化迁移，不做实时 repo 事实消解或 `AgentHandoffManifest`。

### 5.4 竞品差异矩阵

`是` 表示固定源码中存在完整能力；`部分` 表示存在基础能力但不满足本项目语义；`否` 表示未发现。表格是源码审阅结果，不采用 README 自述代替。

| 能力 | dsh-codex-migrate 2.0.0 | dsh-plugin-session-import 0.1.1 | dsh-import-agents 0.3.0 | 本项目目标 |
|---|---|---|---|---|
| Discover sessions | 是：active/optional archived inventory | 是：递归、多源、缓存 | 是：多 Agent 递归扫描 | 是：active+archived、分页/搜索 |
| Full history | 部分：转换后迁移/Markdown，有裁剪 | 部分：按预算裁剪 | 部分：标准化/合并 | 是：可审计、显式缺失/截断 |
| Tool trajectory | 部分：转换事件 | 部分：严格配对、无法转换则 note | 是/部分：配对并可放 placeholder | 是：只保留真实配对，绝不伪造成功 |
| Workspace binding | 是 | 是 | 是 | 是：cwd 为执行真相，workspace 为 UI 分组 |
| Search UI | 部分：设置页 inventory/filter | 是：modal/search | 否：同步按钮 | 是：专用浏览器、搜索、筛选、预览 |
| Repository inspection | 否 | 否 | 否 | 是：只读 Git/filesystem inspector |
| State reconciliation | 否 | 否 | 否 | 是：正式 truth hierarchy |
| Smart handoff | 否 | 否 | 否 | 是：默认模式 |
| Failed-attempt extraction | 否 | 否 | 否 | 是：状态化、带 evidence |
| Decision extraction | 否 | 否 | 否 | 是：决策+理由+provenance |
| Token-budget compression | 部分：字符/导入上限 | 部分：分层裁剪 | 部分：长度截断 | 是：section priority + token estimator |
| Actionable next state | 否 | 否 | 否 | 是：验证状态、blocker、next actions |

## 6. 推荐技术决策

1. **静态 Host+Client bundle。** Host 拥有 filesystem、Git、parser、LLM、Agent/Workspace 集成；Client 只展示强类型 view model 并调用 Remote。
2. **Smart Handoff 默认，Full Trajectory 显式选择。** Smart 是真实价值；Full 是迁移/审计兼容模式。
3. **当前 DSH API 创建，不写物理格式。** 一律 `ctx.agents.create(seed)`；format 兼容由 DSH 自己负责。
4. **强类型 Remote。** 方法建议为 discover/search/preview/analyze/create/getCompatibility；所有参数 Host 重新验证。
5. **确定性管线先行，LLM 是受控增强。** parser、repo inspection、reconciliation、budget 全部确定性；LLM 只把经过 redaction 的证据提炼成候选 claims，输出必须 schema validate，再与确定性事实 reconcile。
6. **不可变导入 revision。** import key = source type + source session id + content fingerprint + mode + canonical workspace path；同 key 重试返回已有目标，不改写历史；源变化产生新 session revision。
7. **模型可见 handoff 用普通 user/plugin-source message。** 使用 DSH 已声明的 `{kind:'plugin', plugin:'dsh-codex-handoff', form:'snapshot', sections:[...]}`，不发明 message source kind。审计基线是 typed storage-domain import index + recognized source notice；插件自有 `ignorable:true` log-only event 只能在真实 unknown-reader/persistence/resume spike 通过后作为可选增强。
8. **不要承诺完整恢复加密或缺失历史。** Full Trajectory 是“所有可解析、可安全表示的历史”，并用 completeness/diagnostics 明示缺口。
9. **overlay 不是页面。** MVP 使用 sidebar action + shell overlay，未来只有在目标 DSH 提供经验证的 page/router slot 后再升级。

## 7. 已知风险与验证门

| 风险 | 影响 | 设计控制 | 实现前/发布门 |
|---|---|---|---|
| DSH pre-stable/API 漂移 | 插件不加载或 session 不可恢复 | peer range 收窄、启动探针、compatibility matrix | 在固定 release 做 build+真实 create/list/load/resume |
| 旧参考写 format v0 | 数据不可读/迁移错误 | 不复用 writer；只走 Agent API | 禁止任何 source import `sessionPersistence.create/append` |
| Codex event vocabulary 扩展 | 丢历史或崩溃 | 流式 tolerant parser、unknown diagnostics | fixture 加 unknown/new variant |
| 超大行/工具输出 | OOM、UI 卡死、模型成本失控 | byte/record/result/total caps、分页和 abort | 1MB 单行及超预算测试 |
| prompt injection in transcript/repo | extractor 偏离、数据泄漏 | 源内容视为 untrusted data、无工具 LLM call、schema、redaction | adversarial fixture |
| 模型不可用/输出非法 | Smart 阻塞 | deterministic fallback；明确 degraded 标记 | 无 provider、timeout、malformed JSON tests |
| cwd 不存在/越界/symlink | 错项目或越权读取 | canonicalize、存在性、root scope、用户确认 | missing cwd/path traversal/symlink tests |
| tool pairing 不完整 | seed validation 失败或事实造假 | 只映射真实闭合 pair；悬空降级文本 | dangling/orphan/duplicate callId tests |
| 导入成功但 workspace attach 失败 | UI 难找 | 返回 created_unattached、refresh/open、可重试 attach | 故障注入 E2E |
| “有 session”但不能继续 | 核心价值失败 | acceptance 必测新输入→普通 tool→仓库改动 | 最终 Sora 独立实际 continuation |

## 8. 研究结论

GO，带条件：实现必须以 DSH `0.1.3-alpha.1` / format 2 作为首个兼容目标；在真实 `ctx.agents.create(seed)` 集成 spike 通过之前，不允许把旧 persistence writer 当作 fallback。Smart Handoff 应以确定性 repo 事实和 schema-valid manifest 为核心，模型提取只做增强。最终验收必须证明创建出的 session 能在正常列表中打开、跨进程 resume、调用标准 DSH tools 并继续修改原 cwd。
