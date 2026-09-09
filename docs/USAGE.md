# DSH Codex Handoff: usage, privacy and troubleshooting / 使用、隐私与故障排查

Supported upstream baseline / 上游适配基线：DSH `0.1.3-alpha.1`, commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`.


Open **Continue from Codex** in the sidebar, search for a session, and inspect its preview. Confirm an existing working directory, choose Smart or Full, review the information to be persisted, and consent to creation. The plugin opens the session after DSH confirms it is visible.

A `created_unattached` result means the session was created but workspace attachment was not confirmed. Retry attachment or inspect the session in DSH; do not repeatedly import it.

## Privacy and limitations

Both modes require explicit consent. Smart with a model sends bounded, best-effort-redacted evidence to the configured model. Smart without a model makes no analysis call. Both modes persist context that can be sent to the configured model on a later explicitly submitted DSH turn. Full also persists representable history. Redaction is **best effort**: review sensitive content before consent.

The importer never replays tools, writes Codex source data, or directly edits DSH JSONL. Sensitive paths such as credentials and private keys are excluded from repository evidence. Incomplete or corrupt history is reported as such; missing context is not reconstructed as fact. This is not a complete session backup or an exact recreation of the original agent runtime.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No sidebar entry | Check the Web profile and required UI/session services; restart it. |
| Compatibility rejected | Use the pinned upstream revision; do not bypass the compatibility check. |
| `CWD_REQUIRED` / `CWD_NOT_FOUND` | Select an existing working directory. |
| `SOURCE_CHANGED` | Discover and preview the source again. |
| `SESSION_NOT_VISIBLE` | Refresh DSH and inspect the session list before retrying. |

Uninstall with `dsh plugin --profile web remove dsh-codex-handoff`, then restart the profile. Existing DSH sessions and Codex source data remain.



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
