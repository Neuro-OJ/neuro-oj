## Why

搜索性能基准会写入十万条题目；在本地误连开发数据库时会污染题库，且测试结束后没有清理。

## What Changes

- 性能基准默认在结束时清理测试数据。
- 外部 PostgreSQL 连接必须显式确认才可运行性能基准。
- 提供保留数据开关供人工分析。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `ci-optimization`: 性能基准的数据隔离与清理行为。

## Impact

- `noj-core/tests/perf/search_bench.test.ts`
- `.github/workflows/ci.yml`
