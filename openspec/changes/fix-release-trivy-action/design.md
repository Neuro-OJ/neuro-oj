## Context

发布工作流当前在两个步骤调用 `aquasecurity/trivy-action@v0.28.0`。该版本的复合动作内部引用不存在的 `aquasecurity/setup-trivy@v0.2.1`，因此在真正构建镜像前即失败。官方后续版本已修复该依赖引用，并支持现有工作流使用的 `image-ref`、`format`、`vuln-type`、`severity`、`ignore-unfixed`、`exit-code` 和 `output` 输入。

## Goals / Non-Goals

**Goals:**

- 让 Release workflow 能解析并运行 Trivy 漏洞扫描和 SBOM 生成。
- 继续保留 HIGH/CRITICAL 漏洞门禁与 SBOM 产物。
- 在本地和 PR 阶段提前发现已知失效的 Trivy Action 引用。

**Non-Goals:**

- 不改变漏洞等级、忽略未修复漏洞或发布签名策略。
- 不把 Trivy 扫描改成允许失败，也不删除供应链检查。
- 不修改生产镜像或部署脚本。

## Decisions

- 使用已验证的 `aquasecurity/trivy-action@v0.36.0`，因为它已将内部 `setup-trivy` 引用更新为存在的版本，并保留当前 workflow 所需输入。相比直接使用 `master`，固定版本可复现；相比继续使用 `v0.28.0`，可消除已确认的解析失败。
- 在 `scripts/release/check-supply-chain.sh` 中增加版本断言，并复用已有的 `scripts/release/test-supply-chain.sh` 执行正向/负向回归检查。这样不需要在 CI 中访问外部仓库，也能阻止已知失效版本重新进入主分支。
- 版本断言只针对当前已验证版本，不改变其它 Action 的更新策略；后续升级 Trivy 时必须先验证上游复合动作依赖，再同步修改断言和测试。

## Risks / Trade-offs

- [固定版本后不会自动获得后续 Trivy Action 修复] → 由 Dependabot 和后续升级 PR 管理版本，升级时运行供应链测试。
- [静态检查无法替代 GitHub runner 的真实解析] → 在合并后以 workflow lint 和手动/RC 发布运行做最终验证。
- [v0.36.0 可能改变 Trivy 默认版本] → 保持现有显式扫描输入，并以 Release workflow 的扫描结果作为发布门禁。

## Migration Plan

1. 更新 Release workflow 和供应链静态检查。
2. 运行本地 Shell、YAML/actionlint 与 OpenSpec 校验。
3. 通过 PR 合并后创建新的 RC，确认六个镜像均完成构建、扫描、SBOM、签名和发布。
4. 如新版本行为不兼容，回滚该 PR 即可恢复上一版本配置；但旧版本仍会触发已知的依赖解析失败。
