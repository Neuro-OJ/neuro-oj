# Agent Note: 集中 Gate Runner

Status: implemented

## Problem

本地和 CI 的检查命令分散在各处，开发者不知道跑哪些；脚本改动可能漏检。

## Decision

新增集中 gate runner：

- `scripts/gate-runner.ts`：子进程执行工具。
- `scripts/check-ci.ts`：CI 仓库级门禁（Agent Note、Markdown 链接、导出 JSDoc）。
- `scripts/check-all.ts`：本地全量检查（仓库级门禁 + noj-core/llm-gateway/ui quick check）。
- CI 新增 `root-gates` job，运行 `scripts/check-ci.ts`。

## Alternatives considered

- 继续在各模块 deno.json 分散维护命令：入口不统一，容易漏跑。
- 只写 shell 脚本：跨平台性差，且与 Deno 项目工具链不一致。

## Consequences

- 仓库级门禁有单一入口。
- 本地可用 `deno run -A scripts/check-all.ts` 一键检查。
- 后续覆盖率、真实入口 smoke 等检查可追加到 runner。
