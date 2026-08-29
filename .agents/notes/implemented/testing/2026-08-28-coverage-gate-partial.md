# Agent Note: 覆盖率门禁（部分启用）

Status: implemented

## Problem

P1.2 覆盖率门禁被 Deno coverage 环境问题阻塞；后续发现使用全新 `DENO_DIR` 可解决 `Missing transpiled source code`。

## Decision

- 为 noj-llm-gateway 和 noj-ui 新增 `test:coverage` 任务，使用 `DENO_DIR=.deno_cov_cache` 规避 Deno coverage 缓存问题。
- 阈值：noj-llm-gateway 行覆盖 ≥ 54%，noj-ui 行覆盖 ≥ 60%（当前基线分别为 54.5% / 98.4%）。
- 新增 `scripts/coverage-report.ts` 运行这两个模块。
- CI 新增 `coverage-check` job。
- noj-core 在 coverage 模式下有 53 个测试失败，noj-judge 缺少 cargo-llvm-cov，暂未启用。

## Alternatives considered

- 全部模块立即启用：core 测试失败会阻断 CI。
- 放弃覆盖率门禁：已找到 workaround，不应放弃。

## Consequences

- llm-gateway / noj-ui 覆盖率受 CI 保护。
- core/judge 覆盖率待修复后补入 `coverage-report.ts`。
