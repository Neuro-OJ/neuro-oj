# Agent Note: Grafana 看板门禁的裸前缀匹配让 up* 拼错指标逃逸

Status: implemented

## Problem

`scripts/check-dashboards.ts` 的 `isExternalMetric` 用于判断某个指标名是否属于
"标准导出器/依赖方指标"（无需本仓库定义）：

```ts
return EXTERNAL_PREFIXES.some((p) =>
  p === p || name.startsWith(`${p}_`) || name.startsWith(p)
);
```

末尾的 `name.startsWith(p)` 使下划线边界完全失效。`EXTERNAL_PREFIXES` 含
`"up"`、`"postgres"` 等**不带下划线**的前缀，于是：

| 指标名 | `isExternalMetric` | 期望 |
| --- | --- | --- |
| `up` | true | true（精确匹配） |
| `upload_failed_requests_total` | **true** | false（自造/拼错） |
| `uptime_seconds` | **true** | false |
| `postgresql_x` | **true** | false |

触发条件：在 `deploy/monitoring/grafana-dashboard.json` 写入

```json
{"expr": "sum(upload_failed_requests_total)"}
```

`checkExpression` 在 `if (isExternalMetric(name)) continue;` 处跳过，**永不**报
`引用了未定义的指标`。即凡是以 `up` / `postgres` 开头的指标名，无论是否真实
存在，都能通过门禁——与该门禁"发现拼写错误"的立项目标直接冲突
（`check-dashboards_test.ts` 头部注释明确写着覆盖"引用不存在的指标名（拼写错误）"）。

实测（修复前，单测）：

```
isExternalMetric: 不做裸前缀匹配（up*/postgres* 拼错不得放行） ... FAILED
error: AssertionError: upload_failed_requests_total 不得被当作外部指标…
checkExpression: 拼错的 up* 指标会被报为未定义 ... FAILED
error: AssertionError: 拼错的 up* 指标必须报未定义，实际 []
```

## Decision

改为精确匹配 + 下划线边界：

```ts
if (name === p) return true;
return p.endsWith("_") ? name.startsWith(p) : name.startsWith(`${p}_`);
```

- 精确匹配覆盖 `up` 本身；
- 已含下划线的前缀（`node_` / `go_` / `process_` 等）按下划线边界匹配
  （等价于原 `${p}_` 但避免 `node__`）；
- 不带下划线的前缀（`up` / `postgres`）只允许 `postgres_*`，不再裸匹配。

真实仓库的 dashboard 表达式全部通过（`Grafana 看板表达式检查通过`），
说明该收紧未误伤既有看板。

回归用例（`scripts/check-dashboards_test.ts`）新增 2 条：
`up*` / `postgres*` 拼错不被当作外部指标、拼错的 `up*` 指标被报未定义。

## Alternatives considered

1. **删掉列表中的 `up` / `postgres`**：拒绝。它们本身是合法的标准指标
   （`up` 是 Prometheus 的抓取目标状态，`postgres_*` 是 postgres_exporter），
   不能整体移除；问题在于前缀匹配的边界，而非这些条目的存在。
2. **只保留 `name === p || name.startsWith(p + "_")`**：会破坏
   `node_` 这类本身以 `_` 结尾的前缀（`name.startsWith("node__")`）——本轮
   已在实现中专门区分"前缀是否已含下划线"。
3. **不修（只影响 Grafana 看板这种非核心资产）**：拒绝。看板是运维排障的
   直接手段，静默引用不存在的指标会让面板永远空白而无告警——正是本仓库
   "假绿"类缺陷的典型。

## Consequences

- 以 `up` / `postgres` 开头的自造或拼错指标会被门禁发现；`up` 自身与
  `postgres_*` 仍正常放行。
- 真实仓库当前 0 违规（门禁仍 exit 0）。
- 不改动 PromQL 解析、直方图校验等其它逻辑。
