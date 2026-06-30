## Purpose

定义管理员发起提交重测功能的规范，包括单条重测和按题目批量重测，重测使用最新题目评测配置。

## Requirements

### Requirement: 管理员可通过 API 发起提交重测

系统 SHALL 在 `POST /api/v1/admin/submissions/:id/rejudge` 端点提供提交重测功能，该端点依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 管理员成功发起重测

- **WHEN** 已登录管理员调用 `POST /api/v1/admin/submissions/:valid-id/rejudge`
- **THEN** 系统重置该提交状态为 pending，清除旧评测结果，重新推送评测任务到 MQ 队列，返回 HTTP 200 及 `{ message, submission_id }`

#### Scenario: 重测不存在的提交

- **WHEN** 管理员调用 `POST /api/v1/admin/submissions/:missing-id/rejudge`
- **THEN** 系统返回 HTTP 404

#### Scenario: 非管理员发起重测

- **WHEN** 普通用户调用 `POST /api/v1/admin/submissions/:id/rejudge`
- **THEN** 系统返回 HTTP 403

#### Scenario: 重测已删除题目的提交

- **WHEN** 管理员对某提交发起重测，但该题已被删除
- **THEN** 系统返回 HTTP 404（题目不存在）

### Requirement: 重测使用题目最新评测配置

系统 SHALL 在重测时从数据库重新获取题目的 `judge_image`、`judge_command`、`time_limit_ms`、`memory_limit_mb`，并从磁盘重新读取 `support_package_path` 对应的支持包 zip。

#### Scenario: 题目配置已更新

- **WHEN** 题目评测镜像或时间限制已在原提交后被修改
- **THEN** 重测使用更新后的评测配置

#### Scenario: 支持包已更新

- **WHEN** 题目支持包 zip 内容已在原提交后被修改
- **THEN** 重测将新支持包编码为 Base64 发送给 judge

#### Scenario: 支持包读取失败

- **WHEN** 题目未配置支持包路径或文件无法读取
- **THEN** 重测继续进行，不发送支持包（由 judge 端自行处理）

### Requirement: 重测清除旧评测结果

系统 SHALL 在事务中原子删除旧的 `evaluation_results` 记录并将提交状态重置为 `pending`。

#### Scenario: 已完成的提交被重测

- **WHEN** 一条 status=finished 的提交被重测
- **THEN** 系统删除对应 evaluation_results，重置 judge_started_at 和 judge_finished_at 为 NULL

#### Scenario: 评测中的提交被重测

- **WHEN** 一条 status=judging 的提交被重测（如 judge worker 故障导致卡住）
- **THEN** 系统重置状态为 pending 并重新推送评测任务

### Requirement: 重测完成后发布队列变更事件

系统 SHALL 在成功推送评测任务后通过 Redis Pub/Sub 发布队列变更事件（频道 `noj:events:queue`），触发前端实时刷新。

#### Scenario: 队列变更事件发布

- **WHEN** 重测任务成功推送到 Redis MQ
- **THEN** 系统调用 `publishEvent(Channels.queue, ...)` 通知所有订阅者

### Requirement: 管理员可按题目批量重测

系统 SHALL 在 `POST /api/v1/admin/problems/:id/rejudge` 端点提供批量重测功能，对某题所有指定状态的提交执行重测。

#### Scenario: 成功批量重测

- **WHEN** 已登录管理员调用 `POST /api/v1/admin/problems/:valid-id/rejudge`，且该题**没有** pending/judging 的提交
- **THEN** 系统重测该题所有 status 为 finished 和 error 的提交，返回 HTTP 200 及 `{ message, problem_id, total, queued, skipped }`

#### Scenario: 批量重测因活跃提交被拒绝

- **WHEN** 管理员调用 `POST /api/v1/admin/problems/:id/rejudge`，但该题下有 pending 或 judging 状态的提交
- **THEN** 系统返回 HTTP 400，错误信息包含正在评测中的提交数量

#### Scenario: 题目无提交可重测

- **WHEN** 管理员批量重测某题，但该题没有 finished 或 error 的提交（且未传 include_all）
- **THEN** 系统返回 `{ total: 0, queued: 0, skipped: 0 }`，200

#### Scenario: 批量重测事务一致性

- **WHEN** 批量重测过程中某条入队失败
- **THEN** 失败的提交不会被推进到 judging 状态（停留在 pending），其他提交正常处理。返回结果中 queued 数 < total 数
