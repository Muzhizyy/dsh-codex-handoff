# dsh-codex-handoff

把可验证的 Codex 会话上下文带到 DeepSeek Harness（DSH）继续工作，并可显式把某个已导入 DSH 会话的最新上下文回传到新的 Codex fork。当前兼容目标仅为官方 DSH `dsh-v0.2.0-rc.2`（`639ed015397290b3745d163aafe02ffee4aa3f84`，Session Format v4）；未在此版本验证的 DSH 版本不承诺兼容。原始研究基线见[历史研究报告](./RESEARCH.md)，DSH 0.2 回传增量以[实现合同](./docs/2026-10-roundtrip-spec.md)和[实施计划](./docs/2026-10-roundtrip-plan.md)为准。

## 安装到官方 Desktop

本仓库不声称该插件已发布到 npm。使用此版本构建出的确切预构建 tarball：

```powershell
pnpm run build
pnpm pack --pack-destination artifacts
# 产物：artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz
```

先启动 DeepSeek Harness Desktop 一次以初始化其 Desktop profile，再完全退出应用。随后从仓库目录运行其附带的 `dsh` 命令，把刚生成的 tarball 安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add .\artifacts\dsh-codex-handoff-0.2.0-rc.2.tgz
```

重新启动 Desktop 后使用插件。更新同一 tarball 时也先完全退出 Desktop，再执行 `dsh plugin --profile desktop add <确切的本地 .tgz 路径>`；检查可用 `dsh plugin --profile desktop list`。卸载同样要先退出 Desktop：

```powershell
dsh plugin --profile desktop remove dsh-codex-handoff
```

不要改用 `pnpm add dsh-codex-handoff`、`npm install dsh-codex-handoff` 或未经验证的普通 CLI profile。tarball 由官方 Typert 生成物、Host 与 Client 构建结果组成；安装时不需要在消费者机器上从源码运行 lifecycle scripts。

## 从 Codex 导入到 DSH

从侧边栏 footer 的 `Continue from Codex` 打开导入界面。它以只读方式发现 Codex 会话并展示来源、工作目录、Git/文件诊断、大小和健康状态。选择有效 cwd 与导入模式：

- **Smart（默认）**：确定性仓库事实优先；可选择用当前 DSH 模型增强摘要，也可选择 deterministic/no-LLM。模型不可用时明确降级，不伪造分析结果。
- **Full**：保存可安全表示的历史消息和已闭合的真实工具配对；不执行历史命令。大内容需额外确认，超过硬限制会拒绝。

导入只经官方 DSH Agent API 创建可持久化 session，不写 Codex 源文件或物理 DSH JSONL。历史 tool 记录不会被重放。源变更要求重新预览；workspace attach 失败会显示 `created_unattached`，并保留可重试状态。

## 从 DSH 回传到 Codex

回传只对插件权威索引中可链接到原 Codex source 的已导入 DSH session 提供，不接受任意会话、source id 或 Client 正文。`returnPreview` 从一个 DSH v4 observation cut 和权威 source/workspace 信息编译完整、脱敏上下文；用户确认后，`returnSync` 只创建持久化 Codex **fork**，并把上下文作为 user-role Responses item 注入该 fork。

在当前已导入的 DSH 会话 header 中选择回传，检查预览中的目标、仓库事实、准备注入的正文和警告，再明确确认。成功后复制界面提供的 `resume` 命令，自行在 Codex 打开新 fork。预览只汇集原始目标、最近用户意图、当前仓库事实及有界的近期 DSH 活动与失败摘录；超出事件或总上下文限制的内容会给出截断/省略警告。它不是完整 DSH transcript，也没有无限的记忆或上下文容量。

回传需要可可靠核验的 Git workspace。非 Git 目录、无法安全读取的 Git 状态，以及有敏感变更路径（例如 `.env*` 或密钥文件）的工作区会拒绝回传；处理这些情况后须重新预览。预览与确认之间的 DSH 会话、Codex 来源或 Git 状态变化也要求重新预览。

Codex app-server 版本筛选只放行精确的 CLI 预发布版 `0.159.0-alpha.12.1`（当前 Desktop 安装版）和正式版 `0.159.2` 起；其他 alpha、beta 及正式版 `0.159.0`/`0.159.1` 不在范围内。放行版本仍须通过实际 JSON schema 的 fork/inject 方法检查、`CODEX_HOME` 一致性检查及 fork 来源检查。当前 alpha 已通过安装版 DSH 的隔离完整回传实测；未来正式版符合版本筛选不等于已经完成实测。历史失败复测与新实测均见[独立验证报告](./docs/2026-10-verification.md)。

- 原 Codex source thread 不变；不会向它注入内容。
- 回传不调用 LLM、不启动 Codex turn、不执行工具。
- 共七个 typed RPC：`compatibility`、`discover`、`preview`、`analyze`、`create`、`returnPreview`、`returnSync`。
- 不假装自动打开 fork：成功态提供可复制的 fork ID 和 `resume` 命令，是否打开由用户决定。
- 若 fork/inject 的结果因断线而无法确认，界面必须显示“结果不确定”；不会盲目重试、再 fork 或把 unknown 显示为成功。

详见[回传实现合同](./docs/2026-10-roundtrip-spec.md)与[实施计划](./docs/2026-10-roundtrip-plan.md)。本能力不是双向实时同步，也不改写 Codex rollout、数据库或凭据。

## 隐私与安全

两个方向均需显式用户操作。脱敏是 best effort，不是保证；预览内容在继续前应由用户检查。默认拒绝 `.env*`、`.ssh`、私钥、凭据/认证文件和 Codex auth 文件等敏感路径，不读取 Codex credentials。仓库检查使用受限的 argv-only Git 只读调用，禁用 pager、prompt、hooks、网络、external diff 和 textconv。

导入的 Smart/model 路径会把有界证据发送给当前 DSH 模型；Full 与 Smart deterministic/no-LLM 的创建路径不调用分析模型。回传路径始终 no-LLM，但注入 DSH 历史的内容以后仍可能在用户显式启动 Codex turn 时进入模型上下文。插件不直接写 Codex rollout、数据库、认证材料或 DSH JSONL。

## 故障排查与兼容范围

- 找不到 Desktop profile：启动 Desktop 一次完成初始化，完全退出后再用 `dsh plugin --profile desktop ...` 管理。
- 显示不兼容：确认安装的确切 tarball 是本次构建产物，并使用已验证的 DSH `0.2.0-rc.2` Desktop；本项目不推测未来 API 兼容性。
- `CWD_REQUIRED` / `CWD_NOT_FOUND` / `SOURCE_CHANGED`：重新发现并预览；不要复用过期事实。
- `created_unattached`：DSH session 已创建，但 workspace attach 未确认；查看警告后在 DSH 中处理。
- 回传显示 unknown：检查 Codex fork 列表/状态并谨慎人工处理；本 MVP 不自动对账或重发注入。
- 历史缺失、损坏、压缩超限或未闭合记录会以 partial/corrupt/unsupported 和诊断呈现；插件不会把未知状态伪报为成功。

## 开发与验证

这个交付目录最初没有 `.git` 历史；`dff7d29` 是 2026-10-02 保存的改动前代码基线快照，并非原始开发历史的重建。`204ef19`、`cae6cd5` 与当前功能里程碑 `ed127e1` 分别记录随后实际完成的合同、DSH v4 迁移及回传功能增量。提交日期反映实际记录时间，没有伪造早期历史日期，也没有向远端推送；后续文档修订以工作区状态为准。

```sh
pnpm install
pnpm typecheck:client
pnpm test:client
pnpm build:client
pnpm check:pack
pnpm test:pinned-dsh-client
pnpm test:pinned-dsh
```

`pnpm test:pinned-dsh` 使用精确上游 checkout 的公开 Agent/Session API 验证真实 `agents.create()`、v4 SessionQuery observation、持久化 list、resume 和显式续跑；不代表已安装 Desktop 的 profile 插件管理测试。后者可在 Windows 隔离 home 中运行：先创建 `.desktop-test` 下的空目录，将它设为 `DSH_TEST_HOME`，再运行 `pnpm test:installed-desktop`。验收脚本通过安装版 app.asar 的 `@deepseek-ai/dsh-app-boot.initProfile()`（与 Desktop profile bootstrap 使用同一官方初始化导出）创建默认 profile，不启动 Electron GUI；随后以 `ELECTRON_RUN_AS_NODE` 调用已安装 CLI 做本地 tarball add/list/remove。脚本拒绝默认 `~/.dsh`，且不会自动清理测试 home。可用 `--initialize-profile-only` 单独验证隔离初始化。完整 `pnpm check` 运行 Host build、全部测试、lint、打包和禁止导入检查。

已完成的实际验收见[独立验证报告](./docs/2026-10-verification.md)：安装版 Desktop CLI 的隔离 add/list/remove，以及通过安装版 DSH runtime 服务 API 和官方 Codex API 完成的隔离回传已通过。当前 Codex CLI `0.159.0-alpha.12.1` 的复测也已通过，验证了派生 fork 的上下文持久化、源文件不变、空闲且零 Codex turns、存储关闭重开后的恢复，以及重复同步返回 `existing` 和预览复用。此前该版本被旧版本筛选拒绝的失败复测保留为历史记录。Electron 窗口中的按钮点击与 overlay 流程未运行，CLI/API 结果不构成完整 GUI 验收。

本次官方 Typert 源码编译、确定性生成、打包及安装版 Desktop CLI add/list/remove 的实测命令与结果记录在[打包验收记录](./docs/2026-10-packaging-verification.md)。

如果 `dsh` 不在 `PATH`，也可在 PowerShell 直接调用随 Desktop 安装的 CLI（先确保 profile 已由 Desktop 初始化并完全退出）：

```powershell
$archive = (Resolve-Path .\artifacts\dsh-codex-handoff-0.2.0-rc.2.tgz).Path
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add $archive
```

这与脚本相同，使用 `plugin --profile desktop` 参数顺序；它不是 `dsh --profile desktop plugin ...`。

## English summary

This build targets only official DeepSeek Harness `dsh-v0.2.0-rc.2` / commit `639ed015397290b3745d163aafe02ffee4aa3f84` (Session Format v4). Install the exact locally built `artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz` into the initialized Desktop profile with `dsh plugin --profile desktop add <archive>`; this package is not claimed to be published on npm. When `dsh` is not on `PATH`, the installed PowerShell fallback is `& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <absolute-tgz>`. The plugin provides Codex-to-DSH import and an explicit, fork-only return for linked/imported DSH sessions. The Codex app-server version filter allows exactly the current Desktop CLI prerelease `0.159.0-alpha.12.1` and stable `0.159.2+`; other prereleases are unsupported. Eligibility also requires live schema, home, and fork checks, and does not imply that every future stable release has been tested. The current alpha passed an isolated full return flow through installed DSH and official Codex APIs. Return leaves the source Codex thread unchanged, invokes no model, does not auto-open the fork, and reports uncertain outcomes as unknown without retrying. See the [incremental SPEC](./docs/2026-10-roundtrip-spec.md) and [implementation plan](./docs/2026-10-roundtrip-plan.md). The [verification report](./docs/2026-10-verification.md) separates the historical successful run, later failed retest, and current alpha pass; the Electron window click flow was not run. The original [research report](./RESEARCH.md) is historical and its earlier DSH pin is superseded.
