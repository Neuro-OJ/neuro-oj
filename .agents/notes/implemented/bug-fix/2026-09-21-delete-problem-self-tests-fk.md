# Agent Note: 有自测记录的题目无法删除（self_tests 外键未清理）

Status: implemented

## Problem

`self_tests.problem_id → problems.id` 是 `ON DELETE no action`：

- `noj-core/drizzle/0042_tough_saracen.sql:20`
- `noj-core/src/shared/db/schema-ddl.ts`（PGlite 镜像同为无 CASCADE）

而 `deleteProblem`（`noj-core/src/domains/catalog/services/problems/problems-crud.ts`）
手动清理了 `evaluation_results` 与 `submissions`（注释明确写着"submissions 无
ON DELETE CASCADE，需手动清理"），**却从未清理 `self_tests`**。全仓搜索
`delete(selfTests)` 在生产代码中零处（仅测试文件出现）。

触发条件：任意用户对某题发起过一次自测（`POST /api/v1/problems/:id/self-test`），
随后 owner/admin 删除该题：

```
DELETE /api/v1/problems/<id>
```

实测（修复前，`deno task test:domain catalog` 的回归用例）：

```
Caused by: error: update or delete on table "problems" violates foreign key
constraint "self_tests_problem_id_fkey" on table "self_tests"
→ 全局 onError 映射为 500 INTERNAL_ERROR
```

后果：题目**永久无法删除**（运维死锁），且返回给调用方的是 500
"服务器内部错误"，无法定位。这是功能性硬故障，不是"是否应保留自测记录"的
设计选择——同 schema 中 `objective_questions` / `objective_submissions` /
`community_posts` / `contest_problems` / `training_problems` / `problem_tags`
对 `problems` 全部使用 `ON DELETE cascade`，`self_tests` 的无动作是遗漏。

## Decision

在 `deleteProblem` 的清理链中补一步（位置与 submissions 清理一致，在删除
`problems` 之前）：

```ts
await db.delete(selfTests).where(eq(selfTests.problem_id, id));
```

语义与既有 submissions 清理完全相同：题目删除时其从属记录一并删除
（自测本就不参与统计/榜单/AC 活动，无独立保留价值）。

回归用例（`noj-core/src/domains/catalog/tests/services/problems.test.ts`）：
「有自测记录的题目仍可删除（self_tests FK）」——创建题目 + 插入一条
`self_tests` 记录 → 断言 `deleteProblem` 成功、题目 404、且自测记录被清理。

## Alternatives considered

1. **把 FK 改成 `ON DELETE cascade`（新增迁移）**：拒绝（本轮）。这需要新迁移
   文件 + 快照链更新，且对存量库的约束重建有锁表风险；而应用层手动清理与
   `submissions` 的既有模式一致，改动面最小。若后续统一改为 DB 级联，需单独
   评估 `submissions`（它还牵涉 evaluation_results 的清理顺序）。
2. **删除题目时保留 self_tests 并置空 problem_id**：拒绝。`problem_id` 是
   `NOT NULL`，且自测记录脱离题目后无任何意义（无题目上下文无法重放/展示）。
3. **在 DB 层加 `ON DELETE SET NULL`**：同上，`NOT NULL` 约束不允许，且会
   改变表结构契约。

## Consequences

- 题目删除恢复可用：有任意数量自测记录的题目都能被正常删除，返回 204。
- 自测记录随题目删除一并清理，与 `submissions` 的既有语义一致。
- 不改动任何 API 契约、状态码或表结构，无需人工裁决。
