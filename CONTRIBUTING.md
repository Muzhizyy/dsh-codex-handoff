# Contributing / 贡献指南

Open an issue with the problem, expected behavior, version, and a minimal reproducible example. Discuss substantial protocol/API changes before implementation. Keep pull requests focused and include regression tests for behavior changes.
提交 issue 时说明问题、预期行为、版本及最小复现。较大的协议/API 变更先讨论，PR 保持主题集中，行为修复附带回归测试。

## Local checks / 本地检查

Install dependencies as described in the README, then run:
按 README 安装依赖后运行：

```sh
pnpm check
```

Update both README languages when changing installation, public behavior, or limitations. Use synthetic fixtures and remove credentials, local conversation data, and machine-specific paths from contributions. Contributions are provided under the repository's MIT license; retain third-party notices.
安装、公开行为或限制变化时同步两种语言的 README。使用合成样例，不提交凭据、个人会话或机器专属路径。贡献遵循仓库 MIT 许可，保留第三方声明。
