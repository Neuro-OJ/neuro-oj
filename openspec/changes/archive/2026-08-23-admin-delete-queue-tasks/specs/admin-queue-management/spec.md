## ADDED Requirements

### Requirement: 管理员可移除待处理正式提交任务

系统 SHALL 提供 `DELETE /api/v1/admin/queue/submissions/:id`，仅允许已登录管理员移除 Redis pending queue 中尚未被评测 Worker 领取的正式提交任务。

#### Scenario: 管理员成功移除待处理任务

- **WHEN** 管理员调用接口且指定提交仍在 pending queue 中
- **THEN** 系统从 pending queue 移除该任务并返回 HTTP 204
- **THEN** 系统保留提交记录，将其状态更新为 `error` 并记录完成时间
- **THEN** 系统发布 `queue:changed` 事件

#### Scenario: 任务已被领取或不存在

- **WHEN** 管理员调用接口但指定提交不在 pending queue 中
- **THEN** 系统返回 HTTP 404
- **THEN** 系统不改变提交状态

#### Scenario: 非管理员不能移除任务

- **WHEN** 未登录用户或普通用户调用接口
- **THEN** 系统分别返回 HTTP 401 或 HTTP 403
