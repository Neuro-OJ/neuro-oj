## MODIFIED Requirements

### Requirement: 全链路 E2E 测试框架

系统 SHALL 提供全链路 E2E 测试，验证从提交 → 评测 → 结果持久化的完整流程。

#### Scenario: 测试环境

- **WHEN** 运行全链路 E2E 测试
- **THEN** 需要以下服务可用：Redis、PostgreSQL（可通过 docker-compose 或环境变量配置）

#### Scenario: 测试门控

- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 未设置
- **THEN** 全链路 E2E 测试被跳过
