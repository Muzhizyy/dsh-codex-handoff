# Development / 开发

Use Node 24 and the exact pnpm version in `package.json`.
使用 Node 24 与 `package.json` 指定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:docs
```

`packages/codex-handoff/generated/` contains required upstream-generated descriptors and is versioned deliberately. `dist/`, coverage and local DSH homes are not versioned.
`generated/` 中的描述文件是构建所需输入，应提交；`dist/`、覆盖率结果和个人 DSH 数据不应提交。

## Upstream integration / 上游集成

The integration scripts create a disposable checkout of the pinned upstream revision and run its installation/build. They require network access and take longer than local tests:
上游验收会创建固定版本的临时 checkout 并安装、构建依赖，需要网络，耗时高于本地测试：

```sh
pnpm test:pinned-dsh
pnpm test:pinned-dsh-client
```

`DSH_PINNED_CHECKOUT` may point to a checkout at the exact pinned SHA. The acceptance scripts use a detached worktree. Direct `pnpm generate:typert` temporarily adds a contributor to the configured checkout before restoring it; use a disposable, built upstream checkout for regeneration. `DSH_TYPERT_ARTIFACT_ROOT` selects an alternative artifact directory for development only.
`DSH_PINNED_CHECKOUT` 必须指向固定 SHA。验收脚本使用独立 worktree；直接运行生成命令会临时修改上游 checkout，因此应使用已构建的临时副本。`DSH_TYPERT_ARTIFACT_ROOT` 仅用于开发时指定其他描述文件目录。

Keep the DSH compatibility declaration and pinned SHA in sync when upgrading. Never replace a failed upstream test with a file-existence check.
升级时同步兼容性声明和固定 SHA，并重新执行真实上游验收。
