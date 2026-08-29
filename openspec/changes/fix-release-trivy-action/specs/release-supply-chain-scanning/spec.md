## Purpose

确保生产镜像发布时的漏洞扫描和 SBOM 生成能够在 GitHub Actions 中实际执行，并在工具引用失效时尽早阻止发布。

## ADDED Requirements

### Requirement: Release 使用可用且固定的 Trivy 扫描动作

Release workflow MUST 使用已验证存在、且其依赖引用可解析的固定 Trivy Action 版本；漏洞扫描和 SBOM 生成 MUST 继续对每个生产镜像执行。

#### Scenario: 发布流水线准备扫描

- **WHEN** GitHub Release 触发镜像发布流水线
- **THEN** Trivy Action 的引用能够被 GitHub Actions 解析
- **AND** 流水线对每个候选生产镜像执行漏洞扫描
- **AND** 流水线为每个候选生产镜像生成 SBOM

#### Scenario: 高危漏洞扫描失败

- **WHEN** Trivy 扫描发现未忽略的 HIGH 或 CRITICAL 漏洞
- **THEN** 对应镜像的发布门禁失败
- **AND** 该镜像不得进入正式发布阶段

### Requirement: 发布配置回归检查

供应链静态检查 MUST 校验 Release workflow 使用已验证的 Trivy Action 引用，防止已知不可解析的版本回归。

#### Scenario: 已知有效的 Trivy 引用

- **WHEN** 静态供应链检查运行在当前 Release workflow 上
- **THEN** 检查确认 Trivy Action 引用符合已验证版本约束并通过

#### Scenario: 回归到失效引用

- **WHEN** Release workflow 恢复使用已知会引用不存在依赖的 Trivy Action 版本
- **THEN** 静态供应链检查返回非零退出码
- **AND** CI 在合并前报告供应链配置错误
