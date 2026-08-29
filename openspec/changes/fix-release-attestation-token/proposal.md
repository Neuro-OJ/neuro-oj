## Why

`Release Images` 在构建、扫描和签名全部成功后，正式镜像验证仍会失败。原因是验证步骤调用 GitHub CLI 检查来源证明时没有提供 `GH_TOKEN`，导致 GitHub CLI 直接退出，而不是报告镜像校验失败。

## What Changes

- 为正式 Release 镜像验证任务注入工作流令牌，使 `gh attestation verify` 能够访问 GitHub 来源证明。
- 在供应链配置检查中强制要求该令牌配置。
- 增加缺少令牌时必须失败的回归测试。

## Capabilities

### New Capabilities

- `release-attestation-verification`: 正式镜像发布完成后，验证 digest、签名、SBOM、来源证明和 smoke test。

### Modified Capabilities

## Impact

- 影响 `.github/workflows/release.yml` 的正式镜像验证任务。
- 影响 `scripts/release/check-supply-chain.sh` 及其测试。
- 不改变镜像内容、签名策略、生产部署配置或用户运行时行为。
