# Validation / 验证记录

Date: 2026-09-10 (Asia/Shanghai). Source snapshot prepared on Linux/WSL. JavaScript checks used Node 24.15.0; DSH used pnpm 11.7.0.
日期：2026-09-10，Asia/Shanghai。本次验证在 Linux/WSL 环境完成。

## Executed checks / 实际执行

- `pnpm install --frozen-lockfile`: passed.
- `pnpm check`: passed; 19 test files, 185 tests (including 34 client tests).
- Client and host type checks, lint, forbidden-import boundaries, builds: passed.
- Tarball extraction, isolated ignore-scripts installation, Host/Client/Remote/Typert module loading: passed.
- Bilingual documentation gate: passed.

整理后通过 185 个测试、类型检查、lint、构建、禁止导入边界检查，以及打包后的独立安装和模块加载验证。

Changes include bilingual source-build instructions, clean source layout, preserved required Typert descriptors, and a UI regression test that waits for rendering and opens the collapsed details before asserting repository facts.
主要调整：完整双语说明、源码布局、保留构建必需的生成描述文件，以及修正异步 UI 测试对折叠详情的断言时机。

Not rerun: pinned upstream DSH integration suites, a live DSH Web session, or live model-assisted Smart handoff. The old machine-specific verification report was excluded and is not used as evidence for this snapshot.
未重跑：固定 DSH 上游集成、真实 Web 会话和调用模型的 Smart 交接。旧的个人环境验收报告不作为本次验证证据。

## Source hygiene / 源码清理

The source copy excludes dependency trees, build caches, original `.desktop-test` state, credentials and personal `.agent-orch` runs. Filename and common secret-pattern checks found no personal absolute paths or live credentials in the reviewed source set. DSH test canaries intentionally resemble credentials to exercise redaction; they were manually inspected and retained. This is a targeted preparation review, not a complete security audit.
源码副本排除了依赖、构建缓存、原始桌面测试状态、凭据及个人运行记录。对待提交文件进行路径和常见密钥模式检查，未发现个人绝对路径或真实凭据；DSH 中命中的脱敏测试假密钥经人工核对后保留。本次为开源整理检查，不是完整安全审计。

## Publication / 发布

GitHub CI has been configured but has not run on GitHub. No remote repository or package release is created by these local checks. See [publishing](PUBLISHING.md).
已配置 CI，尚未在 GitHub 执行。此次本地检查未创建远程仓库或发布包，后续步骤见发布指南。

## Branding update / 命名与展示更新

The public package name is restored to `dsh-codex-handoff` (DSH Codex Handoff). Package metadata, plugin identifiers, descriptor references, styles, and related assertions were updated together. The 185-test suite, type checks, lint, builds, and renamed tarball installation/module-loading check passed. The complete `pnpm check`, including the documentation gate, passed after restoring the original name. Host integration notes above still apply.
包名恢复为 `dsh-codex-handoff`。名称已同步到包配置、插件标识、描述文件引用、样式和相关断言。185 个测试、类型检查、lint、构建，以及新名称下的打包安装/模块加载检查通过。恢复原名后，完整 `pnpm check`（含文档检查）通过。
