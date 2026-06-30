## Purpose

定义用户每日签到功能，支持用户每日签到一次并自动累计连续签到天数。

## Requirements

### Requirement: 执行签到

系统 SHALL 提供 `POST /api/v1/checkin` 端点，允许已登录用户执行每日签到。

#### Scenario: 首次签到

- **WHEN** 已登录用户首次调用签到端点
- **THEN** 返回 200，响应体 `{ "data": { "checked_in": true, "streak": 1 } }`

#### Scenario: 连续签到

- **WHEN** 已登录用户昨日已签到（streak=3）今日签到
- **THEN** 返回 200，响应体 `{ "data": { "checked_in": true, "streak": 4 } }`

#### Scenario: 同日重复签到

- **WHEN** 已登录用户今日已签到，再次调用签到端点
- **THEN** 返回 409，错误信息"今天已签到"

#### Scenario: 未登录调用

- **WHEN** 未携带有效 token 调用签到端点
- **THEN** 返回 401 UNAUTHORIZED

### Requirement: 查询今日签到状态

系统 SHALL 提供 `GET /api/v1/checkin/today` 端点，返回当前用户今日签到状态。

#### Scenario: 已签到

- **WHEN** 已登录用户当前已签到（streak=5）查询今日状态
- **THEN** 返回 200，响应体 `{ "data": { "checked_in": true, "streak": 5 } }`

#### Scenario: 未签到

- **WHEN** 已登录用户今日未签到查询今日状态
- **THEN** 返回 200，响应体 `{ "data": { "checked_in": false, "streak": 0 } }`

#### Scenario: 未登录查询

- **WHEN** 未携带有效 token 调用查询端点
- **THEN** 返回 401 UNAUTHORIZED

### Requirement: 连续天数计算规则

系统 SHALL 按以下规则计算 streak：
- 首次签到：streak = 1
- 昨日有签到记录：streak = 昨日 streak + 1
- 昨日无签到记录：streak = 1（重置）

#### Scenario: 跨日不签到后签到

- **GIVEN** 用户连续 3 天签到（streak=3）
- **AND** 第 4 天未签到
- **WHEN** 第 5 天签到
- **THEN** streak = 1（重置，不累加）
