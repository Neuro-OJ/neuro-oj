# Agent Note: 清理已知文档与注释漂移

Status: implemented

## Problem

8 月审计报告 `docs/audit/2026-08-15-noj-audit/docs.md` 记录了 28 条文档真阳性，另有 `env-snapshot.ts`、`useMessages.ts` 注释与实现不一致。文档和注释漂移会误导开发者和 AI。

## Decision

清理当前仍存在的已知漂移：

- 修复 5 个 Markdown 死链/坏锚点（`scripts/dev/README.md`、`noj-docs/docs/operators/judge-workers.md`、`production-deploy.md`、`intro/faq.md`、`system/storage.md`）。
- 更新 `noj-core/src/lib/env-snapshot.ts` 注释，删除“NOJ_ENV=test 跳过快照”的不实描述。
- 更新 `noj-ui/composables/useMessages.ts` 注释，明确“失败不弹 toast 但异常向上抛出”。
- 移除 README 中易过时的测试文件计数。
- 审计中其他文档漂移在当前工作树中已不存在（镜像名、manifest.json、命令、密码长度等均已正确）。

## Alternatives considered

- 修改代码实现以匹配旧注释（如让 snapshotEnv 在 test 下跳过）：会改变行为，且当前行为无实际故障。
- 保留计数类文档：数字会持续漂移，移除比维护更可靠。

## Consequences

- 当前文档与注释与实现一致。
- 未来由 `verify-md-links.ts`、`verify-export-jsdoc.ts` 和 Agent Note 门禁防止再次漂移。
