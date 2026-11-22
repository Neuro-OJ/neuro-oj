# Agent Note: #726 教学事件统一到 background_tasks，删除 education_outbox

Status: implemented

## Problem

教学事件在两张表里各登记一次：`education_outbox` 保存事实定位、分页游标、
租约和通知投递进度，同事务再登记一条 `education.recompute` 通用任务负责调度。
通用 worker 领取任务后，还要回到 outbox 再做一次租约领取，两套租约、两套重试
状态并存。旧的批量消费循环 `startEducationWorker` / `processEducationBatch`
在生产中已不启动，只剩测试在用。

outbox 不能直接删除，因为它还承担：

- `notifications.event_id` 外键与 `(event_id, recipient_id)` 投递去重；
- `assignment.refresh` 的「同作业×学生只保留一条未处理刷新」部分唯一索引；
- 比赛结束前延迟公开成绩的 `_invalidate_on_claim` 标记，以及比赛改期时重排；
- 按页推进的 `_education_cursor` / `_notice_after` 游标。

## Decision

- 教学事件就是一条 `education.recompute` 任务（`payload_version = 2`）。payload
  自包含：`event_id`、`domain_id`、`event_type`、`user_id`、`problem_id`、
  `classroom_id`、`assignment_id`，以及 `data`（原 outbox payload：附加信息、
  游标、到期失效标记）。去重键 `event:<event_id>`。
- 处理器
  `processEducationTask`（`education/services/progress-worker.ts`）直接注册
  到通用 worker；每次领取处理一页，未完成时返回 reschedule，由 worker 以租约为
  条件写回新 payload。删除 `application/education-handlers.ts` 适配层。
- 通知投递处理一页期间不持有任务行锁（否则挡住续租，慢页会因租约到期整页回滚），
  只在提交前复核租约：非末页用 `updateLeasedTaskPayloadTx` 推进
  `_notice_after`， 末页用 `lockLeasedTaskTx`；租约已失效则整页回滚并返回
  `lease_lost`。并发接手 由 `(event_id, recipient_id)` 唯一约束去重。幂等键改为
  payload 的 `event_id`， `notifications.event_id` 不再有外键。
- `_invalidate_on_claim`：先以租约为条件清除标记（同时锁住任务行），再递增投影
  版本，同一事务提交；之后租约即使到期，接手者也不会重复失效。
- 重算页的 `education:sync`
  与游标在同一受租约保护的事务内持久化（`recordSseEvent`），
  提交后再广播；失去租约时不推送。
- `assignment.refresh` 用新的 `enqueueOrReviveTaskTx`：去重键
  `refresh:<user_id>`，已有 pending / leased 任务时合并，已终结的任务原地复活。
- `claimTasks` 增加可选的任务类型过滤，测试据此只排空教学任务
  （`education/tests/_education-tasks.ts`）。
- 教学投影观测改为统计已到期未完成的 `education.recompute` 任务。
- 迁移 `0145`：先补登记缺任务的未处理 outbox 行，把未完成的 v1 任务改写为 v2
  payload（`event_id` 沿用原 outbox id），未完成的刷新改用 `refresh:<user_id>`
  去重键（升级后新请求与之合并），其余 v1 任务收尾为 succeeded，再删除外键与
  `education_outbox` 表。存量语义由
  `tests/db/issue726_education_task_migration_test.ts` 覆盖。
- 处理器暂留
  `modules/education`：它依赖教学模块内部的学情物化与通知服务，单独迁到
  `features/` 需要并存一个 `features/education` 并从旧模块导出内部服务；教学模块
  整体迁移时一起搬。

## Alternatives considered

- **保留 outbox，只删除通用任务那一份**：会退回到教学专用 worker，与搜索、
  派发等任务的统一租约、退避、管理端重试割裂。
- **通知幂等键直接用任务 id**：迁移时进行到一半的通知事件会换身份，已投递的
  收件人可能重复收到；payload 中的 `event_id` 可以沿用原 outbox id。
- **refresh 用普通 `enqueueTaskTx`**：通用去重键对所有状态生效，第一次刷新完成后
  同一作业×学生再也无法触发刷新。

## Consequences

- 教学事件只有一套租约与重试状态，失败任务可在管理端后台任务列表中统一重试。
- `background_tasks` 中成功的教学任务会保留（与原 outbox 已处理行一样）；refresh
  任务因原地复活不会随读取次数增长。
- 旧教学批量 worker 与相应测试（慢邮件与学情共用循环）一并删除；邮件投递循环
  `startEducationEmailWorker` 不受影响。
- E2E `education_outbox_recovery.test.ts` 改名为
  `education_task_recovery.test.ts`， 直接重放 v2 任务验证重启恢复。
- 租约集成测试以 PostgreSQL 的锁等待和数据库时钟协调并发，取锁由数据库限时；
  失败时先释放锁，再等待处理器和续租任务结束。0145 测试先走标准数据库重置，
  并在旧表夹具部分初始化失败时也执行清理。
