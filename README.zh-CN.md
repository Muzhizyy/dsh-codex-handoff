# DSH Codex Handoff

[English](README.md) | 简体中文

把 Codex 的可验证会话上下文带到 DeepSeek Harness（DSH）中继续工作。插件读取 Codex 会话和当前仓库，先展示发现结果与预览，再通过官方 DSH Agent API 创建普通、可恢复的会话；它不写入 Codex 源文件、不重放历史工具，也不直接写 DSH JSONL。

本项目目前是面向 DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`（`0.1.3-alpha.1`）的 developer-preview 插件。DSH 的公开 API 仍可能变化，安装前请保留可恢复的 DSH home 备份。

## 安装

目前从源码构建本地包，不假定 npm 上已有发布版本。需要 Node `^22.19.0 || >=24.0.0`、Git 和 pnpm `11.7.0`。在本仓库目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
# 在已安装并配置好 DSH 的环境运行：
dsh plugin --profile web add ./dsh-codex-handoff-0.1.0-alpha.1.tgz
```

重启 Web profile，在侧边栏打开插件。仓库包含固定版本生成的 Typert 描述文件，普通构建无需额外克隆 DSH；重新生成描述文件和上游验收见 [开发指南](docs/DEVELOPMENT.md)。

源码构建涉及依赖生命周期脚本。项目用 `allowBuilds` 允许 esbuild 构建；本项目没有 `prepare` 安装钩子。打包后的使用者不需要编译源码。插件只插入自己的 bundle 层，基座的 Agent、session、storage、preset 和 Typert 服务由 DSH 提供。

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


## 项目结构与参与

`src/codex` 负责发现与解析；`src/repo` 检查仓库事实；`src/handoff` 编译交接上下文；`src/dsh` 和 `src/host` 对接宿主；`src/client` 提供 Web UI。`tests/fixtures` 仅保留合成测试数据。

欢迎提交最小复现和对应测试，参见 [贡献指南](CONTRIBUTING.md)。采用 [MIT 许可证](LICENSE)。设计草案位于 `docs/design/`，当前源码与本次验证记录优先于历史计划。参考项目列于 [资料来源](docs/REFERENCES.md)。
