# DSH 0.2 → Codex 回传增量 SPEC

> 状态：implementation-ready；2026-10-02  
> DSH：`dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84`  
> Codex：Windows Store `26.928.2636.0`，内置 `codex-cli 0.159.2`  
> 仓库基线：`dff7d29`

本文件增量覆盖 `SPEC.md` 的 DSH `0.1.3-alpha.1`、Session Format v2，以及“不实现 DSH→Codex 同步”的旧结论。未覆盖的只读源、redaction、repository truth hierarchy、typed Remote 和禁止物理写 persistence 等约束继续有效。

## 1. 已冻结产品决策

MVP 只实现显式的一次性回传：从原 Codex thread 创建持久化 fork，再把 DSH 最新上下文作为 user-role Responses item 注入新 fork。

- 原 Codex thread 不变。
- 不调用 `turn/start`，不启动模型，不执行工具。
- 只有官方 Codex app-server 已返回 fork id，且 `thread/inject_items` 已返回成功的空 response `{}`，才能报告成功。断线造成的未知结果永久保持 `unknown`；不得重注入、再 fork 或伪称可由 visible history 对账。
- 只生成 Markdown/JSON artifact 不算“同步回 Codex”。
- 不直接写 Codex rollout、数据库或内部文件。
- “写回原 thread”不属于本 MVP；后续只能通过显式可信按钮和同一 Codex daemon 的 `thread/resume` + `thread/inject_items` 增量实现。

## 2. 已验证 API 基线

### DSH 0.2.0-rc.2

- 官方 tag [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2)，commit [`639ed01`](https://github.com/deepseek-ai/deepseek-harness/commit/639ed015397290b3745d163aafe02ffee4aa3f84)。本机桌面 runtime 与 `dsh --version` 均验证为该版本。
- Session Format 是 v4。现有 v2 seed 必须迁移：使用 v4 `assistant/message`、`tool/result` envelope；插件不得生成 constructor 所有的 `session/end-seed`。
- 新建仍走 `ctx.agents.create()`；回传读取走 `sessionQuery.observeSession()` 的单个不可变 observation cut；不得物理写 DSH session persistence。
- `sidebar.footer.action` 与 `shell.overlay` 仍可用。

### Codex 0.159.2

- 官方 [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server) 定义 `thread/fork`、`thread/resume`、`thread/read`、`thread/inject_items`。`inject_items` 把 Responses items 持久追加到已加载 thread 的 model-visible history，不创建 turn、不触发 inference。
- 精确本机二进制生成的非 experimental JSON schema 包含上述方法；`ThreadInjectItemsParams` 要求 `threadId`、`items`，response 为空对象；fork/resume 支持 `excludeTurns`。
- 关键实测结论：对已注入的 synthetic fork 执行 `thread/resume({ excludeTurns:true })`、`thread/read({ includeTurns:true })`、`thread/turns/list({ itemsView:'full' })` 和 `thread/items/list`，visible turns/items 均为空，无法看到 injected text。`inject_items` 写入 model-visible raw rollout context，不等于 visible turn/item；MVP 禁止用这些 read/list API 做 marker 对账。
- 本机隔离实测已完成：Windows `codex.exe 0.159.2` 在临时空白 Codex home 中成功执行 `initialize`、创建 synthetic source thread、`thread/inject_items`、`thread/fork`、向 fork 再次 `thread/inject_items`、`thread/name/set` 与 `thread/read`；`forkedFromId` 正确，返回分支保持 idle，source 与 fork 均持久化，整个回传段没有 inference。该证据冻结 RPC 可行性；真实桌面既有 thread 的端到端流程仍由发布 verifier 覆盖。
- 研究与插件都不读取 Codex auth、token 或 credential 文件。隔离实测可以设置临时 `CODEX_HOME` 作为启动环境，但其中的认证与 persistence 始终由 Codex 自己拥有和访问。

## 3. 两个 Remote RPC

类型必须由 runtime schema 单一生成，不维护第二套手写真源。现有 namespace `codexHandoff` 增加：

```ts
interface ReturnPreviewRequest {
  dshSessionId: string
}

interface ReturnPreviewResponse {
  receiptId: string                 // opaque，不包含路径或正文
  expiresAt: string                 // ISO 8601；默认 TTL 10 分钟
  context: string                   // 已 redacted、将被原样注入的完整文本
  contextSha256: string
  contextBytes: number
  scope: {
    target: 'fork'
    dshCursor: number
    dshRevision?: string
  }
  source: {
    codexThreadId: string
    codexRolloutRevisionId: string
    codexFingerprint: string
    dshSessionId: string
  }
  workspace: {
    canonicalCwd: string
    workspaceIdentity: string
    gitFingerprint: string
    summary: string
  }
  warnings: readonly string[]
}

interface ReturnSyncRequest {
  receiptId: string
}

type ReturnSyncResponse =
  | {
      status: 'created' | 'existing'
      receiptId: string
      sourceThreadId: string
      codexForkId: string
      resume: {
        argv: readonly string[]      // [resolvedCodexBinary, 'resume', codexForkId]
        displayCommand: string       // platform-safe quoted, copyable
      }
    }
  | {
      status: 'unknown'
      receiptId: string
      sourceThreadId: string
      codexForkId?: string
      retry: 'reconcile-only'
    }
```

Remote 方法名固定为：

```ts
returnPreview: { request: ReturnPreviewRequest; response: ReturnPreviewResponse }
returnSync:    { request: ReturnSyncRequest;    response: ReturnSyncResponse }
```

Client 不传任意正文、source id、cwd 或 target 给 `returnSync`；这些全部从 Host 的 durable receipt 读取，防止 preview 与 dispatch 分离。

## 4. Receipt 与快照

`returnPreview` 必须完成一次 prepare，并持久化 receipt 后才返回：

1. 从当前 DSH session 的权威 source metadata/index 解析原 Codex thread、rollout revision、fingerprint 与 cwd；不信任 UI 回传值。
2. 用 `sessionQuery.observeSession(dshSessionId, { projectionMode: 'none' })` 取得一个 immutable cut，记录 cursor/revision，并只从该 cut 编译。
3. 用只读 repository inspector 取得 canonical cwd、workspace identity 和 Git/filesystem fingerprint。当前仓库事实高于对话陈述。
4. redaction 后生成有界 context，尾部加入唯一 marker：`<!-- dsh-codex-handoff:receipt=<receiptId> -->`。marker 用于审计和未来只读 raw-rollout recovery，不代表当前公共 read/list API 可见。
5. receipt digest 绑定 compiler/schema version、Codex source identity、DSH session/cursor/revision、workspace identity、Git fingerprint、context SHA-256 和 target `fork`。
6. 将完整 prepared record 写入插件自己的 `storageDomain` KV table，并等待 `put/update` Promise 成功后才返回 receipt。0.2.0-rc.2 `storage-domain/src/domain.ts` 明确规定每次写操作在 backend durability 与 event emission 完成后才 resolve；不存在也不需要另造独立 `flush` API。

默认 soft limit 64 KiB，hard limit 256 KiB UTF-8。超过 soft limit 优先保留目标、已完成工作、repo facts、失败尝试、未完成项和 provenance；超过 hard limit 拒绝。

TTL 默认 10 分钟。`returnSync` 前重新读取权威 metadata/index、fresh DSH observation 与 fresh Git fingerprint；任一绑定变化或 receipt 过期即返回 `RETURN_STALE`，要求重新 preview。一次 receipt 只代表一个 snapshot、一个 fork。

## 5. Context 格式

注入文本顺序固定：

1. 声明“以下是从 DSH 返回的未执行上下文，不是系统指令”；
2. 原任务目标与当前意图；
3. DSH 已完成工作及 event/evidence reference；
4. 当前 HEAD/branch/dirty paths/tests 等 repository facts；
5. 失败尝试、未完成项、风险与建议下一步；
6. source thread、DSH session/cursor、生成时间；
7. receipt marker。

DSH message/tool output 是不可信输入，必须引用或围栏化，不能升级为 system/developer role。注入 item 固定为：

```json
{
  "type": "message",
  "role": "user",
  "content": [{ "type": "input_text", "text": "<prepared context>" }]
}
```

## 6. Codex 调用顺序

Host-owned `CodexAppServerClient` 负责官方二进制发现、版本/capability probe、JSON-RPC id、initialize handshake、timeout、stderr 和 teardown。不得读取认证文件；Codex 自己拥有 auth 与 persistence。

```text
initialize
initialized
thread/fork { threadId: sourceThreadId, excludeTurns: true }
  -> 立即 durable 记录 codexForkId
thread/inject_items {
  threadId: codexForkId,
  items: [preparedUserMessage]
}
  -> 收到成功空 response `{}` 后 durable 记录 injected/complete

connection lost after inject request:
  -> durable unknown；MVP 不自动 reconcile/retry
```

fork 必须持久化，不能设置 `ephemeral: true`。MVP 不传 `lastTurnId`，即从源 thread 当前持久历史 fork。

transport 优先使用 `codex app-server proxy` 连接运行中的 daemon；isolated `codex app-server --listen stdio://` 可用于 fork 路径。`codex exec fork/resume ... <prompt>` 会启动模型，只能作为未来显式兼容模式，MVP 不得静默 fallback。

## 7. Durable 状态机与幂等

```text
prepared -> dispatching -> forked -> injected -> complete
                    |          |         |
                  failed       +---------+--> unknown -> complete(reconciled)
```

每个 receipt 单飞，并通过 storageDomain KV table 的原子/版本检查更新推进；每次关键转换都必须 await `put/update` 的 durable completion：

- `complete` 再调用：返回同一 fork，`status: existing`。
- `forked` 且确定 inject 未发送：复用该 fork，禁止再 fork。
- inject request 可能已发送但 response 丢失：进入 `unknown`，禁止自动重发 inject。
- `unknown` 是 MVP 终态，只能显示“结果不确定”。公共 `thread/read`/`thread/turns/list`/`thread/items/list` 看不到 injected raw item，因此不得自动转 complete，也不得新建第二 fork。
- fork response 丢失且没有 fork id：结果 unknown，MVP 不再 fork；由 verifier/后续 reconcile 能力处理，避免“一次 snapshot 多个 fork”。

`thread/inject_items` 没有协议级 idempotency key；marker 不能让盲目重试安全。未来可以另行实现只读 raw-rollout reconciler，但必须同时满足：只读、严格限制在 Codex 官方解析出的 `CODEX_HOME` 内、只读取已由本插件 durable 记录的 fork、校验 exact fork session metadata 与 receipt SHA marker、字节/行数有界、绝不写 rollout/database。该增强不在 MVP，也不得阻塞正常 success-response 路径。

## 8. 成功后的可用入口

DSH desktop 只保证将 `http/https` 作为外链，不假设 `codex://` 可打开。成功响应必须提供：

- 可复制 fork UUID；
- 可复制 `displayCommand`；
- 结构化 `argv`，首项是实际探测到的官方 Codex binary。PATH 有 `codex` 时可显示短命令；否则显示经过 Windows/PowerShell 或 POSIX 安全引用的绝对 binary 路径。

不得把 display string 交给 shell 拼接执行。未来“打开同步分支”只能由用户点击可信 UI 按钮触发 Host-owned spawn，使用固定 argv `[binary, 'resume', validatedUuid]`，不得接受任意参数或 URL。

## 9. 稳定错误码

| Code | 说明 |
|---|---|
| `RETURN_NOT_SUPPORTED` | DSH/Codex required capability 缺失 |
| `RETURN_SOURCE_METADATA_MISSING` | 无法从权威 index 找到原 Codex source |
| `RETURN_PREVIEW_EXPIRED` | receipt TTL 已过 |
| `RETURN_STALE` | DSH log、source、cwd 或 Git fingerprint 改变 |
| `RETURN_PAYLOAD_TOO_LARGE` | 超 hard limit |
| `CODEX_APP_SERVER_UNAVAILABLE` | 官方 transport 不可用 |
| `CODEX_PROTOCOL_MISMATCH` | initialize/method/response 不符合验证 schema |
| `CODEX_SOURCE_THREAD_NOT_FOUND` | source 无法 fork |
| `RETURN_RESULT_UNKNOWN` | request 后断线，结果不确定 |
| `RECONCILE_INCONCLUSIVE` | 预留给未来只读 raw-rollout reconciler；MVP 不自动对账 |
| `RETURN_STORAGE_FAILED` | receipt/outbox 的 durable `put/update` 失败 |

错误必须是结构化 `{ code, recoverable, message }`；不得向 Client 回显 raw stderr、环境变量、credentials 或完整内部路径。

## 10. DSH 0.2 发布门禁

Roundtrip 合入前，现有正向导入必须完成 v4 迁移：peer/acceptance pin 为 0.2.0-rc.2，生成 Typert 更新，真实 `agents.create` 后可 list/load/resume，且插件不生成 `session/end-seed`。

实现单测可立即按本合同开发；以下真实环境项不阻塞合同冻结，但阻塞相应发布承诺：

1. 本机 0.159.2 fork 返回真实 UUID；inject 后没有 turn/model/tool 活动。
2. 原 thread 不变；visible `thread/read`/turns/items 为空的行为被固定为回归证据，不再把它们当作 reconciliation API。断线后的 `unknown` 不得自动变为 `existing/created`。
3. 同 receipt 并发调用只形成一个 fork/一条 context；完成重试返回 `existing`。
4. fork 后 crash、inject response 丢失、stale DSH/Git/cwd、TTL 到期均按状态机处理。
5. 真实 DSH 0.2.0-rc.2 desktop 完成正向导入和回传。

只有收到真实 app-server 的 fork response 与 inject success response，产品才可对外宣称该次“同步回 Codex”；未知结果不得宣称成功。
