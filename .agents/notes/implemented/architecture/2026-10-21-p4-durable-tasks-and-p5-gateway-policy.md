# Agent Note: P4 持久后台任务与 P5 Gateway 政策本地权威

Status: implemented

## Problem

P3 收口后仍有三类"提交后尽力而为"的可靠性缺口：

1. **评测派发**：`submissions` 与 attempt 在事务里提交，随后才 `LPUSH` 到 Redis；
   进程在两步之间退出会留下永久 pending 的提交，只能等 sweeper 按超时兜底。
2. **搜索索引**：`publishSearchIndexEvent` 在提交后 LPUSH，失败只记日志；索引会
   无声落后，且没有对账入口。
3. **教学 outbox**：教学失效事实有自己的 lease/attempts/游标实现，与评测、搜索
   各写一套，恢复语义不一致。

P5 侧的问题是 Gateway 每次调用都要 fetch Core 的 `/api/v1/internal/llm/quota-caps`：

- Core 不可达 → 整条 LLM 链路 503；
- 政策读取发生在 Provider 排队之前，排队结束后用的是可能已经过时的上限；
- Core 保留第二份可写权威，降额与预占的先后不确定。

## Decision

**P4：新增通用持久任务表，业务事实与任务同事务提交。**

- `background_tasks`（owner: runtime）字段固定：类型、目标种类/ID、业务去重键、
  payload 版本、pending/leased/succeeded/failed、available_at、连续失败次数、
  lease token/owner/expiry、脱敏错误与结果时间戳。
- 唯一键 `task_type + target_kind + target_id + dedupe_key`：同键重复登记返回既有
  任务，不重复登记、不覆盖 payload。
- `claimTasks` 用 `FOR UPDATE SKIP LOCKED`；过期租约回收时计一次失败，
  连续失败 20 次转终态 `failed`（退避 5s→…→上限 5 分钟）。
- `enqueueTaskTx` / `completeTaskTx` / `failTaskTx` 都接收真实 `DbTx`；
  跨模块调用只能由 application 发起。
- 评测派发任务在**提交事务内**登记（dedupeKey = attempt id），提交后由
  `handleEvaluationDispatchTask` 从数据库事实重建 JudgeTask；Redis 可重试错误交给
  退避，永久错误标记平台错误后结束，不无限重试。
- 搜索索引任务在业务事务内登记（`enqueueSearchIndexTaskTx`），handler 从最新事实
  构造索引，因此乱序/重复/删除都幂等收敛。
- 教学 outbox 通过 `migrateEducationOutboxTx` 幂等映射到 `education.recompute` 任务，
  去重键用 outbox id，保留失败次数、可领取时刻与分页游标；已处理行不迁移。
- 任务管理路由 `/api/v1/admin/background-tasks` 提供列表、健康快照、详情与
  人工重试（写审计 `background_task.retry`）。
- 教学 outbox 在 Core 启动时按 `(created_at, id)` 稳定游标迁入通用任务；教育事实登记与
  通用任务登记在同一个 `DbTx` 中提交。生产组合根只启动通用任务 worker，邮件投递与
  预约发布保留为两个独立的周期任务，旧的教学进度 worker 不再进入生产装配。
- 通用 worker 对分页 handler 支持显式 `reschedule`，启动时校验全部任务类型均有
  handler；真实 PostgreSQL 测试覆盖子进程在完成标记前退出后的租约回收，以及
  `stop()` 等待在途 handler 完成的 drain。
- 后台任务健康和教学投影延迟通过平台 snapshot 写入 Prometheus gauge，并由
  `deploy/monitoring/runbooks/background-tasks.md` 与三条告警规则提供运维处置路径。

**P5：Gateway 成为实例政策的唯一可写权威。**

- `llm_policy` 单行持久政策（revision 0 = 从未写入），`llm_policy_operations`
  记录 operation ID、请求摘要、预期/实际 revision、结果与授权管理者。
- `PUT /internal/policy` 要求 operation ID + 预期 revision + actor：
  同 ID 同请求返回原结果、同 ID 不同请求 `OPERATION_CONFLICT`、旧 revision 409；
  政策、操作结果同事务提交。
- `loadCurrentQuotaCaps` 改读本地政策，不再 fetch Core；Core 离线时仍可读取。
- Core 侧新增 `exportGatewayPolicySnapshot` / `importGatewayPolicySnapshot` /
  `readGatewayPolicy`，导入使用稳定 operation ID（政策摘要），重复导入不覆盖新政策。
- 旧 Core 端点 `/api/v1/internal/llm/quota-caps` 标注 `Deprecation`/`Sunset`，
  只作迁移期只读归档与旧 Gateway 兼容，不再被正常业务路径调用。
- 预占步骤在账本边界（`withReservationLock`）内调用 `readPolicyForReservation`
  读取本地政策；路由层在 Provider 排队之前不再预读政策，也不存在
  `domainQuotaCaps` 注入点，因此排队期间提交的降额对本次新预占生效。
  `FOR SHARE` 读与政策写入的事务级 `FOR UPDATE` 互斥；另外，
  `accounting.ts::withReservationLock` 持有共享 advisory 锁，
  `policy-operations.ts::withLockedPolicy` 持有同键事务级排他 advisory 锁，
  因此整个预占边界的政策版本顺序由 `pg_advisory_*_lock(184789, 4)` 冻结。
  该语义由真实 PostgreSQL 屏障测试验证。

## Alternatives considered

- **只给评测加 Redis 重试**：无法覆盖进程崩溃、搜索与教学三类事实，也无法统一
  运维可见性。
- **用 `submission_jobs` 承载所有后台任务**：会把业务进度表变成通用队列表，
  丢失各自的业务语义（条目、attempt、游标），因此明确不替换。
- **Gateway 缓存 Core 政策 + TTL**：降额生效仍要等 TTL，且 Core 仍是权威，
  与"Core 离线可用"矛盾。
- **政策写入走 Core 再转发**：等于保留双写与第二份权威，迁移期风险更高。

## Consequences

- 评测派发、搜索索引、教学重算现在都有可恢复事实，进程崩溃后重启即可继续；
  Redis 只作为唤醒提示。
- 任务积压、最老年龄、失败数可通过管理路由与 `readTaskHealth` 观测；
  人工重试有审计，不抢占有效租约。
- Gateway 不再依赖 Core 可用性读取政策；降额与预占通过同一政策行锁确定先后。
- P5.3 已完成：降额/预占真实并发屏障、流式中断与 unknown、ready 故障和 drain
  均有真实 PostgreSQL/Redis 验收证据；后续剩余工作为 P6–P8。
- 迁移 0120/0121（Core）与 `20261021105927`（Gateway）均由 drizzle-kit 生成；
  Gateway 迁移中重复生成的历史 provider 列 ALTER 已移除并写明原因（历史 manifest
  已添加该列，重复执行会 duplicate column）。
