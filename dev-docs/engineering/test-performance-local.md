# Core 测试性能实测（本地，2026-11-03）

> 环境：Deno 2.9.8（本机；仓库 .dvmrc 为 2.9.5）、PostgreSQL + Redis 本地容器、--shards 4 --jobs 2 --profile。
> 这是本地证据，不是 CI 正式基线；CI 基线与三次重复测量仍需在固定版本 Runner 上生成。

生成时间：2026-11-03T00:28:13.554Z

## 运行清单

| suite | runId | command | commit | deno | jobs | shards | exit | duration |
|---|---|---|---|---|---|---|---|---|
| core | rmvzy1bjs3ececa35bf9e | deno run -A scripts/test-launcher.ts parallel --shards 4 --jobs 2 --profile | be1ee7b5 | 2.9.8 | 2 | 4 | 0 | 321927ms |

选中 434 个文件，实际执行 434 个文件。

## JUnit

| tests | failures | errors | skipped | 用时 |
|---|---|---|---|---|
| 2427 | 0 | 0 | 6 | 418093ms |

### JUnit 逐文件耗时

| 文件 | tests | failures | skipped | 用时 |
|---|---|---|---|---|
| src/modules/communication/community/tests/routes/community.test.ts | 20 | 0 | 0 | 13574ms |
| src/modules/evaluations/tests/routes/assignment-origin.test.ts | 6 | 0 | 0 | 7391ms |
| src/modules/education/tests/services/progress-worker.test.ts | 5 | 0 | 0 | 5744ms |
| src/modules/evaluations/tests/routes/domain-submission-sse.test.ts | 3 | 0 | 0 | 3903ms |
| src/modules/runtime/tests/tasks/lease-renewal.pg.test.ts | 4 | 0 | 0 | 3788ms |
| src/modules/read-models/search/tests/services/domain-search.test.ts | 6 | 0 | 0 | 3765ms |
| src/modules/communication/community/tests/services/community-official.test.ts | 5 | 0 | 0 | 3748ms |
| src/modules/evaluations/tests/services/domain-submission-read.test.ts | 3 | 0 | 0 | 3571ms |
| src/modules/education/tests/services/progress-read.test.ts | 3 | 0 | 0 | 3268ms |
| src/modules/communication/community/tests/services/community-contest-silence.test.ts | 5 | 0 | 0 | 3154ms |
| src/modules/education/tests/services/notifications.test.ts | 3 | 0 | 0 | 3119ms |
| src/modules/communication/community/tests/services/domain-community.test.ts | 4 | 0 | 0 | 2960ms |
| src/modules/read-models/search/tests/services/search-solution-gating.test.ts | 3 | 0 | 0 | 2787ms |
| src/modules/education/tests/services/workbench.test.ts | 3 | 0 | 0 | 2737ms |
| src/modules/education/tests/services/feedback.test.ts | 3 | 0 | 0 | 2547ms |

## 汇总

| 指标 | 值 |
|---|---|
| 计时记录 | 6825 |
| 涉及文件 | 0 |
| 累计阶段耗时 | 919387ms |
| 失败阶段 | 2 |
| JSONL 文件 | 285 |

## 阶段耗时（按累计降序）

| 阶段 | 次数 | 总计 | 中位数 | P95 | 最大 | 失败 |
|---|---|---|---|---|---|---|
| core.launcher.child | 4 | 596535ms | 150489ms | 173836ms | 173836ms | 0 |
| core.reset.truncate | 969 | 265729ms | 61ms | 746ms | 2038ms | 0 |
| core.reset.rbac | 970 | 31891ms | 29ms | 56ms | 260ms | 0 |
| core.reset.root | 970 | 6191ms | 5ms | 11ms | 102ms | 0 |
| core.reset.ownership-check | 972 | 6073ms | 0ms | 22ms | 35ms | 2 |
| core.reset.images | 970 | 4490ms | 4ms | 8ms | 142ms | 0 |
| core.reset.workspace | 970 | 2267ms | 2ms | 4ms | 13ms | 0 |
| core.launcher.cleanup | 1 | 2208ms | 2208ms | 2208ms | 2208ms | 0 |
| core.launcher.redis-acquire | 4 | 1813ms | 453ms | 501ms | 501ms | 0 |
| core.launcher.template-migration | 1 | 1575ms | 1575ms | 1575ms | 1575ms | 0 |
| core.launcher.db-clone | 4 | 381ms | 97ms | 127ms | 127ms | 0 |
| core.reset.rankings-refresh | 11 | 178ms | 16ms | 19ms | 19ms | 0 |
| core.launcher.template-seed | 1 | 39ms | 39ms | 39ms | 39ms | 0 |
| core.launcher.discover | 2 | 9ms | 5ms | 5ms | 5ms | 0 |
| core.launcher.bootstrap-redis-check | 1 | 5ms | 5ms | 5ms | 5ms | 0 |

## 最慢文件

暂无文件级记录。

## 最慢用例

| 用例 | 文件 | 次数 | 累计 | 最大单次 |
|---|---|---|---|---|
| shard:shard3 | - | 3 | 174388ms | 173836ms |
| shard:shard1 | - | 3 | 156255ms | 155745ms |
| shard:shard2 | - | 3 | 145768ms | 145234ms |
| shard:shard4 | - | 3 | 122319ms | 121721ms |

## 计数阶段

| 阶段 | 次数 |
|---|---|
| core.reset.invocations | 971 |

## 数据质量

- 坏行：0
- 坏文件：0
- 缺少 manifest：否
