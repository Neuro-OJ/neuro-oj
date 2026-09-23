# Agent Note: 单文件规模棘轮门禁遗漏 noj-cli

Status: implemented

## Problem

`scripts/check-file-size.ts` 的 `SCAN_ROOTS` 未包含 `noj-cli`：

```ts
const SCAN_ROOTS = [
  "noj-core/src", "noj-ui", "noj-judge/src",
  "noj-llm-gateway/src", "noj-lmcc-extension/src", "noj-tests",
];
```

而 `noj-cli` 是纯 TS 重写后的正式模块（`noj-cli/deno.json` 定义 `@noj/cli`，
44 个测试文件）。实测其 3 个文件超过 1200 行阈值却从未被约束：

| 文件 | 行数 |
| --- | --- |
| `noj-cli/src/prod/lifecycle.ts` | 2097 |
| `noj-cli/src/cli.ts` | 1611 |
| `noj-cli/src/prod/config.ts` | 1218 |

触发条件：在 `noj-cli/src/` 下新增一个 3000 行文件：

```
$ deno run -A scripts/check-file-size.ts
单文件规模检查通过（扫描 572 个源文件 / 超阈值 3 个均已登记：…）
```

即 `noj-cli` 的规模增长**永远不会被发现**；同样文件放到 `noj-core/src/`
会立即报"未登记基线"。

这与第二轮已修的两处（`silent-skip-report` / `check-test-discovery` 的
`SCAN_ROOTS` 遗漏 `noj-cli`）是同一类门禁范围漂移：新模块建立时未同步登记
到既有门禁的扫描根。

实测（修复前，单测）：

```
check-file-size: noj-cli 的超阈值文件被纳入扫描 ... FAILED
check-file-size: 夹具中的 noj-cli 文件超阈值会失败 ... FAILED
```

## Decision

1. `SCAN_ROOTS` 补入 `"noj-cli/src"`；
2. 按现状把 3 个既有超阈值文件登记进 `SIZE_BASELINE`（棘轮只允许下调，
   后续增长即失败）；
3. 新增 2 条回归用例：
   - 真实仓库断言 `noj-cli/` 至少有一个超阈值文件被扫描到且已登记基线；
   - 夹具中在 `noj-cli/src/` 放一个 1210 行文件，断言门禁报错。

## Alternatives considered

1. **先拆分这 3 个文件再补扫描根**：拒绝（本轮）。拆分会改动大量 CLI 业务代码，
   风险远超门禁修复；先用棘轮锁住现状（不允许继续变大）即可，拆分可另行排期。
2. **把 `SCAN_ROOTS` 改为动态枚举所有模块的 `src/`**：拒绝。各模块的源码布局
   并不统一（`noj-ui` 没有 `src/`、`noj-tests` 直接是仓库根），动态推导需要
   为每个模块维护例外表，复杂度高于显式清单 + 回归断言。
3. **对 `noj-cli` 只告警不失败**：拒绝。告警会被忽略，这正是本门禁当初引入
   棘轮而非"仅报告"的原因。

## Consequences

- `noj-cli` 的巨型文件自此受棘轮约束；实测扫描文件数 572 → 638，
  超阈值 3 → 6（新纳入的 3 个已登记基线）。
- 3 个文件已处于基线，任何后续增长都会让门禁失败；拆分后应下调基线。
- 不改动任何 `noj-cli` 源码行为。
