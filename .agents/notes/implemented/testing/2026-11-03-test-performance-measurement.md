# Agent Note: 测试性能测量、运行清单与按文件分片

Status: implemented

## Problem

测试提速缺少可归因的数据。墙钟变化无法区分三种情况：测试变少、单用例变快、
并行度增加；Core 的 `test:parallel` 只把目录手抄成两片，且 `--shards 1` 通过截断
清单实现，会静默漏掉业务测试。没有阶段计时、运行清单或 JUnit
聚合，任何"优化有效" 的结论都无法复核。

## Decision

- 新增 `scripts/lib/test-timing.ts`：`measurePhase()` 用 `performance.now()`
  记录 阶段耗时，异常经 `finally` 记录后原样抛出；每个测试 isolate 写独立 JSONL
  （文件名含 shard、PID、随机标识），默认关闭，只有启动器 `--profile` 才落盘。
- 启动器写 `manifest.json`（命令、提交、Deno 版本、并发度、发现/选择/执行文件、
  JUnit、canary、退出码）与 JUnit；`scripts/test-performance-report.ts`
  聚合阶段、 文件、用例与 JUnit，并提供前后对比（单独列出 tests
  数与每条记录平均耗时）。
- Core 分片改为"发现实际测试文件 → 排除登记的 perf → 去重 → 按文件耗时降序分配到
  当前累计最少的分片"。`--shards N` 划分全部所选测试，`--jobs M` 控制并发，
  `--dry-run` 不读取 `TEST_*`；`tests/00_migrate_test.ts`
  是唯一允许跨片重复的例外。
- `dev-docs/engineering/test-duration-baseline.json`
  保存文件级耗时；未知文件用基线 中位数估值，计划在任何 child
  启动前写入报告目录，并由覆盖守卫断言每个文件恰好一次。

## Alternatives considered

- 只记录进程墙钟：无法归因，且并行度变化会掩盖内部低效。
- 所有 isolate 写同一个 JSONL：并发写会互相覆盖；加锁又会引入新的排队成本。
- 继续按目录分片：目录清单会随模块迁移过时，且无法按耗时均衡。
- 用数据库事务回滚替代 reset：需要改生产事务边界，超出测试基础设施范围。

## Consequences

- 性能结论必须附带原始
  JSONL/manifest/JUnit；报告区分"测试变少/单用例变快/并行度增加"。
- 当前文件级基线是首轮估算值，P0 实测后应替换同一结构的真实中位数；替换前分片
  只保证覆盖与确定性，不宣称最优均衡。
- `--shards 1` 现在必须包含全部测试，旧的截断行为已由守卫测试禁止。
- 每次正式运行多一次 manifest/JUnit 写入；`--profile` 关闭时不产生计时文件。
