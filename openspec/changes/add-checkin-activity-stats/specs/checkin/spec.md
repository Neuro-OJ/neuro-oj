## Purpose

扩展每日签到能力为活跃度统计：提供历史查询、统计汇总与月度活跃榜，并在前端个人主页与首页展示。

## ADDED Requirements

### Requirement: 查询签到统计

系统 SHALL 提供 `GET /api/v1/checkin/stats` 端点，返回当前登录用户的签到统计：累计签到天数、当前连续天数、最长连续天数、指定月份签到天数、最近签到日期。

#### Scenario: 获取完整统计

- **WHEN** 已登录用户调用 `GET /api/v1/checkin/stats`
- **THEN** 返回 200，响应体包含 `total_days`（累计）、`current_streak`（当前连续天数）、`max_streak`（最长连续天数）、`month_days`（本月签到天数）、`last_checkin_date`

#### Scenario: 指定月份统计

- **WHEN** 已登录用户调用 `GET /api/v1/checkin/stats?month=2026-07`
- **THEN** `month_days` 为该用户 2026-07 的签到天数

#### Scenario: 今日未签到时的当前连续天数

- **GIVEN** 用户昨日签到（昨日 streak=5）且今日未签到
- **WHEN** 查询 `GET /api/v1/checkin/stats`
- **THEN** `current_streak=5`（进行中的连续天数不因今日未签到而归零）

#### Scenario: 未登录调用

- **WHEN** 未携带有效 token 调用 `GET /api/v1/checkin/stats`
- **THEN** 返回 401 UNAUTHORIZED

### Requirement: 查询签到历史

系统 SHALL 提供 `GET /api/v1/checkin/history?days=N` 端点，返回当前登录用户最近 N 天内已签到的日期列表（升序、含今日），供日历渲染。

#### Scenario: 最近 30 天历史

- **WHEN** 已登录用户调用 `GET /api/v1/checkin/history?days=30`
- **THEN** 返回 200，响应体 `days` 为最近 30 天（含今日）内已签到日期数组，`total_days` 为其中签到天数

#### Scenario: days 参数校验

- **WHEN** `days` 不在允许集合（30/90/365）或非法
- **THEN** 返回 400 参数错误

### Requirement: 今日状态包含进行中连续天数

系统 SHALL 在用户今日未签到时，于 `GET /api/v1/checkin/today` 返回进行中的连续天数（昨日 streak），使首页签到卡始终可见连续天数。

#### Scenario: 昨日签到今日未签

- **GIVEN** 用户昨日签到（streak=5）且今日未签到
- **WHEN** 查询 `GET /api/v1/checkin/today`
- **THEN** 返回 `{ "data": { "checked_in": false, "streak": 5 } }`

#### Scenario: 连续中断

- **GIVEN** 用户昨日未签到
- **WHEN** 查询 `GET /api/v1/checkin/today`
- **THEN** 返回 `{ "data": { "checked_in": false, "streak": 0 } }`

### Requirement: 签到活跃榜

系统 SHALL 提供 `GET /api/v1/rankings/checkin?month=YYYY-MM&page=&per_page=` 端点，按指定月份签到天数倒序返回用户排行；未登录也可访问，登录时响应额外包含当前用户自身排名。

#### Scenario: 月度活跃榜

- **WHEN** 访问 `GET /api/v1/rankings/checkin?month=2026-07`
- **THEN** 返回 200，行按签到天数 DESC + 用户名 ASC 排序，包含 `rank`、`user_id`、`username`、`days`

#### Scenario: 登录用户查看自身排名

- **WHEN** 已登录用户访问活跃榜
- **THEN** 响应额外包含 `user_rank`（当前用户在榜中的排名，未上榜为 null）

#### Scenario: 月份参数缺省

- **WHEN** 未传 `month` 参数
- **THEN** 按当前月（UTC）统计

### Requirement: 个人主页活跃度展示

noj-ui SHALL 在用户个人主页展示活跃度卡片：当前连续天数、累计签到天数、本月签到日历（已签到日期高亮）。

#### Scenario: 查看他人主页

- **WHEN** 访问任意用户个人主页
- **THEN** 页面展示该用户连续天数、累计签到天数与本月签到日历

### Requirement: 首页签到卡连续天数可见

noj-ui SHALL 在首页签到卡未签到时展示当前连续天数（来自 `GET /api/v1/checkin/today` 的 `streak`）。

#### Scenario: 未签到但存在连续天数

- **GIVEN** 用户昨日签到（streak=5）今日未签到
- **WHEN** 查看首页签到卡
- **THEN** 展示「已连续签到 5 天」，且签到按钮仍可点击
