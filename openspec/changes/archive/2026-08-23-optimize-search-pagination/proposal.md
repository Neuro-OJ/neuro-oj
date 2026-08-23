# 优化全局搜索分页与性能基准

## Why

Issue #252 中的 main CI 性能基准以 `测试` 查询 100k 道题目，而该词出现在每一条种子数据标题中。查询需要排序并额外执行精确 `COUNT(*)`，在 GitHub Hosted Runner 上测得 625.86ms，超过 500ms 阈值。该测试把广泛匹配的最坏情况与常见的高选择性搜索混为一谈，容易因运行器波动误报；而常规 API 请求也为计算 UI 未使用的精确总数付出了全表扫描成本。

## What Changes

- 全局搜索默认返回 `has_more`，以 `limit + 1` 条结果判断下一页；不再默认计算 `total`。
- `include_total=true` 允许调用方显式获取精确总数，保持需要总数的兼容路径。
- 前端搜索页改为依据 `has_more` 分页，不再依赖总数计算总页数。
- 性能基准拆分高选择性和全命中情景；高选择性情景保留严格预算，全命中情景以独立、较宽松预算监控。

## Impact

- `noj-core/src/services/search.ts`、`noj-core/src/routes/search.ts`：搜索响应与查询策略。
- `noj-core/tests/services/search.test.ts`、`noj-core/tests/routes/search.test.ts`、`noj-core/tests/perf/search_bench.test.ts`：契约和性能覆盖。
- `noj-ui/pages/search.vue`：以 `has_more` 驱动分页。
- `openspec/specs/global-search/spec.md`：搜索分页契约。
