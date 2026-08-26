## ADDED Requirements

### Requirement: 客观题提交速率限制

`POST /api/v1/problems/:id/submit` SHALL 受速率限制保护，防止暴力试答案或刷接口。

#### Scenario: 客观题提交超限返回 429

- **WHEN** 用户短时间内提交客观题答案次数超过阈值
- **THEN** 系统返回 HTTP 429，且不落库
