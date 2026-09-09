# Prepare a GitHub release / GitHub 发布准备

The local repository is prepared independently. Creating a GitHub repository and pushing are separate actions. No remote URL is inferred from the commit email.
本地仓库独立管理。创建 GitHub 远程仓库和推送需要单独执行，不从 Git 邮箱推断 GitHub 账号。

1. Check `docs/VALIDATION.md` and rerun the README's checks after any changes.
2. Create an empty public GitHub repository with the same name (do not auto-create README, license or `.gitignore`).
3. Confirm the destination owner and use SSH or your authenticated GitHub credential manager.
4. In this repository, replace `OWNER` and `REPOSITORY` below with the actual destination:

```sh
git remote add origin git@github.com:OWNER/REPOSITORY.git
git push -u origin main
```

先核对验证记录，再在正确账号下创建同名空公开仓库，替换上面的远程地址并推送。不要把密码或访问令牌写入 URL、配置示例或仓库文件。

After the remote exists, add repository/homepage/issue metadata with its real URL, enable branch protection and private vulnerability reporting as appropriate, and inspect the first CI run. The workflow is prepared locally; GitHub-hosted execution is not yet verified.
远程创建后补充真实 URL，按需启用分支保护和私密漏洞报告，并检查首次 CI。当前仅准备了工作流文件，尚未在 GitHub 托管环境执行。

All original licenses are MIT. The initial local commit is a reviewable source snapshot, not a published package or production-readiness certification. Real host/model integration limits are listed in the README.
原项目均采用 MIT。首次本地提交是可审阅的源码快照，不代表已发布包或生产认证；真实宿主和模型联调限制见 README。
