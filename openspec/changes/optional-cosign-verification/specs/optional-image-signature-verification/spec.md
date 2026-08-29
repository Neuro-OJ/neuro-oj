## Purpose

让普通用户无需安装 Cosign 即可完成 NOJ 部署，同时为有供应链安全要求的部署保留显式镜像签名验证能力。

## ADDED Requirements

### Requirement: 镜像签名校验默认关闭

生产配置模板 MUST 默认将 `NOJ_ENFORCE_IMAGE_SIGNATURES` 设置为 `false`。当该值为 `false` 时，部署脚本 MUST 不要求宿主机安装 Cosign，且 MUST 不执行镜像签名验证。

#### Scenario: 默认配置完成安装

- **WHEN** 用户使用生产配置模板且未修改镜像签名校验选项
- **THEN** 安装流程不因缺少 Cosign 失败
- **AND** 安装流程继续执行镜像拉取和服务启动

#### Scenario: 显式关闭镜像签名校验

- **WHEN** `NOJ_ENFORCE_IMAGE_SIGNATURES=false`
- **THEN** `start`、`upgrade` 和 `verify` 不要求 `cosign` 命令
- **AND** 部署提示明确说明镜像签名校验已关闭

### Requirement: 严格模式可选开启

当 `NOJ_ENFORCE_IMAGE_SIGNATURES=true` 时，部署脚本 MUST 要求 Cosign 可用并执行现有镜像签名校验；Release workflow 的镜像签名能力 MUST 保持不变。

#### Scenario: 显式开启镜像签名校验

- **WHEN** 用户设置 `NOJ_ENFORCE_IMAGE_SIGNATURES=true`
- **THEN** 缺少 Cosign 时部署在校验阶段失败并给出安装提示
- **AND** Cosign 可用时按现有身份规则验证已启用的应用镜像
