## Purpose

为 Neuro OJ 生产镜像建立可复现、可审计且默认拒绝不安全产物的发布供应链，使运维能够确认镜像来源、内容摘要、漏洞状态、SBOM 与签名证明，并安全地执行升级和回滚。

## ADDED Requirements

### Requirement: 候选镜像通过安全门禁后才能发布正式标签

Release 工作流 MUST 先为每个生产镜像生成唯一候选标签并推送候选镜像，随后完成漏洞扫描、SBOM 生成和签名。只有所有门禁成功后，工作流才可以将已验证的同一镜像 digest 发布为 Release 版本标签；工作流 MUST NOT 将扫描前的镜像直接发布为正式生产标签。

#### Scenario: 安全门禁通过后发布版本标签

- **WHEN** GitHub Release 触发镜像发布且所有候选镜像通过扫描、SBOM 和签名步骤
- **THEN** 每个正式版本标签指向扫描时验证过的同一个镜像 digest
- **THEN** 发布记录包含源码 commit、Release tag 和各镜像 digest

#### Scenario: 漏洞扫描失败阻断正式发布

- **WHEN** 任一候选镜像存在门禁范围内的未豁免高危或严重漏洞
- **THEN** Release 工作流失败
- **THEN** 对应正式版本标签不会被创建或更新

### Requirement: 生产镜像具备 SBOM、签名与来源证明

每个正式生产镜像 MUST 关联机器可读 SBOM、Cosign keyless 签名和来源证明。证明 MUST 能够关联到本仓库、构建工作流、Release 版本和源码 commit。生产部署验证 MUST 拒绝无法验证签名或来源的镜像。

#### Scenario: 验证已发布镜像的供应链证明

- **WHEN** 发布验证任务检查一个正式版本镜像
- **THEN** 镜像 digest 存在 SBOM、有效签名和来源证明
- **THEN** 签名身份与本仓库的受信 GitHub Actions 工作流匹配

#### Scenario: 供应链证明缺失

- **WHEN** 镜像缺少签名、SBOM 或来源证明之一
- **THEN** 发布验证失败
- **THEN** 该镜像不得作为生产部署输入

### Requirement: 生产基础镜像固定内容摘要

生产 Dockerfile 和生产 Compose 使用的基础镜像 MUST 使用经过审查的内容 digest，而不是仅使用可变 tag。应用发布镜像由 Release 版本标签或 digest 标识，不得依赖 `latest`、`beta` 或其他可变通道作为生产默认值。

#### Scenario: 检查生产镜像引用

- **WHEN** CI 检查生产 Dockerfile 和 Compose 文件中的镜像引用
- **THEN** 基础镜像引用包含 `@sha256:` digest
- **THEN** 生产应用镜像引用要求显式 Release 版本，不提供 `latest` 默认值

#### Scenario: 发现可变生产引用

- **WHEN** 生产 Compose 或生产 Dockerfile 新增无 digest 的基础镜像，或应用镜像回退到 `latest`
- **THEN** 配置检查失败并阻止合并或发布

### Requirement: 发布后验证实际镜像

Release 工作流 MUST 对正式版本标签解析出的实际 digest 执行拉取、签名验证和最小容器 smoke test。验证 MUST 覆盖所有发布镜像，并在任一镜像无法拉取、签名不匹配或无法通过 smoke test 时失败。

#### Scenario: 所有正式镜像验证通过

- **WHEN** Release 工作流完成正式标签发布
- **THEN** 所有发布镜像均可按记录的 digest 拉取
- **THEN** 所有镜像的签名和来源证明验证通过
- **THEN** 所有镜像完成对应的最小启动或运行时 smoke test

#### Scenario: 正式标签指向错误 digest

- **WHEN** 正式标签解析出的 digest 与候选镜像记录不一致
- **THEN** 发布验证失败并报告镜像名称、标签和实际 digest
