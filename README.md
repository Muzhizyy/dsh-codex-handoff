# dsh-codex-handoff

把 Codex 的可验证会话上下文带到 DeepSeek Harness（DSH）中继续工作。插件读取 Codex 会话和当前仓库，先展示发现结果与预览，再通过官方 DSH Agent API 创建普通、可恢复的会话；它不写入 Codex 源文件、不重放历史工具，也不直接写 DSH JSONL。

本项目目前是面向 DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`（`0.1.3-alpha.1`）的 developer-preview 插件。DSH 的公开 API 仍可能变化，安装前请保留可恢复的 DSH home 备份。

## 安装

优先使用已构建的 npm 包或 `.tgz`：

```sh
dsh plugin --profile web add dsh-codex-handoff
# 或：
dsh plugin --profile web add ./dsh-codex-handoff-0.1.0-alpha.1.tgz
```

安装后重启对应 Web profile。插件贡献一个 `dsh.bundle.patch` Host 层和一个 Web Client bundle；patch 只插入本插件行，基座的 session、Agent、storage、preset 和 Typert 组合仍由 DSH profile 负责。缺少必需服务时会 fail closed，不会偷偷替换基座。

从源码构建只建议用于开发：请 checkout 上述固定 SHA，使用 Node `^22.19.0 || >=24.0.0` 和仓库声明的 pnpm 版本，先构建 DSH 固定版本，再构建本项目。源码安装可能运行 `prepare` 或依赖构建脚本；请在 pnpm 的 `allowBuilds`/生命周期策略中明确批准所需依赖，并在隔离目录执行。发布 tarball 不要求不可信消费者运行源码构建。

## 使用

从侧边栏 footer 的 `Continue from Codex` 打开 overlay。插件会列出活动/归档会话，支持搜索、分页和预览；预览会显示来源 session、cwd、Git/文件诊断、大小和健康状态。选择已存在且确认的 cwd 后选择模式：

- Smart（默认）：确定性仓库事实优先；可选择使用当前 DSH 模型改善摘要，也可选择 deterministic/no-LLM。模型不可用时会显示 degraded 并回退，不伪造分析结果。
- Full：保存可安全表示的历史消息和已闭合的真实工具配对，不执行历史命令。大内容需要额外确认，超过硬限制会拒绝而不是静默切换模式。

创建成功只在 DSH Agent 已发布且刷新后的 session 列表确认包含新 id 后打开；workspace attach 失败会显示 `created_unattached` 警告并保留可重试状态。相同 source fingerprint、cwd、mode 和 compiler schema 的重试是幂等的；源发生变化要求重新预览。

## 隐私与安全

任何模式都需要显式同意。Full 会把可安全表示的历史持久化，并可能在以后用户显式提交 DSH turn 时发送给当前配置模型；Smart with model 会把有界、尽力脱敏的证据发送给当前模型，编译上下文同样会在以后显式 turn 到达模型；Smart deterministic/no-LLM 不调用模型，但持久化上下文仍可能在以后显式 turn 发送给当前模型。

脱敏是 best effort，不是保证。默认拒绝 `.env*`、`.ssh`、私钥、凭据/认证文件和 Codex auth 文件等敏感路径；预览和诊断限制大小，不渲染原始 HTML。若内容包含秘密，请在同意前自行检查；无法证明来源、指纹、cwd、Git 范围或 DSH 兼容性时插件会拒绝操作。

导入期间不会执行历史工具、approval 或命令；仓库检查使用受限的 argv-only Git 读取，禁用 pager、prompt、hooks、网络、external diff 和 textconv。Codex home 与源 rollout 以只读方式处理，并由测试验证导入前后哈希不变。

## 故障排查与限制

- 看不到入口：确认运行的是 Web profile，且 `sidebar.footer.action`/`shell.overlay` 与 locale、React、sessions 服务可用。
- 显示不兼容：确认 DSH 是固定 SHA 或兼容版本，并重启 profile；插件不支持猜测未来 API。
- `CWD_REQUIRED`/`CWD_NOT_FOUND`/`SOURCE_CHANGED`：选择实际存在的源 cwd，重新发现并预览，不要强行复用旧预览。
- `SESSION_NOT_VISIBLE`：刷新或重启 profile 后检查列表；插件不会因可见性失败重复创建。
- `created_unattached`：目标 session 已创建但 workspace attach 未确认，可在 DSH 中打开目标 session 后重新处理 workspace。
- 缺失、损坏、压缩超限或未闭合的 Codex 历史会以 partial/corrupt/unsupported 和诊断呈现；Full 不会把缺失部分猜成成功。
- DSH、Codex 和模型 provider 的版本、权限、凭据及服务配置不属于本插件控制范围；no-LLM 只表示创建路径不调用分析模型，并不保证未来 DSH turn 不发送持久化上下文。

卸载：

```sh
dsh plugin --profile web remove dsh-codex-handoff
```

卸载只移除插件 bundle 层，不删除已经创建的 DSH session、Codex 源文件、仓库文件或用户的 DSH home。若 profile 正在运行，请按 DSH 规则重启后确认插件行已消失。

## 开发与验证

```sh
pnpm install
pnpm typecheck:client
pnpm test:client
pnpm build:client
pnpm check:pack
pnpm test:pinned-dsh-client
```

完整 `pnpm check` 还会运行仓库各层测试、lint、Host build、打包和禁止导入检查。固定 DSH acceptance 会在临时 checkout 中使用官方 loader/Gateway/Agent API；它不是 JSONL 存在性测试。上游安装产生的 platform/deprecation 诊断应只归类为 upstream-only，不得掩盖本项目失败。

## English summary

`dsh-codex-handoff` is a developer-preview plugin for DeepSeek Harness commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`. It discovers Codex sessions read-only, previews repository facts, and creates a normal resumable DSH Agent session through the official typed API. Smart is deterministic-first and optionally uses the current model; Full preserves only safely representable history. Both require explicit consent. Redaction is best effort, historical tools are never replayed, and the plugin never writes Codex data or physical DSH JSONL. Install a prebuilt npm/tarball package when possible; source builds and lifecycle scripts require an isolated checkout and explicit pnpm build approval. See the Chinese sections above for install, privacy, troubleshooting, limitations, and uninstall details.
