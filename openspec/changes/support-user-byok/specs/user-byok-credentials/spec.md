## Purpose

为登录用户提供安全、隔离且可撤销的自带模型 Provider 配置；完整 API Key 只能由 LLM Gateway 在服务端使用。

## ADDED Requirements

### Requirement: 用户模型配置生命周期

系统 SHALL 为已登录用户提供配置的创建、列表、更新/轮换、删除和连通性测试 API。配置 SHALL 通过 `llm_providers.created_by` 归属于单一用户。

#### Scenario: 配置创建与脱敏列表

- **WHEN** 用户提交合法名称、OpenAI-compatible base URL、model 和 API Key
- **THEN** Gateway 加密保存 API Key，Core 返回配置 ID 和脱敏 key hint
- **THEN** 响应、提交任务和浏览器状态不包含 API Key 明文

#### Scenario: 跨用户访问

- **WHEN** 用户使用其他用户的配置 ID 读取、更新、测试或删除
- **THEN** 系统返回 404 或统一无权错误，目标配置不发生变化

#### Scenario: 删除与轮换

- **WHEN** 用户删除或轮换自己的配置
- **THEN** 删除立即阻止新的调用，轮换后的后续调用使用新密文
- **THEN** API 响应不返回明文凭据

### Requirement: 出站与输入安全

用户配置 SHALL 只允许 HTTPS、allowlist 主机和受限字段；系统 MUST 拒绝本地、私有、链路本地、元数据地址、非 443 端口、凭据 URL 和不安全重定向。

#### Scenario: 非法目标

- **WHEN** 用户提交非 HTTPS、未 allowlist 或私有地址
- **THEN** 系统返回稳定的 `provider_target_rejected` 错误
- **THEN** 不发起 Provider 请求

### Requirement: 提交绑定

系统 SHALL 允许用户在普通编程题提交时选择自己的配置，并只保存配置 ID；未选择时保持现有行为。

#### Scenario: 绑定他人或不可用配置

- **WHEN** 用户提交其他用户、已删除或禁用的配置 ID
- **THEN** 系统拒绝创建可执行的 BYOK 提交任务
