# Changelog

## 0.2.0-rc.2 — 2026-10-02

- 更新兼容目标为官方 DeepSeek Harness `dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84`，迁移到 Session Format v4；继续通过 `agents.create()` 创建导入 session，不由插件生成 `session/end-seed`。
- 将安装说明改为使用本地构建的确切预构建 `.tgz` 安装到已初始化的 Desktop profile；不宣称插件已发布到 npm。
- 增加显式、仅 fork 的 DSH→Codex 回传合同与 UI/Remote 路径：仅限可链接的导入 DSH session；源 thread 不变、回传不调用 LLM、不自动打开 fork；unknown 结果警告且不重试。
- 完整回传决策与状态机见[增量 SPEC](./docs/2026-10-roundtrip-spec.md)及[实施计划](./docs/2026-10-roundtrip-plan.md)。已完成的[独立 verifier 的后续报告](./docs/2026-10-verification.md)记录了安装版 CLI 与隔离 DSH/Codex API 验收；Electron 窗口点击流程未运行。
- 2026-10-03 的窄兼容修正：Codex app-server 版本筛选精确放行当前 Desktop CLI `0.159.0-alpha.12.1`，继续放行正式版 `0.159.2` 起；不放行其他预发布版。放行仍需实际 schema、Codex home 与 fork 来源核验，未来正式版符合版本筛选不代表均已实测。当前 alpha 的安装版 DSH 隔离完整回传已通过；此前被旧版本筛选拒绝的复测仍作为历史失败保留在[独立验证报告](./docs/2026-10-verification.md)。

## 0.1.0-alpha.1 — 2026-09-05

- Initial developer-preview packaging for DeepSeek Harness `d347e703908d0406b7a7ef80e3a0e594d86b2215`.
- Added typed Host/Client/Remote exports, Smart deterministic/model-assisted preview, and Full consent flow.
- Added read-only Codex discovery, repository diagnostics, bounded redaction, idempotent create and restart-oriented acceptance gates.
- Documented prebuilt installation, source-build lifecycle risk, best-effort privacy guarantees, limitations and uninstall behavior.
