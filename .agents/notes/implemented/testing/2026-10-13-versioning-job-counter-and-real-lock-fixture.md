# Agent Note: 批任务夹具原子题号与真实跨连接领取检查

Status: implemented

## Problem

全量 PostgreSQL 回归中，批任务并发夹具从 1000 个随机题号中选择， 触发
`problems_domain_number_unique` 冲突。该文件为真实事务关闭 preload
回滚包装，多道题同时保留时，随机编号不能提供唯一性。

现有双 worker 用例通过 Promise.all 发起两次领取，但测试主连接池为 max:1，
两次事务仍按同一物理连接执行。这能检查领取不重复，不能证明不同连接持锁期间的
SKIP LOCKED 行为。

## Decision

建题夹具使用真实 `domains.next_problem_number`，单条原子 UPDATE 增加计数器，
RETURNING 返回本次题号，不扩大随机范围或在冲突后重试。
保持题目、版本与提交关联，沿用已发布绑定和本文件显式清理。 删除夹具不回收题号。

新增只在真实 PostgreSQL 运行的跨连接回归，复用既有
`tests/helper/pg-raw-connection.ts` 的原生事务 helper：

- 主连接和持锁连接的 `pg_backend_pid()` 必须不同，`current_schema()`
  都必须等于测试配置中的 TEST_SCHEMA。
- 关闭 preload 包装后的题目、提交和两个任务条目已提交，外连接可见两条记录。
- 外连接对首条任务保持 FOR UPDATE 行锁，调用实际 core `claimJobItems()`
  必须在两秒期限内取到第二条，不等待首条锁，也不重复领取首条。
- 外连接提交释放锁后，下一次实际领取必须取到首条。 数据库中的两条 preparing
  状态和各自 lease owner 必须符合实际领取结果。

保留原双 worker 去重回归，并修正文案，将它与新增跨连接锁证据区分。
不改变生产连接池、worker 实现、Schema 或全局测试配置。

## Alternatives considered

- 增大随机题号范围或捕获碰撞后重试：仍不能保证唯一，改用实际域计数器。
- 为所有测试增加连接池容量：会改变事务隔离基础设施，独立原生连接只用于实锁检查。
- 只保留 Promise.all
  与去重断言：单连接不能提供真实持锁竞争证据，增加物理连接与行锁验证。
- 复制领取 SQL 模拟 worker：无法检查实际生产入口，持锁时调用真实
  `claimJobItems()`。

## Consequences

2026-10-13 在专用 PostgreSQL 回归库、独立 `client_job_counter_fixture_1` schema
和临时 Redis DB 中，使用标准 `deno task test:domain submission`
过滤本文件的租约、派发、聚合和清理名称， 得到 9 passed、0 failed、381 filtered
out，耗时 40 秒。 新增跨连接行锁用例实际完成，耗时 72 毫秒。

同一标准入口的 PGlite 检查为 5 passed、0 failed、4 ignored、 381 filtered
out，耗时 43 秒。四个忽略项是明确需要真实 PostgreSQL 的去重、
实锁、聚合和独立清理，不将其记为 PGlite 并发通过。 测试文件通过 deno
check、格式与 lint，本记录通过 Agent Note 校验。

上述结果是本文件的定向验证，不表示其余 submission 用例或整个 core 全量已通过。
没有使用开发库，也没有重启服务或修改生产数据。
