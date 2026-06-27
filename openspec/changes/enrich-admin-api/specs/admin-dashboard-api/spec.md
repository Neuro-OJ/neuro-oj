## Purpose

定义管理后台仪表盘统计数据 API 规范。提供平台关键指标的聚合数据接口。

## ADDED Requirements

### Requirement: 系统提供仪表盘统计数据

系统 SHALL 在 `GET /api/v1/admin/dashboard/stats` 端点提供平台关键统计指标，该端点依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员获取仪表盘统计数据

- **WHEN** 已登录管理员调用 `GET /api/v1/admin/dashboard/stats`
- **THEN** 系统返回包含以下统计数据的 JSON 响应：
  - `total_users`: 平台注册用户总数（排除 root 系统用户）
  - `total_problems`: 题目总数（含 U 型和 P 型）
  - `total_submissions`: 提交记录总数
  - `total_categories`: 分类总数
  - `total_accepted`: 通过的评测结果数（status = 'Accepted'）
  - `total_pending`: 待评测提交数
  - `acceptance_rate`: 整体通过率（accepted / total_judged）
  - `recent_submissions_24h`: 过去 24 小时内的提交数
  - `active_users_24h`: 过去 24 小时内有提交活动的用户数

#### Scenario: 统计数据中排除 root 用户

- **WHEN** 管理员获取统计数据
- **THEN** `total_users` 统计中排除 id='0' 的 root 系统用户

#### Scenario: 非管理员拒绝访问

- **WHEN** 普通用户（role=user）调用 `GET /api/v1/admin/dashboard/stats`
- **THEN** 系统返回 HTTP 403

#### Scenario: 数据库查询失败

- **WHEN** 统计查询时数据库连接异常
- **THEN** 系统返回 HTTP 500，错误码 `DASHBOARD_STATS_ERROR`
