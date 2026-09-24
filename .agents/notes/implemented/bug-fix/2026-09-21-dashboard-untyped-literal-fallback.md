# Agent Note: 看板门禁的指标兜底把调用点字面量当作定义（恒真断言）

Status: implemented

## Problem

`scripts/check-dashboards.ts` 的 `collectDefinedMetrics` 在按 `name: "noj_..."` +
`type` 提取真实定义之后，还有一条"兜底"：

```ts
// 兜底：只出现名字（可能定义在别处或以常量形式）
for (const m of content.matchAll(/"(noj_[a-z0-9_]+)"/g)) {
  if (m[1] && !defined.has(m[1])) defined.set(m[1], "unknown");
}
```

它把源码里**出现过的任何 `"noj_..."` 字面量**都登记为"已定义"，包括调用点
（`inc("noj_typo_metric_xyz")`）。于是 `checkExpression` 的
`if (!type) problems.push("引用了未定义的指标")` 永不触发——dashboard 引用任意
拼错或自造的指标都能通过门禁，形成恒真断言。

触发条件：在 `noj-core/src/` 任意位置写入一个自造字面量

```ts
const x = "noj_typo_metric_xyz";
```

然后在 dashboard 里引用它，门禁仍判通过（实测）。

同一缺陷在 `scripts/check-metrics.ts` **早已被修复**，其注释明确记录：

```
已知集合只取**指标定义表** META 里的键（`name: { help: ..., type: ... }`），
不能用「网关源码里出现过的任何 noj_* 字面量」——那会把拼错的调用点也当作
定义，形成恒真断言（实测：把调用点改成 noj_typo_metric_xyz 仍判通过）。
```

本次是把同一防护补到 `check-dashboards.ts`（此前遗漏）。

实测（修复前，单测）：

```
collectDefinedMetrics: 调用点字面量不得被当作指标定义 ... FAILED
error: AssertionError: 调用点字面量不得被登记为已定义（否则门禁恒真）
collectDefinedMetrics: 真实仓库不产生 unknown 兜底条目 ... FAILED
error: AssertionError: 不应有仅凭字面量登记的 unknown 条目，实际
  [["noj_oauth_state","unknown"],["noj_api_error_rate_percent","unknown"],
   ["noj_api_average_latency_ms","unknown"],["noj_observability_write_errors_total","unknown"],
   ["noj_observability_metric_dropped_total","unknown"]]
```

## Decision

把兜底正则从 `"noj_..."` 收紧为 `name: "noj_..."`（与主定义的字段形式一致）：

```ts
for (const m of content.matchAll(/name:\s*"(noj_[a-z0-9_]+)"/g)) {
  if (m[1] && !defined.has(m[1])) defined.set(m[1], "unknown");
}
```

本仓库所有业务/平台指标都以 `name: "..."` 字段定义（41 处，覆盖
`domains/*/observability.ts` 与 `domains/observability/metrics/platform.ts`），
因此真实定义仍被发现（真实仓库 `unknown` 条目 5 → 0），而调用点字面量不再被
误认。

回归用例（`scripts/check-dashboards_test.ts`）新增 2 条：夹具中"定义 vs 调用点"
的区分、真实仓库不产生 `unknown` 兜底条目。

## Alternatives considered

1. **完全删除兜底（只保留 `name` + `type` 的主匹配）**：拒绝。有些指标定义
   可能把 `type` 写在别处（常量引用/泛型推断），保留 `name:` 形式的无名兜底
   可避免误报真实定义；收紧而非删除更稳妥。
2. **只认 `registerBusinessMetric({...})` 调用内的定义**：拒绝。平台指标
   （`metrics/platform.ts`）不以该函数形式出现，会漏掉真实定义。
3. **不修（与 `check-metrics` 各自独立）**：拒绝。两个门禁检查的是同一类资产
   （指标名），口径必须一致，否则会出现"一个门禁能发现、另一个放行"的漂移。

## Consequences

- dashboard 引用拼错/自造指标会被正确报出；真实定义全部仍可识别。
- 真实仓库 `unknown` 兜底条目从 5 降为 0（此前那 5 个均非指标定义），
  门禁仍 exit 0。
- 与 `check-metrics.ts` 的既有防护口径统一。
