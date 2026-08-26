## ADDED Requirements

### Requirement: 题目导入速率限制

`POST /api/v1/problems/import-bundle` SHALL 受速率限制保护，防止大包上传造成资源消耗。

#### Scenario: 导入超限返回 429

- **WHEN** 用户短时间内调用 import-bundle 次数超过阈值
- **THEN** 系统返回 HTTP 429，且不解析上传包
