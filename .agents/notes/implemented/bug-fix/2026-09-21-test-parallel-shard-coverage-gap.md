# Agent Note: test:parallel 分片静默遗漏两个 domain 与顶层测试文件

Status: implemented

## Problem

`noj-core/scripts/test-parallel.ts` 是三条测试路径之一（`test` / `test:domain`
/ `test:parallel`），也是 CI `core-test-sharded` job 的执行入口。它的模块注释明确
声称「分片目录集合与 `.github/workflows/ci.yml` 的 `core-<domain>` / `core-shared`
一致」——**但实际不一致**：

| 遗漏 | 文件数 | 后果 |
| --- | --- | --- |
| `observability` domain 全部测试 | 8 | 该 domain 在并行路径下**零覆盖** |
| `admin` domain 全部测试 | 2 | 同上 |
| `search/tests/consumer` | 1 | 搜索索引消费者测试从不并行执行 |
| `tests/` 顶层若干文件 | 9 | security-headers / types_safety / defensive-patterns / smoke / `scripts/*` 全部不执行 |

共 **21 个测试文件**从未在 `test:parallel` 下运行，却没有任何信号。对
`test:domain observability` / `test:domain admin` 单独跑是绿的，因此问题只在
「并行路径」这一条上暴露——正是「三条测试路径行为不一致」中最隐蔽的一类。

### 修复前失败的真实证据

用**修复前**的分片目录集合（取自 `zkqtpovz` 的 `test-parallel.ts`）对文件系统做
覆盖判定：

```text
[修复前] 未被任何分片覆盖的测试文件数 = 21
  - src/domains/admin/tests/middleware/admin-version.test.ts
  - src/domains/admin/tests/services/admin-audit.test.ts
  - src/domains/observability/tests/health.test.ts
  - src/domains/observability/tests/judge-heartbeat.test.ts
  - src/domains/observability/tests/middleware.test.ts
  - src/domains/observability/tests/platform-metrics.test.ts
  - src/domains/observability/tests/probes.test.ts
  - src/domains/observability/tests/slo.test.ts
  - src/domains/observability/tests/snapshot.test.ts
  - src/domains/observability/tests/write.test.ts
  - src/domains/search/tests/consumer/search-index-consumer.test.ts
  - tests/defensive-patterns_test.ts
  - tests/scripts/backfill_public_ids_test.ts
  - tests/scripts/check-env.test.ts
  - tests/scripts/noj-cli.test.ts
  - tests/scripts/problems-init_test.ts
  - tests/scripts/test-parallel.test.ts
  - tests/security-headers.test.ts
  - tests/smoke.test.ts
  - tests/types_safety.test.ts
```

（`tests/scripts/test-parallel-coverage.test.ts` 是本修复新增的守卫本身。）

**修复后** `deno task test:parallel` 实测从 `997 passed` 提升到 `1051 passed`
（+54 个用例），全部分片通过。

## Decision

1. 把分片配置抽成**纯数据模块** `noj-core/scripts/test-parallel-shards.ts`
   （`SHARDS` + `isCoveredByShards` + `isPerfExcluded`）。`test-parallel.ts`
   有顶层副作用（读 `DATABASE_URL`、spawn），无法被测试 import；抽出后配置可被
   直接断言。`test-parallel.ts` 改为 import，消除双份定义。
2. 补齐缺席的目录：
   - `unit` 分片：`src/domains/observability/tests`（纯逻辑，无 DB）、
     `src/domains/admin/tests/middleware`、`src/domains/search/tests/consumer`、
     `tests/defensive-patterns_test.ts`、`tests/security-headers.test.ts`、
     `tests/types_safety_test.ts`。
   - `db` 分片：`tests/scripts`、`tests/smoke.test.ts`、
     `src/domains/admin/tests/services`（依赖 DB）。
3. 新增覆盖守卫 `noj-core/tests/scripts/test-parallel-coverage.test.ts`：
   - 对照文件系统，断言 `tests/` 与 `src/domains/<domain>/tests` 下**每个**
     测试文件都被覆盖（除登记豁免）；
   - 显式断言 `observability` / `admin` 在列（防回归到本次遗漏）；
   - 目录级不重叠；直接文件路径的重复**仅允许** `tests/00_migrate_test.ts`
     （每个分片需在自建 schema 内各迁移一次，属有意重复）；
   - 性能基准 `perf/` 按登记豁免且可反向证明（`isPerfExcluded` 真值）。

## Alternatives considered

- **在 `test-parallel.ts` 里就地补数组、不加守卫**：下个 domain 或顶层测试文件
  仍会静默漏掉——这正是本次缺陷的成因。必须把「覆盖」变成可断言的属性。
- **改为自动枚举 `src/domains/*/tests`**：会失去 unit/db 的**依赖分层**（纯逻辑
  进 unit、需 DB 进 db），并可能把未来的 perf/重型测试误入常规分片。显式清单 +
  守卫更可控。
- **把 perf 也纳入分片**：`perf` 需 `NOJ_RUN_PERF=1` + 外部 DB + 10 万行种子，
  只在 `core-perf` job 跑；纳入会让每次并行测试插入重型负载。登记豁免并反向测试。
- **不区分「目录重叠」与「文件重复」**：`tests/00_migrate_test.ts` 有意出现在
  两个分片，一刀切禁重复会误报。改为目录级不重叠 + 文件重复白名单。

## Consequences

- `test:parallel` 与 CI `core-test-sharded` 现在真正覆盖全部 domain 与顶层测试；
  实测用例数 997 → 1051。
- 新增 domain / 顶层测试文件若未登记分片，`tests/scripts/test-parallel-coverage.test.ts`
  会失败并列出未覆盖文件，漂移不再静默。
- 分片配置成为单一事实源，`test-parallel.ts` 不再自带一份数组。
- 分片并行时长略增（新增约 54 个用例，主要为纯逻辑，实测总时长仍在 ~2 分钟量级）。
