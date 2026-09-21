# Agent Note: 两个门禁入口收敛到单一事实源（check-all / check-ci 分叉）

Status: implemented

## Problem

仓库有两个"仓库级门禁"入口，各自维护一份手写命令清单：

- `scripts/check-all.ts`：`scripts/README.md` 称为"本地全量检查入口"；
- `scripts/check-ci.ts`：CI `root-gates` job 的唯一入口。

两份清单长期分叉。实测 `check-all.ts` 比 `check-ci.ts` **少 19 项**：

| 缺失门禁 | 性质 |
| --- | --- |
| `silent-skip-report.ts --check` | 静默跳过棘轮 |
| `check-migration-safety.ts` | 存量库升级安全 |
| `check-migration-snapshot-chain.ts` | 迁移快照链 |
| `check-log-migration.ts` / `check-log-parity.ts` | 日志模板/渲染一致性 |
| `check-file-size.ts` | 单文件规模棘轮 |
| `check-write-rate-limits.ts` | 写端点限流覆盖 |
| `check-deno-version.ts` | Deno 版本一致性 |
| `check-schema-parity.ts` + 其测试 | schema-ddl 与 Drizzle 一致性 |
| 8 个门禁的 `_test.ts` | 门禁自测 |

后果：本地 `deno run -A scripts/check-all.ts` 显示"全部检查通过"，而**同一份
代码在 CI 上红灯**（例如本地漏跑迁移安全门禁，CI 才拦截一步式
`ALTER TABLE ... NOT NULL`）。这是本仓库反复出现的"本地假绿"类缺陷。

## Decision

新增 `scripts/gate-list.ts` 作为**门禁清单的单一事实源**：

- `REPO_GATES`：仓库级门禁（29 条），两个入口共用；
- `MODULE_CHECKS`：模块级 `deno task check`（3 条），**仅本地入口**使用——
  CI 侧这些由各模块的独立 job 并行执行（core-quick-check / gateway-check /
  ui-check），root-gates 重复跑只会拖长流水线；
- `gateLabel()`：统一的日志标签。

`check-ci.ts` 与 `check-all.ts` 都改为遍历清单执行，不再手写任何命令。
`check-all.ts` = `REPO_GATES` + `MODULE_CHECKS`，因此**本地严格覆盖 CI**。

防分叉守卫 `scripts/gate-list_test.ts`（6 条）：

1. 两个入口都从 `gate-list.ts` 导入清单，且**不得再出现手写 `run([...])`**；
2. 本地入口必须包含 `REPO_GATES` 与 `MODULE_CHECKS`；
3. 关键门禁（静默跳过、迁移安全、迁移快照链、文件规模、测试可发现性、
   Deno 版本、schema parity）不得被删除；
4. 全部 `GATE_SELF_TESTS` 文件真实存在；
5. `gateLabel` 语义；
6. 清单内无重复命令。

## Alternatives considered

1. **只把缺失的 19 项复制进 `check-all.ts`**：拒绝。这正是缺陷的成因模式——
   两份手写清单。复制一次只解决当下，下次新增门禁仍会漂移。
2. **让 `check-all.ts` 直接 `import` 并调用 `check-ci.ts`**：拒绝。CI 入口是
   `import.meta.main` 脚本，无法在进程内复用（会重复 `Deno.exit`）；且本地还
   需要额外的模块级 check，语义不等价。
3. **两个入口完全合并为一个文件（用 `--ci` 参数区分）**：拒绝。CI 只跑
   `REPO_GATES`、本地跑更多，行为差异是**有意设计**（并行 vs 串行）；共用一个
   文件会让"CI 跑什么"变得不直观，而共享清单已能消除漂移。
4. **把模块级 check 也加进 CI root-gates**：拒绝。各模块 job 已并行执行，
   重复执行会显著拖长 CI（本次 CI 全绿耗时约 2 分钟，串行模块检查会翻倍）。

## Consequences

- 本地 `deno run -A scripts/check-all.ts` 与 CI `root-gates` 的仓库级门禁
  **逐条一致**；不再出现"本地绿、CI 红"。
- 新增门禁只需改 `scripts/gate-list.ts` 一处，并有测试断言两个入口都在使用它。
- `check-all.ts` 的执行时间变长（多了 19 项仓库级门禁），这是把 CI 门禁
  带到本地的预期代价。
