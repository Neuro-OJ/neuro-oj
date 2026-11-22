# Runbook: 通用后台任务与教学投影

## 告警含义

通用后台任务的待领取积压、租约处理时长或终态失败数量持续异常，或者教学
`education_outbox` 投影事实长时间未完成。该路径覆盖评测派发以外的可恢复任务，
包括搜索索引和教学进度物化。

## 确认步骤

1. 查看 `noj_background_tasks_ready`、
   `noj_background_tasks_oldest_ready_age_seconds`、
   `noj_background_tasks_oldest_leased_age_seconds` 与
   `noj_background_tasks_failed`。
2. 查看 `noj_education_projection_pending` 与
   `noj_education_projection_oldest_age_seconds`，确认是否只有教学投影延迟。
3. 通过管理端后台任务列表按 `status`、`task_type` 查看具体任务的
   `last_error`、失败次数和去重键；确认 PostgreSQL 可用且没有长事务阻塞。
4. 若任务是教学投影，检查通用 worker 日志中是否有租约回收、分页游标或授权
   失败；不要重新启动已停用的旧教学 outbox worker。

## 缓解步骤

1. 先确认 worker 进程仍在运行；进程异常时按 Core 的优雅停止/启动流程恢复，
   让在途租约自然过期后重新领取。
2. 对可恢复的 `failed` 任务使用管理端“重试”，先确认 `last_error` 已处理；
   不要直接修改 `background_tasks` 或 `education_outbox` 表。
3. 若积压由数据库锁或容量造成，先解除根因再扩容 worker；不要并行启动旧教学
   worker，以免同一 outbox 事实被两套消费者处理。
4. Redis 中断时不需要人工补发教学事实；教学生产者与通用任务登记在同一
   PostgreSQL 事务中，Redis 恢复后只需让数据库 worker 继续领取。

## 恢复验证

- `noj_background_tasks_oldest_ready_age_seconds` 回落到 300 秒以下。
- `noj_background_tasks_failed` 回到 0，或剩余失败任务已有明确人工处置记录。
- `noj_education_projection_pending` 与最老年龄持续下降，最终回到 0 或业务允许
  的瞬时水平。
- 管理端任务状态显示为 `succeeded`，同一去重键没有重复任务；恢复后观察至少
  一个租约周期。

## 安全边界

任务 payload 只保存资源 ID、版本和分页游标，不应包含源码、答案、成绩或密钥。
任何需要改变任务状态的操作必须经任务仓库的 token/状态条件完成。
