## Purpose

定义 Neuro OJ 管理后台仪表盘页面规范。该页面在 `/admin` 路径提供，展示平台关键统计指标。

## Requirements

### Requirement: 管理员可查看仪表盘

系统 SHALL 在 `/admin` 路径提供管理后台仪表盘页面，展示平台关键统计指标。

#### Scenario: 管理员访问仪表盘

- **WHEN** 已登录管理员访问 `/admin`
- **THEN** 系统显示仪表盘页面，包含用户总数、题目总数、提交总数等统计卡片

#### Scenario: 统计数据加载失败

- **WHEN** 仪表盘加载统计数据时网络错误
- **THEN** 系统显示错误提示，不中断页面其他部分

### Requirement: 系统提供仪表盘统计数据 API

系统 SHALL 在 `GET /api/v1/admin/dashboard/stats` 端点提供平台关键统计指标，该端点依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员获取仪表盘统计数据

- **WHEN** 已登录管理员调用 `GET /api/v1/admin/dashboard/stats`
- **THEN** 系统返回包含以下统计数据的 JSON 响应：
  - `total_users`: 平台注册用户总数（排除 root 系统用户）
  - `total_problems`: 题目总数（含 U 型和 P 型）
  - `total_submissions`: 提交记录总数
  - `total_tags`: 标签总数
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

### Requirement: 仪表盘统计数据自动刷新

系统 SHALL 在仪表盘页面自动轮询刷新统计数据（评测队列状态等动态指标），同时 SHALL 提供手动刷新按钮。页面不可见时 SHALL 暂停轮询，可见时恢复。

#### Scenario: 仪表盘自动轮询统计数据

- **WHEN** 管理员停留在仪表盘页面
- **THEN** 系统每 5 秒自动重新请求队列统计并更新显示

#### Scenario: 手动刷新统计数据

- **WHEN** 管理员点击刷新按钮
- **THEN** 系统立即重新请求统计数据并更新显示

#### Scenario: 页面隐藏暂停轮询

- **WHEN** 管理员切换标签页导致仪表盘页面不可见
- **THEN** 系统暂停自动轮询，切回可见后恢复

### Requirement: 仪表盘显示部分统计失败

系统 SHALL 对每个无法加载的统计项显示降级状态和重试入口，不得静默移除该项；页面 SHALL 显示最近一次成功刷新时间。

#### Scenario: 单个统计接口失败
- **WHEN** 用户统计请求失败而题目统计请求成功
- **THEN** 仪表盘显示用户统计加载失败及重试入口，同时显示题目统计
