## Purpose

定义社区社交动态能力，包括用户关注关系、最新与关注两种动态流，以及系统活动（首次 Accepted、发布题解、参加竞赛）的生成与隐私控制。

## Requirements

### Requirement: 用户关注关系

系统 SHALL 允许登录用户关注或取消关注其他非 root 用户，并拒绝关注自己。

#### Scenario: 重复关注

- **WHEN** 用户重复关注同一用户
- **THEN** 操作保持幂等且仅存在一条关注关系

### Requirement: 最新与关注动态流

系统 SHALL 提供 `latest` 和 `following` 两种游标分页动态流，合并短动态和允许展示的系统活动。

#### Scenario: 关注动态流

- **WHEN** 用户请求 `following` 动态流
- **THEN** 系统仅返回其关注用户的可见短动态与系统活动，并按时间倒序排列

### Requirement: 系统活动生成与隐私

系统 SHALL 可为首次 Accepted、发布题解和参加竞赛生成去重活动，并同时服从管理员活动开关与用户活动可见性。

#### Scenario: 重复通过同一题

- **WHEN** 用户对已经通过的题目再次获得 Accepted
- **THEN** 系统 MUST NOT 再生成首次通过活动

#### Scenario: 用户关闭活动展示

- **WHEN** 用户将活动可见性设为 `hidden`
- **THEN** 任何其他用户的动态流 MUST NOT 返回该用户的系统活动
