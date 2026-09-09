> Historical design document / 历史设计材料。May describe planned or superseded behavior. For current behavior and checks, use the root README and `../VALIDATION.md`.

# dsh-codex-handoff 实施计划

> 本文件只规划实际实现；当前阶段不产生源代码、测试、配置或构建脚本。
> 所有 source/test/config/fix/refactor 必须由 **GPT-5.6 Luna X High** 完成。
> Research/architecture/interface review 由 **GPT-5.6 Sol High** 负责；最终独立验收由 **GPT-5.6 Sora Medium** 负责。

## 1. 执行原则

### 1.1 并发硬限制

任何时刻最多 **4 个总 agent 槽**，包括主协调 agent。因此常态为：

```text
1 × Sol High coordinator/reviewer
+ at most 3 × Luna X High implementers
= at most 4 total
```

不得为了赶进度启动第 4 个 Luna。Sora 验证时也计入总槽；若同时有 Sol + Sora，只能再有最多 2 个 Luna，且验收期间原则上不并行修改。

### 1.2 写权限原则

- 每个文件在一个波次中只有一个 owner。
- Agent 只写其 ownership glob；读全仓库是允许的。
- 发现跨域问题时写给 Sol 的 handoff，不顺手改别人的文件。
- shared contract 变更只能由 Foundation owner 执行；请求者提交 change proposal（字段、理由、兼容影响、所需测试）。
- root 配置/lockfile/patch 只有 Foundation/Packaging owner 在指定波次可改。
- 每个 workstream 自带单元测试；不能把测试全部推给最后一个 Agent。
- 实现完成必须提交：改动摘要、接口偏差、测试命令/结果、已知风险、所有文件清单。
- 不以“能编译”代替真实 DSH create/list/load/resume/tool-continuation 验证。

### 1.3 进入条件

任何 Luna 开工前：

1. 阅读 `RESEARCH.md`、`SPEC.md`、本计划和仓库内 `AGENTS.md`。
2. 确认目标模型是 GPT-5.6 Luna、reasoning effort 是 X High。
3. 运行只读 `git status`，记录已有用户改动；不得覆盖。
4. 明确自己的 ownership 与 forbidden scope。
5. 若真实依赖 API 与 SPEC 矛盾，停止该接口实现并报告证据；禁止猜 API 或回退 raw persistence。

## 2. Shared contracts freeze

Wave 0 的首要输出是浏览器安全、运行时可验证的公共契约。建议精确文件：

```text
src/shared/
  types.ts          # domain types and discriminated unions
  schemas.ts        # runtime schemas; type source of truth
  remote.ts         # codexHandoff Remote request/response DTOs
  ports.ts          # SessionSource/Inspector/Analyzer/Reconciler/Compiler/Gateway
  errors.ts         # stable error codes and sanitized error DTO
  limits.ts         # defaults/hard caps; pure constants
  index.ts          # public exports only
```

Contract freeze 必须包括：

- `ExternalSessionSummary`, `SessionPage`, `NormalizedSession/Event`；
- opaque `discoveryId`、stable logical thread id、rollout revision id、lineage 与 complete/partial/corrupt/unsupported；
- `RepositoryState`, claims/provenance, `AgentHandoffManifest`；
- `ImportIdentity/Record`, `CreateRequest/Outcome`, compatibility/preview DTO；
- ports 和 AbortSignal 语义；
- schemas 的 unknown-field policy、byte/text bounds；
- stable error code union；
- Host/Client type-only 边界。

冻结门：type-only compile tests、schema good/bad fixtures、browser bundle check（shared 不含 `node:*`/DSH Host/React）、Sol interface review PASS。

后续 contract change 流程：

```text
requesting Luna -> concise proposal to Sol -> Sol approves/rejects
-> Foundation owner alone edits shared + contract tests
-> impacted owners rebase/retest
```

## 3. Workstreams

### Luna F0 — Foundation / Shared Contract / Build Owner

**目标**：建立最小包骨架、冻结 shared runtime/type contracts，并一直作为根配置唯一 owner。

**永久 ownership**：

```text
package.json
pnpm-lock.yaml / npm lockfile（只保留一种，按 DSH 官方约定）
tsconfig*.json
vitest*.config.*
eslint/oxlint/coverage/build scripts configuration
src/shared/**
tests/shared/**
scripts/**
```

**Wave 0 tasks**：

- 建立 DSH-compatible TypeScript ESM 包骨架；Node engine 与目标 DSH 一致。
- 以 runtime schema 为单一真源实现 SPEC 的 shared types、Remote DTO、ports、errors、limits。
- 建立 unit/typecheck/lint/coverage 命令和目录约定。
- 添加静态 forbidden-import gate。
- 不实现业务逻辑或 UI。

**Wave 3 revisit tasks**：

- 在各模块 API 稳定后补齐 exports、client build entry、packed package contents、CI/gates。
- 仅按 Host/Client owners 的明确需求改根配置，不代写其实现。

**Forbidden**：`src/codex/**`, `src/repo/**`, `src/handoff/**`, `src/dsh/**`, `src/host/**`, `src/client/**` 和对应非 shared tests。

**Acceptance**：shared browser-safe；所有 schema/DTO roundtrip tests 通过；其他 agents 不需复制类型。

### Luna A — Codex Session Layer

**目标**：只读发现、索引、流式解析和规范化当前 Codex rollout。

**Ownership**：

```text
src/codex/**
tests/codex/**
tests/fixtures/codex/**
```

**Tasks**：

- Codex home resolution、active/archived roots、symlink containment。
- `CodexLogicalThreadResolver`：plain/`.jsonl.zst` representation、stable thread vs rollout revision、`thread/revert` head selection、recursive `history_base` ordinal cut across active/archive。
- opaque discovery-id inventory；每次 resolve/open 前后 realpath/stat/fingerprint TOCTOU guard。
- `session_index.jsonl` latest-title-wins 索引。
- recent-first discovery、cursor、bounded search、content fingerprint。
- streaming JSONL parser：first SessionMeta canonical；messages/reasoning summary/function/custom/local tool/compacted；unknown/malformed partial recovery。
- callId pairing；dangling/orphan diagnostics；encrypted content omission；limits/AbortSignal。
- recursion loop/depth/physical-file/decompressed-byte/record limits；complete/partial/corrupt/unsupported classification。
- synthetic/redacted fixtures，禁止复制真实本机对话。

**Consumes**：`src/shared` SessionSource/NormalizedSession/schemas/limits/errors。

**Exports**：`CodexSessionSource`, `CodexHomeResolver`, parser/normalizer public factory；不导出 raw Node streams 到 shared/Remote。

**Forbidden**：DSH packages、React、Git inspector、LLM、Remote、session creation、root config、其他 tests。

**Acceptance**：SPEC parser/discovery/resolver test matrix；plain/zst/revert/history-base golden fixtures；1 MiB+ line 不 OOM；单坏行仍可 preview；source hash before/after identical。

### Luna B — Repository State Layer

**目标**：确定性、只读、跨平台的 Git/filesystem observation。

**Ownership**：

```text
src/repo/**
tests/repo/**
tests/fixtures/repo/**
```

**Tasks**：

- cwd canonicalization/existence/platform path handling。
- argv-only Git process adapter；porcelain-v2 `-z` parser；branch/detached/HEAD/dirty/staged/unstaged/untracked/rename/recent commits。
- safe global options/env、literal `--` pathspec boundary、external-diff/textconv/credentials/locks disabled where applicable。
- relevant path lstat/stat；repo containment、symlink/junction、sensitive path deny。
- timeout/output cap/cancel/no-pager/no-prompt/no-network/hook safety。
- disposable Git repos for tests。

**Consumes**：`RepositoryInspector`, `RepositoryState`, diagnostics/limits/errors。

**Exports**：`GitRepositoryInspector` behind shared port；test fake process adapter。

**Forbidden**：conversation parser、LLM/reconciliation、DSH/session、UI/Remote、root config。

**Acceptance**：normal/dirty/clean/detached/non-Git/missing/path-injection/unicode/timeout tests；process spy proves only allowlisted commands and zero mutation。

### Luna C — DSH Session Gateway

**目标**：证明并实现当前 DSH v2 的正确 seed/create/idempotency/workspace/resume 路径。

**Ownership**：

```text
src/dsh/**
tests/dsh/**
tests/fixtures/dsh/**
```

**Tasks, ordered**：

1. **Integration spike first**：在真实 packed/checkout DSH `0.1.3-alpha.1` 上，用最小 balanced seed 调 `ctx.agents.create`，验证逐类型 v2 event、deriveMessages、list/inspect/persist/unload/resume。Spike 固化 golden sequence；FAIL 时立即报告，禁止写 raw persistence fallback。
2. Full normalized timeline → valid balanced DSH seed；精确 1-based turn/step、contiguous seq/time、deterministic message/call ids、`surfaceOp`/`sourceEventSeqs`、model source、assistant stream、tool log/result、exact-only finish/usage；real pairs only、dangling textual degradation。
3. Smart compiled context → balanced seed；不自动 drive Agent。
4. 确认 imported replay 不是 DSH fork：不得设置 `isSeeded`/`parentSession`/`inheritedEventCount`；不得供应 constructor-owned `session/end-seed` 或伪造 `request/header`。
5. Source metadata baseline 用 recognized plugin-source notice/kickoff；custom ignorable audit event 默认关闭，仅在真实 unknown-reader/resume spike 通过后可选启用。
6. 复用官方 Session Controller：`agentDefaultModel.currentSelection()`；`agentPresets.resolve` + setup 中 `agentPresets.mount`。
7. Deterministic import identity；typed storage-domain whole-record saga；per-key single-flight；pre/post fingerprint；各 crash point/orphan recovery；DSH query adoption guard。
8. Workspace resolve/create/attach；attach failure partial success。
9. compatibility probe and stable error mapping。

**Consumes**：shared types/ports；DSH Host public packages only。

**Exports**：`DshSessionGateway` implementation、`FullTrajectorySeedCompiler`、`SmartSeedCompiler`、compatibility view。

**Forbidden**：direct physical JSONL/zstd、`sessionPersistence.create/append` for imports、Codex parser、Git、LLM analysis、Client/React、root config。

**Acceptance**：no forbidden persistence imports/calls；real v2 golden seed/deriveMessages；historical dispatch spy stays zero；create/list/load/resume；workspace attach；same-key concurrency/idempotency/crash saga；normal tool only after explicit new input。

### Luna D — Smart Handoff Engine

**目标**：从 NormalizedSession + RepositoryState 构建可信、可预算的 manifest/kickoff。

**Ownership**：

```text
src/handoff/**
tests/handoff/**
tests/fixtures/handoff/**
```

**Tasks**：

- evidence selection/redaction and transcript-as-untrusted framing。
- pure deterministic extractor。
- injected DSH one-shot analyzer port explicitly using `agentDefaultModel.currentSelection()` + `ctx.llm.stream`/BlockAssembler；no tools；schema validation；failure fallback and deterministic/no-LLM mode。
- claim representation、formal reconciliation、superseded/historical handling、provenance closure。
- strict `AgentHandoffManifest` builder/validator。
- 4k–8k UI target / hard range budget compiler；priority tiers、atomic items、omission counts、fallback estimator。
- normative Markdown kickoff renderer。

**Consumes**：only shared contracts plus an injected LLM adapter port; no concrete parser/repo imports required in core algorithms。

**Exports**：analyzer/reconciler/compiler implementations behind shared ports。

**Forbidden**：direct filesystem/Git, Codex home, DSH Agent/session/workspace, React/Remote, root config。Only the thin DSH LLM adapter MAY import `@deepseek-ai/dsh-llm` and remains under this owner。

**Acceptance**：all required conflict tests；repo fields cannot be model-written；invalid/refusal/timeout/max-token fallback；prompt injection; manifest strict schema/provenance; deterministic output; budget invariants。

### Luna E — Client UI

**目标**：官方 slots 上的完整 session browser/preview/mode/Smart preview 流程。

**Ownership**：

```text
src/client/**
tests/client/**
tests/fixtures/client/**
```

**Tasks**：

- browser package `apply`/inject；`sidebar.footer.action` + `shell.overlay`。
- typed `ctx.remote.codexHandoff` client；discovery/search cursor/cancel/debounce。
- preview、cwd validation UI、Smart default、Full estimate/warning/confirm、Smart optional preview。
- mode-specific privacy disclosure/explicit consent；Smart model toggle and deterministic/no-LLM option；state changes invalidate prior consent；copy says redaction is best-effort。
- render the SPEC UI capability matrix and fail closed only on required missing seams。
- finite state machine, double-submit prevention, retry/cancel, created_unattached warning。
- `await ctx.sessions.refresh()` then membership check and `ctx.sessions.open(id)`。
- zh/en locale parity、a11y、safe text rendering、responsive states。

**Consumes**：browser-safe shared Remote DTOs/errors only；DSH Client slots/remote/sessions/locale/React。

**Exports**：Client apply/bundle entry and UI components private to Client package。

**Forbidden**：`node:*`、Host DSH packages、parser/repo/handoff/dsh implementation、direct fetch/custom route、DOM/router patch、root config。

**Acceptance**：all SPEC UI states/component tests；official slot registrations；no hardcoded copy；no Host import in bundle；successful refresh/open and retry behaviors。

### Luna F — Host Orchestration / Remote / Plugin Composition

**目标**：把已完成 ports 组合为安全的 typed Remote 和静态 DSH Host bundle。

**Ownership**：

```text
src/host/**
src/index.ts
tests/host/**
tests/integration/**
tests/fixtures/integration/**
```

**Tasks**：

- `TypertRemoteService` namespace `codexHandoff`：compatibility/discover/preview/analyze/create。
- runtime validate → orchestrate → sanitize error；opaque discovery resolution；realpath/stat and pre-read/post-read/pre-create fingerprint TOCTOU guards。
- Wire `CodexSessionSource`, repository inspector, analyzer/reconciler/compiler, DSH gateway。
- concurrency/cancellation/request caps；per-key single-flight；durable saga transitions and startup orphan recovery。
- Host Cordis apply/inject/services lifecycle；hold AgentHandles without leaking。
- integration tests across boundaries and security instrumentation。

**Consumes**：all stable port implementations；does not reach private internal functions。

**Exports**：Host plugin entry and Remote service only。

**Forbidden**：business algorithms in orchestration、Client UI、shared contract edits、root package/build/lockfile、physical persistence。

**Acceptance**：typed Remote roundtrip；invalid requests/refusal；TOCTOU；degraded analyzer；idempotent create；source/repo non-mutation；real DSH integration suite passes。

### Luna G — Packaging / E2E / Acceptance Harness

**目标**：形成可安装包和端到端证据；不重写功能代码。

**Ownership during its exclusive wave**：

```text
cordis.patch.yml
README.md
CHANGELOG.md (if present)
docs/compatibility.md (if chosen)
tests/e2e/**
tests/fixtures/e2e/**
VERIFICATION_REPORT.md (initial automated evidence only)
```

Root package/build exports remain F0 owner；G 提交需求，由 F0 在同一波次串行调整 `package.json`/scripts/lockfile，二者不能同时写 root files。

**Tasks**：

- official nested `dsh.bundle.patch`, `dsh.client`, `exports['./client']`, Host/client prebuilt outputs and packed artifact smoke。
- install/uninstall/profile-web instructions and compatibility matrix。
- npm/prebuilt install with lifecycle scripts disabled where possible；Git/path `prepare` + pnpm allow-build/script execution risk explicitly documented/tested。
- disposable real Git demo fixture；real DSH Web UI E2E where practical。
- source/repo mutation hashes；no historical dispatch spy；restart/resume/normal tool continuation。
- performance/large session/Windows paths/prompt-injection smoke。
- collect exact commands/results into draft verification report；不宣布独立 Sora PASS。

**Forbidden**：changing feature implementation to make tests pass；must report failure to owning workstream. No shared/feature source edits。

**Acceptance**：packed install loads Host+Client；core demo works；all gates green；README does not overclaim unsupported API/modes。

## 4. Dependency waves

### Wave 0 — Contract and skeleton (1 Luna)

| Slot | Agent | Dependency | Exit gate |
|---|---|---|---|
| 1 | Sol coordinator | research/spec complete | reviews contract |
| 2 | F0 Foundation | none | shared/contracts/config PASS |
| 3–4 | idle | — | preserve limit |

Sol freezes contract after schema/type/browser-safety review. No other Luna starts before this gate.

### Wave 1 — Independent platform layers (3 Luna parallel)

| Luna slot | Workstream | Depends on | Writes |
|---|---|---|---|
| A | Codex Session Layer | F0 | `src/codex`, `tests/codex`, its fixtures |
| B | Repository State Layer | F0 | `src/repo`, `tests/repo`, its fixtures |
| C | DSH Session Gateway | F0 | `src/dsh`, `tests/dsh`, its fixtures |

Total slots = Sol + A + B + C = 4. C runs the real DSH spike early; if it fails, Sol revises architecture before downstream integration. A/B/C do not edit common config or shared.

Wave 1 exit gate：each unit suite green；C real create/list/load/resume spike green；Sol reviews normalized/repo/gateway outputs against frozen contracts。

Mandatory Wave 1 golden fixtures/gates：

- A：plain-only、zst-only、plain↔zst transition、normal thread、multi-revert stable thread、history base in active/archive/zst、multi-level cut、missing base、cycle、depth/files/decompressed-bytes/ordinal overflow、corrupt/unsupported。
- B：dash-prefixed/unicode/space path, malicious Git config/env, external diff/textconv/credential prompt attempt, symlink/junction escape。
- C：user-only Smart kickoff；assistant text；assistant + exact paired tool；dangling call downgrade；multiple turns/steps；model source；empty imported stream；exact-only usage/finish；surface markers；constructor end-seed；non-fork metadata。Golden must be validated by the real supported DSH build, not only local types。

### Wave 2 — Intelligence and UX (2 Luna parallel; one spare)

| Luna slot | Workstream | Depends on | Writes |
|---|---|---|---|
| D | Smart Handoff Engine | A + B + F0 contracts | `src/handoff`, `tests/handoff` |
| E | Client UI | F0 Remote contract; C create outcome semantics | `src/client`, `tests/client` |
| spare | reserved for F0 approved contract amendment only | Sol-approved need | shared/root only |

Do not automatically fill the spare slot. If a contract amendment is needed, pause affected D/E, let F0 make and test the change, then resume consumers.

Wave 2 exit gate：manifest/reconciliation/budget/security tests green；UI all states/a11y/official slots green；Sol checks Smart never substitutes LLM guesses for repo facts。

### Wave 3 — Host integration (1 Luna; F0 serialized revisit)

1. F0 alone first finalizes exports/type paths required by completed modules, then stops writing.
2. F executes Host orchestration/Remote/integration.
3. If F needs config changes, F does not edit root; it sends proposal, pauses, F0 performs change, then F resumes.

At most Sol + F + optional inactive/brief F0 handoff; F and F0 MUST NOT write concurrently.

Wave 3 exit gate：full typed flow discover→preview→analyze/create→list/open；idempotency/security/TOCTOU；real DSH integration all green。Sol performs architecture/import-direction/test-gap review。

### Wave 4 — Packaging and E2E (1 Luna; F0 serialized)

G owns packaging patch/docs/E2E and coordinates serial root package edits with F0. Feature owners remain idle unless a failure is assigned back. No “test fixer” may patch arbitrary source.

Exit gate：packed install, UI smoke, Full non-replay, Smart real repo continuation, restart/resume, all quality gates, draft verification evidence。

### Wave 5 — Sol integration review and Luna fixes

Sol only reads/reviews and produces a defect list categorized by owner：A parser、B repo、C DSH、D Smart、E UI、F Host、F0 config、G E2E/docs。

Fixes are dispatched to original owners, up to 3 Luna concurrently only when their files are disjoint. Any shared/root change remains F0-only. Every fix includes a regression test in the owner’s test directory. Repeat full gates after merge.

### Wave 6 — Independent Sora Medium verification

Start a fresh GPT-5.6 Sora Medium verifier only after all automated gates pass. It reads SPEC and independently tests installation, discovery, UI, Full, Smart, actual continuation, safety and regression. It writes/finalizes `VERIFICATION_REPORT.md` with PASS/FAIL and evidence.

If FAIL：

```text
Sora failure evidence -> Sol root-cause / owner assignment
-> Luna X High owner fixes + regression test
-> full gates
-> fresh/continued independent Sora re-verification
```

Sol and Sora never edit source/tests/config. Completion requires final Sora PASS.

## 5. Integration order and checkpoints

### Checkpoint C0 — contract

- Runtime schemas and TypeScript types equivalent。
- Remote contract serializable and bounded。
- No Node imports in browser-safe shared。
- Stable errors/limits agreed。

### Checkpoint C1 — platform seams

- A produces a logical thread (not raw file) across active/archive/plain/zst/revert/history-base without DSH assumptions。
- B produces deterministic repo state without conversation assumptions。
- C proves exact DSH v2 event mapping, non-fork seed semantics, public API path and inert history on the real supported build。
- No physical persistence writer exists。

### Checkpoint C2 — product semantics

- D consumes only contracts and produces schema-valid manifest/kickoff。
- E completes official-slot flow against typed fake Remote。
- Conflict/budget/prompt-injection/UI-state suites pass。

### Checkpoint C3 — host integration

- F revalidates all Client requests and source fingerprint。
- Cancellation propagates through scan/Git/LLM/create boundaries where supported。
- Same key single-flights/serializes/adopts；pre/post fingerprints match；every durable-saga crash point recovers；different rollout revisions remain immutable。
- Workspace partial failure returns usable session。

### Checkpoint C4 — real acceptance

- Packed plugin install, not source-only dev mode。
- Normal session list/open/restart/resume。
- Historical dispatch count zero。
- New explicit user turn invokes normal DSH tool and changes only disposable target repo。
- Codex source hashes unchanged。
- Mode-specific consent is observed；deterministic Smart records zero LLM analyzer calls；enhanced Smart uses the exact default-model selection。
- Packed manifest has nested bundle/client declarations and a resolvable prebuilt `./client`; npm-style install does not depend on an undisclosed lifecycle build。

## 6. Cross-workstream contract tests

The following tests are owned by F under `tests/integration`, but failures return to the producing owner：

1. A `NormalizedSession` validates shared schema and can be consumed by C Full compiler。
1a. A resolves `.jsonl.zst`, revert heads and recursive history-base cuts to one stable thread/revision identity; opaque discovery handles cannot be forged or reused after inventory/realpath/fingerprint change。
2. A+B outputs feed D and yield provenance-closed manifest。
3. D compiled context feeds C Smart seed and passes DSH seed validation。
4. F Remote outputs decode with the exact Client E schemas。
5. E create retry uses same expected fingerprint/import key and C returns existing。
6. Workspace attach failure reaches E warning without losing/opening wrong session。
7. Unsupported DSH probe disables E Create without raw fallback。
8. C v2 seed golden roundtrips each event type through derive/persist/resume and omits fork-only fields/end-seed/request-header inventions。
9. Concurrent same-key F requests create at most one DSH destination；process restart at each saga boundary adopts/retries/orphans correctly。
10. E consent matrix distinguishes Full, Smart-model and Smart-deterministic；changing mode/revision/cwd/model option invalidates consent。
11. Packed artifact resolves nested `dsh.bundle.patch`, `dsh.client`, `./client` and prebuilt Host entry with install scripts disabled。

Golden fixtures must be schema-level and small; avoid snapshots containing timestamps, absolute home paths or secret-like raw output.

## 7. Required Luna handoff template

Every implementation/fix agent returns：

```md
## Outcome
Implemented / blocked, and why.

## Files changed
Exact paths, all within ownership.

## Contracts implemented
Shared interfaces consumed/exported; any approved deviation.

## Verification
Commands and pass/fail counts; real DSH or mock explicitly distinguished.

## Security/invariants
Read-only/no-replay/limits relevant to this stream.

## Risks or follow-ups
Concrete, owner-routed items only.
```

A blocked agent must include primary-source/API evidence. “API probably exists” or README-only assumption is not acceptable.

## 8. Luna task prompts (dispatch-ready)

Each prompt must additionally specify `model=GPT-5.6 Luna`, `reasoning=X High`, workspace path and current commit. The coordinator can paste the appropriate block below.

### F0 prompt

> Implement only Foundation/shared/contracts/build ownership defined in IMPLEMENTATION_PLAN.md. Read RESEARCH.md and SPEC.md fully. Do not implement product modules. Make runtime schemas the type source, keep shared browser-safe, establish gates, and report every changed file/test. No other agent may edit shared/root configuration.

### A prompt

> Implement only Luna A Codex Session Layer ownership. Use current official OpenAI Codex types cited in RESEARCH.md; source is read-only. Build CodexLogicalThreadResolver for plain/zst, stable thread vs revert revision, recursive history_base ordinal cuts across active/archive with loop/depth/file/decompressed-byte bounds. First SessionMeta is canonical, discovery ids are opaque, every open rechecks realpath/fingerprint, parser is streaming/tolerant/bounded, and fixtures contain no real local transcripts. Do not import DSH/React or edit shared/config. Run the full parser/discovery/resolver matrix.

### B prompt

> Implement only Luna B Repository State Layer ownership. Git/filesystem inspection must be deterministic and read-only, argv-only, bounded/cancellable and safe across Windows/POSIX. Do not analyze conversation, invoke LLM, create sessions or edit shared/config. Prove the allowlist and zero mutation in tests.

### C prompt

> Implement only Luna C DSH Session Gateway ownership. First freeze a real DSH 0.1.3-alpha.1 golden seed proving exact v2 turn/step/seq/message IDs/surfaceOp/model source/assistant stream/tool log-result/finish-usage policies, deriveMessages, list/load/resume and inert history. Imported replay is not a fork: omit isSeeded/parent/inheritedEventCount and constructor end-seed. Never write physical session files or call sessionPersistence create/append as fallback. Use agentDefaultModel plus agentPresets.resolve/mount, whole-record durable saga, per-key single-flight, pre/post fingerprints, crash/orphan recovery, workspace partial success and real tests. Custom audit event stays off unless its unknown-reader/resume spike passes.

### D prompt

> Implement only Luna D Smart Handoff Engine ownership. Treat LLM output as schema-validated candidate claims; deterministic repo facts and formal truth hierarchy win. No direct filesystem/Git/session/UI access. Implement fallback, provenance closure, prompt-injection defenses and atomic token budgeting with required-fact refusal tests.

### E prompt

> Implement only Luna E Client UI ownership using the SPEC capability matrix, official sidebar.footer.action and shell.overlay, typed Remote, locale and ctx.sessions.refresh/open. Add explicit mode-specific privacy consent, best-effort redaction disclosure, Smart current-model toggle and deterministic/no-LLM option; invalidate consent on relevant changes. No node imports, direct fetch, router/DOM patch or Host implementation imports. Cover every loading/error/missing-cwd/large/degraded/a11y state and prevent duplicate create.

### F prompt

> Implement only Luna F Host Orchestration/Remote ownership after A–E gates pass. Compose ports; do not place parser/reconciliation/seed business logic in the controller. Revalidate all input/fingerprint/cwd, propagate cancellation, sanitize failures, serialize same-key create, and add cross-boundary integration tests. Do not edit shared/root/Client or raw persistence.

### G prompt

> Implement only Luna G packaging/E2E/docs ownership. Build a real prebuilt packed DSH plugin with nested dsh.bundle.patch, dsh.client and ./client export, and a disposable-repo acceptance harness. Test npm-style install without hidden lifecycle builds; document Git/path prepare and allow-build/script risk. Do not patch feature source when a test fails; report it to the owner. Prove Codex source unchanged, inspector/no-history replay, consent/no-LLM, UI flow, restart/resume and normal post-submit tool continuation. Coordinate root config changes serially through F0.

## 9. Final release gates

Release candidate is eligible for Sora only when all are YES：

- contracts frozen and import graph gate passes；
- unit/component/integration/E2E/coverage/typecheck/lint/build pass；
- packed plugin installs on supported DSH baseline；
- no `version: 0` import writer and no direct physical persistence writes；
- current Codex fixture and unknown/malformed/huge variants behave as specified；
- plain/zst/revert/history-base logical-thread resolver and recursion/cut limits pass；
- Smart conflict, provenance, budget and degraded paths pass；
- privacy consent matrix passes；deterministic Smart invokes no analyzer LLM；enhanced Smart uses `agentDefaultModel`；
- Full historical tools never replay；
- exact DSH v2 golden seed passes and imported replay never sets fork-only metadata；
- per-key single-flight, before/after fingerprint, durable saga and crash/orphan recovery pass；
- exact cwd/workspace/list/open/restart/resume/new tool continuation pass；
- security mutation hashes, sensitive deny and prompt-injection tests pass；
- README/compatibility accurately state developer-preview limits；
- packed manifest/export/patch/client prebuilt and install-script risk gates pass；
- Sol review has no unresolved P0/P1 or spec-gap；
- final independent Sora Medium says PASS。

This sequence intentionally leaves architecture decisions ahead of implementation, provides three-way parallelism where domains are independent, and serializes every high-conflict boundary (shared contracts, root config, Host composition and final acceptance).
