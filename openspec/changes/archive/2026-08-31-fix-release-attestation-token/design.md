## Context

正式 Release 验证任务使用 `gh attestation verify` 检查 GitHub 来源证明。该命令需要工作流令牌，但当前任务只设置了仓库名称，没有设置 `GH_TOKEN`。供应链检查脚本已经负责阻止已知的发布配置回退，因此可以在同一检查中加入令牌配置约束。

## Goals / Non-Goals

**Goals:**

- 让正式镜像验证任务可以认证调用 GitHub CLI。
- 让本地和 CI 的供应链检查提前发现令牌配置遗漏。
- 保持现有签名、SBOM、来源证明和 smoke test 的严格校验。

**Non-Goals:**

- 不调整 GitHub Actions 权限范围以外的仓库设置。
- 不移除或弱化 Cosign、GitHub Attestation 或 digest 校验。
- 不改变生产镜像构建内容和部署脚本。

## Decisions

- 在验证步骤的 `env` 中使用 GitHub Actions 内置的 `github.token` 设置 `GH_TOKEN`。它与当前工作流上下文绑定，不需要新增仓库密钥，也符合 GitHub CLI 在 Actions 中的认证方式。
- 在 `check-supply-chain.sh` 中检查 `GH_TOKEN: ${{ github.token }}`，并在回归测试中删除该配置后确认检查失败。这样可以覆盖配置存在和缺失两种情况。
- 保留现有的 `gh attestation verify` 参数和签名身份约束，令牌只解决 API 访问问题，不改变验证对象或信任边界。

## Risks / Trade-offs

- [GitHub Actions 权限不足] → 令牌配置正确但仓库权限策略仍可能拒绝查询；继续使用现有工作流权限并让验证任务明确失败，避免误放行。
- [静态检查与 YAML 实际解析不一致] → 检查固定的工作流环境配置文本，并通过 CI 的真实 Release 验证覆盖最终行为。

## Migration Plan

1. 修改工作流和供应链检查脚本，补充回归测试。
2. 在 PR 中运行 shell 语法检查、供应链测试和 OpenSpec 校验。
3. 合并后重新创建 RC 发布，确认正式镜像验证任务成功。
4. 若验证仍失败，可回退该工作流配置提交；已发布的镜像不会因该配置变更而被修改。
