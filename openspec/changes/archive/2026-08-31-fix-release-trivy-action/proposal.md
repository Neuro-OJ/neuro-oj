## Why

`0.8.0-rc.2` 的发布流水线在准备 Trivy 扫描时失败，因为当前固定的 `trivy-action@v0.28.0` 会引用不存在的 `setup-trivy@v0.2.1`。这会阻止应用镜像构建、SBOM 生成和 Release 发布，必须在下一次 RC 前修复。

## What Changes

- 将 Release workflow 使用的 Trivy Action 更新到已验证包含有效 `setup-trivy` 引用的固定版本。
- 保留漏洞扫描、SBOM 生成和失败门禁，不降低发布安全检查范围。
- 增加针对 Trivy Action 引用的静态回归检查，避免再次使用已失效的版本或引用。

## Capabilities

### New Capabilities

- `release-supply-chain-scanning`: 发布流水线能够稳定执行 Trivy 漏洞扫描和 SBOM 生成。

### Modified Capabilities

<!-- 仅修复发布工具链实现，不改变面向用户的生产部署需求。 -->

## Impact

- 修改 `.github/workflows/release.yml` 及其 CI 检查。
- 不修改应用运行时、镜像内容、生产配置或部署命令。
- 下一次 RC 发布将重新触发镜像构建、扫描、签名和发布流程。
