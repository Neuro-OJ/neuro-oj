# 测试性能基线（suite=core）

- 命令：`deno task test:parallel --shards 4 --jobs 2 --profile`
- 工作目录：noj-core
- 重复次数：1
- 墙钟中位数：5m16s（范围 5m16s – 5m16s）
- 计时配置：commit=be1ee7b51826ebcec3fab1bde1a3482ad3b0db66 deno=2.9.8 os=linux/x86_64 ci=false profile=1

| 运行 | 退出码 | 墙钟 | 计时记录 | 累计阶段耗时 | JUnit tests | skipped | failures |
|---|---|---|---|---|---|---|---|
| #1 | 0 | 5m16s | 6825 | 880287.33ms | 2427 | 6 | 0 |

## 最近一轮阶段明细

# 阶段明细

生成时间：2026-11-03T00:37:12.362Z

## 运行清单

| suite | runId | command | commit | deno | jobs | shards | exit | duration |
|---|---|---|---|---|---|---|---|---|
| core | baseline_1793665916308_1 | deno run -A scripts/test-launcher.ts parallel --shards 4 --jobs 2 --profile | be1ee7b5 | 2.9.8 | 2 | 4 | 0 | 313241ms |

选中 434 个文件，实际执行 434 个文件。

## JUnit

| tests | failures | errors | skipped | 用时 |
|---|---|---|---|---|
| 2427 | 0 | 0 | 6 | 404279ms |

### JUnit 逐文件耗时

| 文件 | tests | failures | skipped | 用时 |
|---|---|---|---|---|
| src/modules/communication/community/tests/routes/community.test.ts | 20 | 0 | 0 | 13729ms |
| src/modules/evaluations/tests/routes/assignment-origin.test.ts | 6 | 0 | 0 | 7596ms |
| src/modules/education/tests/services/progress-worker.test.ts | 5 | 0 | 0 | 7021ms |
| src/modules/runtime/tests/tasks/lease-renewal.pg.test.ts | 4 | 0 | 0 | 3998ms |
| src/modules/communication/community/tests/services/community-contest-silence.test.ts | 5 | 0 | 0 | 3940ms |
| src/modules/read-models/search/tests/services/domain-search.test.ts | 6 | 0 | 0 | 3741ms |
| src/modules/communication/community/tests/services/community-official.test.ts | 5 | 0 | 0 | 3620ms |
| src/modules/evaluations/tests/routes/domain-submission-sse.test.ts | 3 | 0 | 0 | 3553ms |
| src/modules/evaluations/tests/services/domain-submission-read.test.ts | 3 | 0 | 0 | 3279ms |
| src/modules/education/tests/services/progress-read.test.ts | 3 | 0 | 0 | 2923ms |
| src/modules/communication/community/tests/services/domain-community.test.ts | 4 | 0 | 0 | 2920ms |
| src/modules/education/tests/services/notifications.test.ts | 3 | 0 | 0 | 2876ms |
| src/modules/education/tests/services/workbench.test.ts | 3 | 0 | 0 | 2783ms |
| src/modules/education/tests/services/feedback.test.ts | 3 | 0 | 0 | 2566ms |
| src/modules/evaluations/tests/routes/sse.test.ts | 5 | 0 | 0 | 2436ms |
| src/modules/access/identity/tests/routes/auth.test.ts | 33 | 0 | 0 | 2130ms |
| src/modules/education/tests/routes/notification-sse.test.ts | 2 | 0 | 0 | 2029ms |
| src/modules/read-models/search/tests/services/search-solution-gating.test.ts | 3 | 0 | 0 | 1890ms |
| src/modules/evaluations/tests/versioning/lock-order-policy-cross-contest.test.ts | 2 | 0 | 0 | 1678ms |
| src/modules/education/tests/services/classrooms.test.ts | 6 | 0 | 0 | 1563ms |

## 汇总

| 指标 | 值 |
|---|---|
| 计时记录 | 6825 |
| 涉及文件 | 0 |
| 累计阶段耗时 | 880287ms |
| 失败阶段 | 2 |
| JSONL 文件 | 285 |

## 阶段耗时（按累计降序）

| 阶段 | 次数 | 总计 | 中位数 | P95 | 最大 | 失败 |
|---|---|---|---|---|---|---|
| core.launcher.child | 4 | 575459ms | 143006ms | 171815ms | 171815ms | 0 |
| core.reset.truncate | 969 | 251703ms | 60ms | 692ms | 1711ms | 0 |
| core.reset.rbac | 970 | 28507ms | 28ms | 42ms | 80ms | 0 |
| core.reset.ownership-check | 972 | 6081ms | 0ms | 23ms | 31ms | 2 |
| core.reset.root | 970 | 5709ms | 5ms | 10ms | 40ms | 0 |
| core.reset.images | 970 | 3765ms | 4ms | 6ms | 20ms | 0 |
| core.launcher.redis-acquire | 4 | 2300ms | 591ms | 614ms | 614ms | 0 |
| core.reset.workspace | 970 | 2277ms | 2ms | 4ms | 9ms | 0 |
| core.launcher.cleanup | 1 | 2196ms | 2196ms | 2196ms | 2196ms | 0 |
| core.launcher.template-migration | 1 | 1657ms | 1657ms | 1657ms | 1657ms | 0 |
| core.launcher.db-clone | 4 | 380ms | 103ms | 116ms | 116ms | 0 |
| core.reset.rankings-refresh | 11 | 192ms | 17ms | 24ms | 24ms | 0 |
| core.launcher.template-seed | 1 | 41ms | 41ms | 41ms | 41ms | 0 |
| core.launcher.discover | 2 | 10ms | 5ms | 5ms | 5ms | 0 |
| core.launcher.bootstrap-redis-check | 1 | 5ms | 5ms | 5ms | 5ms | 0 |
| core.launcher.plan | 2 | 3ms | 2ms | 2ms | 2ms | 0 |
| core.launcher.baseline | 2 | 2ms | 1ms | 2ms | 2ms | 0 |
| core.reset.invocations | 971 | 0ms | 0ms | 0ms | 0ms | 0 |

## 最慢文件

暂无文件级记录。

## 最慢用例

| 用例 | 文件 | 次数 | 累计 | 最大单次 |
|---|---|---|---|---|
| shard:shard3 | - | 3 | 172522ms | 171815ms |
| shard:shard1 | - | 3 | 148408ms | 147761ms |
| shard:shard2 | - | 3 | 138870ms | 138250ms |
| shard:shard4 | - | 3 | 118339ms | 117634ms |

## 计数阶段

| 阶段 | 次数 |
|---|---|
| core.reset.invocations | 971 |

## 数据质量

- 坏行：0
- 坏文件：0
- 缺少 manifest：否
