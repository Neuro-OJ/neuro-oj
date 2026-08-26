## ADDED Requirements

### Requirement: 竞赛提交速率限制

`POST /api/v1/contests/:id/submit` SHALL 受速率限制保护（用户维度 + IP 维度），与普通提交一致，防止参赛者刷爆评测队列。

#### Scenario: 竞赛提交超限返回 429

- **WHEN** 参赛者在短时间内提交次数超过速率限制阈值
- **THEN** 系统返回 HTTP 429，且不创建提交
