## Purpose

确保生产镜像在固定基础镜像之上应用可用的操作系统安全更新，避免已知且有修复版本的高危漏洞阻止发布或进入用户环境。

## ADDED Requirements

### Requirement: 生产运行时镜像应用基础系统安全更新

受供应链扫描的生产运行时镜像 MUST 在构建阶段应用基础操作系统的可用安全更新，同时 MUST 保留固定基础镜像 digest 和现有运行时行为。

#### Scenario: Debian 评测镜像构建

- **WHEN** 构建 evaluator 或 solution Python 生产镜像
- **THEN** 镜像构建应用 Debian 基础系统的安全更新
- **AND** 镜像继续使用固定 digest 的 Python 基础镜像
- **AND** 镜像继续以非 root 用户运行

#### Scenario: Alpine 网关镜像构建

- **WHEN** 构建 LLM Gateway 生产镜像
- **THEN** 镜像构建应用 Alpine 基础系统的安全更新
- **AND** 镜像继续使用固定 digest 的 Deno 基础镜像
- **AND** 镜像继续使用现有 Deno 启动命令

#### Scenario: 安全扫描验证

- **WHEN** Release workflow 对更新后的候选镜像执行 HIGH/CRITICAL 漏洞扫描
- **THEN** 已有修复版本的基础系统漏洞不再以当前安装版本出现在扫描结果中
- **AND** 扫描门禁仍对其它未忽略的 HIGH/CRITICAL 漏洞失败

### Requirement: 安全更新配置回归检查

供应链静态检查 MUST 验证受影响的生产 Dockerfile 包含基础系统安全更新步骤，并继续拒绝未固定 digest 的基础镜像。

#### Scenario: 安全更新步骤存在

- **WHEN** 供应链静态检查运行在当前生产 Dockerfile 上
- **THEN** 检查确认 Debian 和 Alpine 受影响镜像包含安全更新步骤并通过

#### Scenario: 安全更新步骤缺失

- **WHEN** 任一受影响生产 Dockerfile 删除安全更新步骤
- **THEN** 供应链静态检查返回非零退出码
- **AND** CI 在合并前报告镜像安全配置错误
