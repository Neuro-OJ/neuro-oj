## Purpose

复用 `noj-llm-gateway` 为用户 Provider 提供受控的 OpenAI-compatible 调用，隔离 API Key 与 Judge/Evaluator。

## ADDED Requirements

### Requirement: 受信调用与配置解析

Gateway SHALL 只接受有效 eval token，并以 token 中的 provider ID、submission 上下文和 allowed model 约束请求；调用方不得提交任意 Provider、base URL、Authorization 或请求头。

#### Scenario: 未认证或配置不可用

- **WHEN** token 无效、Provider 不存在、被删除或禁用
- **THEN** Gateway 返回稳定错误码并不发起 Provider 请求

### Requirement: 固定 Provider 请求

Gateway SHALL 使用配置中的 base URL、model 和解密 Key 发送固定 Chat Completions 请求，限制 prompt/响应大小、调用预算和超时，禁止重定向。

#### Scenario: Provider 错误

- **WHEN** Provider 返回认证失败、限流、未知错误或格式无效
- **THEN** Gateway 返回稳定错误码
- **THEN** 不透传原始 body、headers、Authorization 或内部网络细节

### Requirement: 凭据不跨边界传播

完整 API Key MUST NOT 进入 JudgeTask、Redis、Judge 日志、Docker 环境变量、Evaluator 文件或评测结果。Gateway 返回 Judge 的内容只能是模型结果或稳定错误。

#### Scenario: Judge 任务不携带密钥

- **WHEN** Core 为绑定 BYOK 的提交创建或恢复 JudgeTask
- **THEN** 任务只包含配置 ID、模型和短期 token，不包含完整 API Key
- **THEN** Judge 转发给 Solution 的结果或错误也不包含 API Key
