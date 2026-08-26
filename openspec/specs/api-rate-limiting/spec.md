# api-rate-limiting Specification

## Purpose
TBD - created by archiving change fix-audit-security-findings. Update Purpose after archive.
## Requirements
### Requirement: 竞赛提交速率限制

`POST /api/v1/contests/:id/submit` SHALL 受与普通提交相同的速率限制保护（用户维度 + IP 维度），防止参赛者刷爆评测队列。

#### Scenario: 竞赛提交超限返回 429

- **WHEN** 参赛者在短时间内提交次数超过速率限制阈值
- **THEN** 系统返回 HTTP 429，且不创建提交

### Requirement: 客观题提交速率限制

`POST /api/v1/problems/:id/submit` SHALL 受速率限制保护，防止暴力试答案或刷接口。

#### Scenario: 客观题提交超限返回 429

- **WHEN** 用户短时间内提交客观题答案次数超过阈值
- **THEN** 系统返回 HTTP 429，且不落库

### Requirement: 题目创建与导入速率限制

`POST /api/v1/problems` 与 `POST /api/v1/problems/import-bundle` SHALL 受速率限制保护，防止大包上传与批量建题造成资源消耗。

#### Scenario: 题目导入超限返回 429

- **WHEN** 用户短时间内调用 import-bundle 次数超过阈值
- **THEN** 系统返回 HTTP 429，且不解析上传包

#### Scenario: 题目创建超限返回 429

- **WHEN** 用户短时间内创建题目次数超过阈值
- **THEN** 系统返回 HTTP 429，且不创建题目

