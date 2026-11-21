# noj-core Schema 拆分与 LLM 表所有权迁移设计

> Status: proposed
> Date: 2026-09-01
> Scope: noj-core / noj-llm-gateway

## 1. 背景

noj-core 已完成代码级域隔离（Step 1-5）：业务代码全部迁入 `src/domains/<domain>/`，
`check:domains` 成为零违规硬门禁。但数据库层仍有两个遗留问题：

1. `src/db/schema.ts` 仍是 1672 行的单文件，包含全部 50 张表定义，与域边界不一致。
2. `gateway` 域的三张 LLM 表（`llm_providers` / `llm_usage` / `llm_quotas`）仍由
   noj-core 定义、迁移和 seed，而实际读写方是 `noj-llm-gateway`。

本设计对应域隔离设计文档的 **Step 6：评估 schema 拆分 / llm 表迁移**，采用
**方案 A：同库逻辑所有权转移**。

## 2. 目标

- 将 `schema.ts` 按域拆分为多个文件，保持 Drizzle 迁移语义完全不变。
- 将 LLM 三张表的 DDL/迁移/种子所有权移交给 `noj-llm-gateway`。
- 消除 noj-core 对 LLM 表的直接数据库依赖（表定义、外键、种子、测试 DDL）。
- 不引入独立 Postgres schema 或独立数据库，避免当前阶段的运维复杂度。

## 3. 非目标

- 不把 LLM 表迁移到独立 Postgres schema（`llm`）。
- 不把 LLM 表迁移到独立数据库（`noj_llm`）。
- 不改变 `llm_providers` / `llm_usage` / `llm_quotas` 的物理表结构。
- 不改变 noj-core 对外 API 与 noj-llm-gateway 内部 API 契约。

## 4. 现状与耦合点

| 耦合点 | 位置 | 说明 |
|---|---|---|
| 表定义 | `noj-core/src/db/schema.ts` | LLM 三表由 core Drizzle schema 定义 |
| 外键 | `submissions.llm_provider_config_id → llm_providers.id` | submission 域跨域引用 gateway 表 |
| 种子 | `noj-core/src/domains/system/services/seed/seed-system.ts` | `seedLlmQuotas()` 直接写 `llm_quotas` |
| 测试 DDL | `noj-core/src/db/schema-ddl.ts` | PGlite 测试重复维护 LLM 三表 DDL |

业务读写已收敛：core 对 Provider/用量/配额均通过 `noj-llm-gateway` 的
`/internal/*` HTTP API；提交创建前已通过 `getUserLlmProvider()` 校验 BYOK
Provider；题目 CRUD 已通过 `getLlmProviderById()` 校验平台 Provider。

## 5. 设计

### 5.1 schema.ts 按域拆分

新建 `noj-core/src/db/schema/` 目录，按域拆分表定义；保留
`src/db/schema.ts` 作为 barrel 再导出，避免大规模修改既有 import。

文件与表归属：

| 文件 | 表 |
|---|---|
| `identity.ts` | `users`、`oauthAccounts`、`checkIns`、`passwordResetTokens`、`tfaRecoveryCodes`、`userBans`、`roles`、`permissions`、`rolePermissions`、`userRoles` |
| `catalog.ts` | `problems`、`tags`、`problemTags`、`trainings`、`trainingProblems` |
| `objective.ts` | `objectiveQuestions`、`objectiveSubmissions` |
| `submission.ts` | `submissions`、`evaluationResults`、`selfTests`、`sseEvents` |
| `contest.ts` | `contests`、`contestProblems`、`contestParticipants`、`contestClarifications` |
| `community.ts` | `communityBoards`、`communityBoardRoleGrants`、`communityPosts`、`communityComments`、`communityPostLikes`、`communityCommentLikes`、`communityBookmarks`、`communityFollows`、`communityActivityEvents`、`communityReports`、`communityModerationActions`、`communitySanctions`、`communityNotifications` |
| `messaging.ts` | `conversations`、`messages`、`conversationReads`、`messageDeletions` |
| `system.ts` | `judgeImages`、`systemSettings`、`announcements`、`auditLogs`、`ipBans` |
| `gateway.ts` | `llmProviders`、`llmUsage`、`llmQuotas`（Phase 2 后从 core 移除） |
| `index.ts` | 汇总再导出全部表 |

跨域 FK 通过跨文件 `import` + Drizzle 惰性 `references(() => ...)` 实现，例如
`submissions` 引用 `users` / `problems` / `contests` / `llmProviders`。

`drizzle.config.ts` 的 `schema` 指向 `./src/db/schema.ts`（barrel），保证
`deno task db:generate` 行为不变。

### 5.2 LLM 表所有权移交 noj-llm-gateway

#### 5.2.1 gateway 建立自己的 Drizzle schema 与迁移

- 新建 `noj-llm-gateway/src/db/schema.ts`，定义 `llmProviders` / `llmUsage` /
  `llmQuotas`（从 core 复制，字段与索引完全一致）。
- 新建 `noj-llm-gateway/drizzle.config.ts`、`drizzle/` 目录与启动迁移 runner。
- 首次迁移采用**基线迁移**策略：老库已有这三张表，初始迁移使用
  `CREATE TABLE IF NOT EXISTS`（或等价地手工标记已应用），避免重复建表失败。
- gateway 启动时先执行迁移，再启动 HTTP。

#### 5.2.2 core 移除 LLM 表定义

- 从 `src/db/schema.ts`（及拆分后的 `gateway.ts`）删除三张表。
- 从 `src/db/schema-ddl.ts` 删除三张表 DDL。
- `submissions.llm_provider_config_id` 改为普通 `text` 列，不再声明 FK。

#### 5.2.3 删除跨域外键

生成一个 core 迁移：

```sql
ALTER TABLE "submissions"
  DROP CONSTRAINT "submissions_llm_provider_config_id_llm_providers_id_fk";
```

保留索引 `idx_submissions_llm_provider_config_id`，查询路径不变。

> **迁移生成注意事项**：从 core schema 删除 LLM 三表后，`deno task db:generate`
> 会同时生成 `DROP TABLE` 语句。这些表已由 gateway 接管，**必须手动从生成的
> 迁移 SQL 中删除三条 `DROP TABLE` 语句**，只保留 FK 删除（以及本阶段其他预期
> 变更）。Drizzle 的 snapshot 会按新 schema 更新，因此后续 `db:generate` 不会
> 再次生成 DROP。此手动步骤需在 review 中明确标注。

#### 5.2.4 种子数据迁移

- 删除 `seedLlmQuotas()` 及 `noj-core/scripts/noj.ts` 中的调用。
- 在 noj-llm-gateway 启动时幂等 seed 默认配额（与现有默认值一致）。
- `limits.ts` 的 `fallbackQuota` 已保证无配额行时也有安全默认值，因此
  gateway 未启动或未 seed 时不会出现“无限额度”风险。

#### 5.2.5 测试与 PGlite

- `schema-ddl.ts` 中 `submissions.llm_provider_config_id` 改为无 FK 的
  `TEXT` 列。
- 涉及 LLM 的 core 测试若依赖真实 provider 行，改为 mock gateway 或仅验证
  字符串透传。
- `noj-tests/e2e/32_llm_gateway.test.ts` 保持全链路覆盖。

### 5.3 文档与配置更新

- `dev-docs/engineering/domain-boundaries.md`：LLM 三表所有权改为
  `noj-llm-gateway`。
- `noj-llm-gateway/README.md` / `CLAUDE.md`：补充迁移命令与启动迁移说明。
- `docker-compose.yml` / `.env.example`：gateway 增加迁移相关配置（可复用
  `DATABASE_URL`，无需新增必填变量）。
- 根目录 `.env.prod.example` 同步。

## 6. 数据流（迁移后）

```text
noj-core                          noj-llm-gateway                 PostgreSQL
  admin routes  ──HTTP /internal──▶  providers/usage/quotas  ──SQL──▶ llm_*
  submission    ──HTTP /internal──▶  provider 校验
  (不直接读写 llm_* 表)
```

core 不再 import 或写入 `llm_providers` / `llm_usage` / `llm_quotas`。

## 7. 错误处理

- gateway 迁移失败：启动失败（fail-fast），与 core 启动迁移行为一致。
- core 调用 gateway 失败：沿用现有 `LlmGatewayError`，管理端返回 502/400。
- 删除 FK 后出现无效 `llm_provider_config_id`：提交创建时已通过 gateway 校验；
  历史脏数据由后续运维脚本或管理端查询发现。

## 8. 测试与验证

- `deno task db:generate`：core 不产生 LLM 表 diff；gateway 能生成自己的迁移。
- `deno task check:domains`：core 不再 import LLM 表。
- `deno task test`（core + gateway）。
- `deno run -A scripts/check-all.ts`。
- `noj-tests/e2e/32_llm_gateway.test.ts` 全链路。

## 9. 实施步骤（概要）

1. 拆分 `schema.ts` 为 `src/db/schema/` 多文件，验证无 schema diff。
2. gateway 建立 Drizzle schema + 基线迁移 + 启动迁移 runner。
3. core 删除 LLM 表定义、删除 FK、更新 `schema-ddl.ts`。
4. 删除 core 的 `seedLlmQuotas`，gateway 启动 seed 默认配额。
5. 更新文档、compose、env 示例。
6. 全量验证。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 老库已有 LLM 表，gateway 首次迁移重复建表 | 基线迁移用 `IF NOT EXISTS` 或标记已应用 |
| core 删除 LLM 表后 `db:generate` 生成 DROP TABLE | 手动从迁移 SQL 中删除 DROP TABLE，只保留 FK 删除；snapshot 同步更新 |
| 删除 FK 后出现无效 provider_id | 应用层已校验；保留索引便于查询与后续清理 |
| PGlite 测试依赖 LLM 表 | `schema-ddl.ts` 改为无 FK 的 text 列 |
| gateway 未启动时 dev-setup 不再 seed 配额 | `fallbackQuota` 提供安全默认值；gateway 启动时 seed |
| 拆分 schema 导致 Drizzle 生成意外 diff | 拆分后先跑 `db:generate` 确认无 diff 再继续 |

## 11. 后续可选项（本次不做）

- 将 LLM 表迁入独立 Postgres schema（`llm`）。
- 将 LLM 表迁入独立数据库（`noj_llm`）。
- 为 `submissions.llm_provider_config_id` 增加应用层定期一致性校验任务。
