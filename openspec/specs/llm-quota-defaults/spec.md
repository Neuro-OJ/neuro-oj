# llm-quota-defaults Specification

## Purpose
TBD - created by archiving change fix-audit-security-findings. Update Purpose after archive.
## Requirements
### Requirement: LLM 默认配额

系统 SHALL 在初始化时写入默认 `llm_quotas` 行，确保未显式配置配额时用户/题目/全局维度仍有安全上限，而不是“0 = 无限”。

默认配额 SHALL 至少包含：

- `global/day`：`max_calls`、`max_tokens`、`max_cost` 非零
- `global/month`：`max_calls`、`max_tokens`、`max_cost` 非零
- `user/day`：`max_calls`、`max_tokens` 非零
- `problem/day`：`max_calls`、`max_tokens` 非零

初始化逻辑 MUST 幂等：已存在同 scope 配额时不覆盖管理员显式配置。

#### Scenario: 初始化写入默认全局配额

- **WHEN** 系统执行初始化（`init:system` 或等价流程）且 `llm_quotas` 中无 `global/day` 行
- **THEN** 系统插入默认 `global/day` 配额行，`max_calls`/`max_tokens`/`max_cost` 均为非零值

#### Scenario: 已存在配额不覆盖

- **WHEN** 管理员已配置 `global/day` 配额后再次执行初始化
- **THEN** 系统保留管理员配置，不覆盖为默认值

### Requirement: 无配额记录时的安全 fallback

当 `llm_quotas` 中查不到某作用域配额时，网关 SHALL 使用环境变量或代码默认值作为该作用域上限，MUST NOT 将缺失视为无限。

#### Scenario: 缺少 user/day 配额时使用 fallback

- **WHEN** 用户调用 LLM 且 `llm_quotas` 无该用户 `user/day` 行
- **THEN** 网关按 fallback 上限（如 `NOJ_LLM_DEFAULT_USER_DAY_TOKENS`）执行限额，而不是无限

#### Scenario: 缺少 global 配额时使用 fallback

- **WHEN** 调用 LLM 且 `llm_quotas` 无 `global/day` 行
- **THEN** 网关按 fallback 全局上限执行限额

