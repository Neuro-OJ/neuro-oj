# Agent Note: 搜索索引统一到 PostgreSQL 后台任务，移除 Redis 搜索队列

Status: implemented

## Problem

Issue #698 N1：rc/v0.11 的搜索索引同时走两条链路。

- 新链路：`application/search-tasks.ts` 的
  `enqueueSearchIndexTaskTx`，在业务事务内登记 `search.index`
  后台任务，可重试、不丢失；只有题目发布与复制在用。
- 旧链路：`shared/search-events.ts` 的 `publishSearchIndexEvent`，向 Redis 列表
  `noj:search:index` 非阻塞
  LPUSH，失败只记日志（注释原话"本次事件可能丢失"）。题目、标签、提交、用户、竞赛、公告、私信、社区等
  34 处调用仍走这条路。`publish.ts` 两条都走。

后果：维护两套消费者；同一实体会被重复索引；Redis
抖动时索引更新被静默丢弃，只能靠 `search reindex` 全量对账。

## Decision

1. `application/search-tasks.ts` 新增
   `enqueueSearchIndexTask(entityType, entityId, action, db?)`：
   - `db` 可以是根连接，也可以是调用方正在进行的业务事务；内部用
     `db.transaction(...)` 登记，传入事务时成为
     savepoint，任务随外层事务提交，worker 不会在业务提交前读到旧事实；
   - 每次调用生成独立事件 ID 作为去重键，不与已在执行的任务合并，handler
     读最新事实保证收敛；
   - 登记失败只记错误日志、只回滚
     savepoint，不向调用方抛出（业务写入通常已提交）。
2. 34 处 `publishSearchIndexEvent` 全部改为
   `enqueueSearchIndexTask`。`contests.ts` 的函数接收调用方 executor，传入
   `db`；社区 `publishCommunitySearchEvent` 改为
   async，在授权事务（`communityDb(scope)`）内登记，取代原 `afterCommit`
   推迟发布，回滚时任务一并回滚。
3. `publish.ts` 删除提交后的重复通知，只保留事务内登记。
4. 删除
   `publishSearchIndexEvent`、`SEARCH_INDEX_QUEUE`、`SearchIndexEvent`、`read-models/search/consumer/search-index-consumer.ts`
   及其测试与启动登记；`shared/search-events.ts` 只保留 `SearchEntityType` /
   `SearchIndexAction` 类型。
5. `background_tasks` 原本没有任何保留清理。新增 `cleanupSucceededSearchTasks`
   与 `startSearchTaskRetentionTask`（启动执行一次，之后每 24 小时），只删除 7
   天前已成功的 `search.index`
   任务。其他任务类型的去重键承载业务幂等语义，失败任务保留供排查，均不清理。
6. 测试辅助 `tests/helper/search-events.ts` 改为查询
   `background_tasks`，不再轮询 Redis 列表；同步更新数据字典与 noj-core
   模块文档。

## Alternatives considered

- 保留 `publishSearchIndexEvent` 名称、在 shared 内直接插入
  `background_tasks`：shared 会反向依赖 runtime
  的任务合同，违反分层；且函数名会继续暗示"发布到队列"。
- 让 34 处调用全部改为在各自业务事务内调用
  `enqueueSearchIndexTaskTx`：大部分调用点在事务提交之后，改造需要逐个重排事务边界，风险和改动量都远大于收益。提交后用根连接登记已经消除
  Redis 丢事件问题。
- 对所有任务类型做保留清理：`evaluation.dispatch`、教学 outbox
  迁移等依赖去重键防止重复登记，删除后可能被重新登记，因此只清理去重键为一次性事件
  ID 的搜索任务。

## Consequences

- 搜索索引不再依赖 Redis：Redis 不可用时索引更新仍会登记，由任务
  worker（每秒轮询）执行。
- 提交后登记依旧不是与业务写入原子的（极端情况下进程在两者之间崩溃会漏登记），但窗口从"Redis
  任意抖动"缩小为"提交与一次 INSERT 之间崩溃"，仍可用 `search reindex` 对账。
- 每次提交、评测结果等都会新增一条任务行，由 7 天保留清理控制表规模。
- 升级后 Redis 中残留的 `noj:search:index*` 键不再被消费，可直接删除。
