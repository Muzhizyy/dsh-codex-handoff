# DSH 0.2 → Codex 回传实施计划

> 合同真源：`docs/2026-10-roundtrip-spec.md`  
> 目标：让实现者立即并行开工；真实桌面验收由 verifier 收口。

## 1. 合同冻结

本轮只增加两个 typed Remote：

```ts
returnPreview({ dshSessionId })
  -> { receiptId, expiresAt, context, contextSha256, contextBytes,
       scope, source, workspace, warnings }

returnSync({ receiptId })
  -> { status: 'created' | 'existing', sourceThreadId, codexForkId,
       resume: { argv, displayCommand } }
   | { status: 'unknown', sourceThreadId, codexForkId?, retry: 'reconcile-only' }
```

默认且唯一 MVP target 是持久 Codex fork。正常成功的定义是官方 `thread/fork` 已返回 id 且 `thread/inject_items` 已成功返回 `{}`。实测 injected raw context 不出现在 visible read/turns/items 中，因此 unknown 不对账、不重试并保持 unknown。artifact-only 不算成功。禁止直接写原 Codex rollout/DB。

## 2. 并行工作流

### A. DSH 0.2 基线迁移（先合入）

所有权：root package、Cordis patch、`src/dsh/**`（明确包含 `src/dsh/seed.ts`）、DSH integration fixtures/scripts，以及现有 shared schemas 中仅为 Session v4 迁移所需的 format/version hunks。

任务：

1. 把 peer/acceptance checkout/生成协议统一 pin 到 `0.2.0-rc.2` / `639ed01`，不要只放宽版本字符串。
2. 将 seed 从 Session v2 改为 v4 message envelopes。
3. 删除插件生成的 `session/end-seed`；继续只走 `ctx.agents.create()`。
4. 更新 structural runtime adapter 与 Typert 生成物，保留 `sessionQuery`、`storageDomain`、`workspaceRegistry` 等官方 service。
5. 更新正向导入 tests；真实 create/list/load/resume 放 verifier gate。

完成条件：所有现有 Codex→DSH 测试在 v4 contract 下通过，且无 physical persistence writer。

### B. Shared contract 与 compiler（可立即并行）

所有权：`src/shared/**`、新增 handback compiler 模块及其单测；不编辑 app-server transport 文件。与 A 协调 shared 文件：B/Hume 只追加 new-return DTO/schema/Remote hunks，不改 A 所有的既有 Session v4 format/version hunks。

任务：

1. 用 schema 定义 SPEC 中 request/response/error union；更新 `CodexHandoffRemoteSchemas` 和 contract。
2. 定义 canonical receipt digest；固定 compiler/schema version。
3. 从注入的 `SessionObservation` cut 编译 bounded、redacted user context。
4. marker 使用 receipt id；soft/hard limits 为 64/256 KiB。
5. 测试 canonicalization、redaction、prompt-injection quoting、稳定 digest、limit 与 marker。

注意：compiler 不查询 live session、不读 Git、不写 storage；输入必须已是 immutable snapshot DTO。

### C. Codex app-server transport（可立即并行）

所有权：新增 `src/codex/app-server*.ts` 及 isolated tests；不编辑 Remote/client。

任务：

1. 解析官方 Codex binary，执行 `--version` 与 capability probe；不得读取 auth/CODEX_HOME 内容。
2. 实现 stdio JSON-RPC framing、`initialize`/`initialized`、request ids、timeout、cancel/teardown、bounded stderr。
3. 实现 MVP typed wrappers：`forkThread`、`injectItems`；`readThread`/`listTurns`/`listItems` 只能用于元数据诊断，禁止声称可读取 injected raw item。
4. `forkThread` 固定 `excludeTurns: true`、非 ephemeral；`injectItems` 固定 user `input_text`。
5. 对 protocol mismatch fail closed；不得 fallback 到 rollout/db writer 或自动 model-running CLI。
6. 用 fake server 测乱序 response、notification、stderr、EOF、timeout、malformed response。

首选 transport 为 `codex app-server proxy`；isolated stdio 是 fork-only fallback。真实 0.159.2 测试由 verifier 执行。

### D. Receipt outbox 与 coordinator（依赖 B/C 接口）

所有权：新增 roundtrip coordinator/outbox 模块、storage adapter 与测试。

记录最小字段：

```ts
interface ReturnRecord {
  receiptId: string
  state: 'prepared' | 'dispatching' | 'forked' | 'injected' | 'complete' | 'unknown' | 'failed'
  prepared: FrozenReturnPreview
  codexForkId?: string
  attemptStartedAt?: string
  completedAt?: string
  version: number
}
```

任务：

1. 使用插件 `storageDomain` KV table，以 0.2.0-rc.2 的 `put/update` 做原子/版本检查更新；必须 await 其 Promise。该 Promise 已是 backend durability + event emission 边界，不实现或调用额外 flush。
2. `returnPreview` 顺序：权威 source metadata → one DSH observation → one Git snapshot → compile → await durable prepare `put/update` → response。
3. `returnSync` 顺序：load receipt → TTL/fresh source/log/Git/cwd 校验 → single-flight/CAS → fork → await durable fork-id `put/update` → inject success `{}` → await durable injected/complete `put/update`。
4. crash recovery 严格执行 SPEC：已知 fork id 且确定 inject 未发送时才可继续；inject outcome 不确定则永久 unknown；未知 fork response 不再 fork。
5. 相同 receipt 20 个并发请求测试只调用一次 fork；complete 重试返回 `existing`。

### E. Host Remote composition（依赖 A/B/C/D）

所有权：`src/host/**` 与 host/integration tests。

任务：

1. 将 `sessionQuery.observeSession`、source index、repository inspector、compiler、outbox、app-server client 注入 coordinator。
2. source thread/revision/fingerprint 只能来自现有 authoritative import record/recovery metadata；Client 值不参与信任决策。
3. `returnSync` 只接受 opaque receipt id。
4. 统一映射稳定错误码与 cancellation。
5. 日志只含状态、耗时、bytes；不含 context、env、auth 或完整路径。

### F. Client UI（B 合同生成后即可开始）

所有权：`src/client/**`、locale 与 client tests。

任务：

1. 在现有 `sidebar.footer.action` + `shell.overlay` 增加“同步回 Codex”。
2. preview 显示完整 redacted context、source/workspace summary、DSH cursor、bytes、warnings 和 TTL。
3. 明示“创建 Codex 分支；原对话不变；不会运行模型”。
4. 成功态显示 fork UUID、Copy ID、Copy resume command；unknown 不显示成功。
5. 不使用 `codex://`。复制 command 来自 Host，不在 Client 拼 shell string。
6. 本轮不实现自动打开。后续仅允许用户点击可信按钮，Host 用固定 argv `[resolvedBinary, 'resume', validatedUuid]` 启动。

## 3. 合并顺序

1. A：DSH v4 baseline。
2. B 与 C：互不依赖，并行。
3. D：接入 B/C fake ports。
4. E：Host composition 和真实 source/Git freshness。
5. F：接 generated Remote。
6. 统一 regenerate Typert、build/package checks。
7. verifier 在真实 DSH/Codex desktop 上跑 acceptance。

若多人并行，shared/root 配置只归 A/B 指定 owner；C/D/F 不顺手修改它们，避免生成物和 package 冲突。

## 4. 必测矩阵

### Unit

- observation cursor/revision、source metadata、Git fingerprint 任一变化使 receipt stale。
- TTL 边界、canonical digest、64/256 KiB、redaction、marker。
- JSON-RPC initialize/fork/inject/read/list 的成功与畸形响应。
- storage 每一状态转换、`put/update` durability failure 与 CAS conflict。
- `created`、`existing`、`unknown` 联合类型。
- resume command 的 Windows/PowerShell 与 POSIX 安全显示；结构化 argv 不走 shell。

### Fault injection

- durable prepare 前 crash：无 receipt。
- fork request 前 crash：可安全重新进入 single-flight。
- fork response 后、保存前断线：unknown，不自动再 fork。
- fork id durable 后 crash：复用该 fork。
- inject response 丢失：永久 unknown，不重发、不用 visible history 猜测。
- 回归测试固定：resume/read/turns/items 对 injected raw context 返回空，不得把空解释为“未注入”。
- 20 个并发 `returnSync`：一个 fork、一个注入。

### Security

- grep/architecture test 禁止 Codex rollout/db writer。
- 禁止 auth/credential reads 与环境全集日志。
- DSH tool output 中伪指令保持 quoted user context。
- 不调用 `turn/start`，不执行历史 tool，不运行 Git 写命令。

## 5. Verifier 真实环境 gate

这些 empirical 项不阻塞编码开始，但阻塞发布：

1. 精确 Codex 0.159.2 的隔离 synthetic-thread 流程已证明 initialize → inject source → fork → inject fork → read、正确 `forkedFromId`、持久化和 idle/no-inference；verifier 只需补真实桌面既有 source。
2. 已实测 exact resume/read/turns-list/items-list 对 injected raw context 均不可见。把该结果作为回归测试；MVP 删除自动 reconciliation 承诺，unknown 不自动转成功。
3. 在真实既有 source 上再次证明 inject 不产生 turn/inference/tool activity，原 thread history 不变。
4. 返回 UUID 可由实际探测 binary 的 `resume <UUID>` 打开。
5. DSH 0.2.0-rc.2 desktop 中 preview/sync/refresh 流程真实可用。
6. DSH v4 正向导入可 create/list/load/resume 并继续正常工具调用。
7. app-server proxy 不可用时，isolated fork fallback 的行为与清理正确。

记录实际命令、版本、thread ids 的脱敏形态和 PASS/FAIL；不得记录 context 正文或认证信息。

## 6. 本轮明确不做

- 原 Codex thread 注入。
- `codex://` 导航。
- 自动 resume/spawn。
- model-running CLI fallback。
- 实时双向同步、跨机器同步、artifact-only 成功。

这些需求只能在默认 fork 链路真实验收通过后另开窄增量。
