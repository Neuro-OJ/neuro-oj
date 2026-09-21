# 移除 BYOK 全路径设计（并保留日后重建能力）

**日期**：2026-09-21
**状态**：设计已确认，待实施
**范围**：noj-core / noj-judge / noj-llm-gateway / noj-ui / noj-docs / 基建与文档

---

## 1. Problem

BYOK（Bring Your Own Key，用户自带模型）允许登录用户保存自己的 OpenAI 兼容
Provider，并在普通编程题提交时选用。该能力横跨四个运行模块与完整契约链：

```
noj-ui（设置页 + 编辑器下拉）
  └─ REST /me/llm-providers → noj-core（identity 路由 + gateway 客户端）
       └─ /internal/providers → noj-llm-gateway（provider CRUD + 出网白名单）
            └─ /v1/chat/completions 代理
noj-core 提交服务 → JudgeTask.user_llm → noj-judge（capability 代打 gateway）
```

该路径的维护成本与安全面已经超过其收益：

1. **契约面持续扩张**：`JudgeTask.user_llm` 需要 core/TS 与 judge/Rust 双侧镜像，
   并牵动契约快照测试；每加一个字段要同时改多处。
2. **安全面需要专门加固**：2026-09-21 刚修复 `PUT /me/llm-providers/:id` 的
   mass assignment（用户可改写 `enabled` / 负 `cost` 为全局配额"退款"）。
   BYOK 出网白名单（`NOJ_LLM_BYOK_ALLOWED_HOSTS`）也是需要独立运维审计的安全开关。
3. **judge 侧有已知的额度消耗面**：`request_user_llm_completion` capability 无
   每任务调用上限（`dev-docs/audit/2026-09-05-noj-cheating-audit/summary.md` F-09）。
4. **产品上优先级低**：平台已提供管理员配置的 Provider 与题目级 LLM 能力，
   用户自带 Key 属可选增强。

因此决定**移除 BYOK 全路径**，并在未来按需重建。

---

## 2. Decision

采用**干净删除 + 决策记录**：BYOK 相关代码、路由、UI、契约字段、数据库列与
用户数据全部移除；平台/管理员的 Provider 能力完全保留。未来重建从零开始，
本次以 Agent Note 记录重建意图与约束，实现细节由 git 历史保留。

### 2.1 保留 / 删除判据

判据：`llm_providers.created_by === "0"`（平台）**保留**，`created_by !== "0"`
（用户）**删除**。

**保留（平台/管理面，非 BYOK）**

- 管理员 Provider 管理：`noj-core/src/domains/admin/routes/gateway.ts` 的
  `/api/v1/admin/gateway/llm/providers|usage|quotas`、`noj-ui/pages/admin/llm/*`、
  `listLlmProviders` / `getLlmProviderById` / `createLlmProvider` /
  `updateLlmProvider`。
- 题目平台 LLM：`problem.llm` → `buildJudgeTaskLlm`（平台 eval_token）→
  `JudgeTask.llm` → judge/evaluator 的 `llm.complete`。
- gateway 代理主链路 `POST /v1/chat/completions`、`llm_usage` / `llm_quotas`、
  metrics、限流与结算。

**删除（BYOK 用户面，8 层）**：见 §3。

### 2.2 关键取舍

| 取舍 | 结论 | 理由 |
| --- | --- | --- |
| 是否保留休眠接缝 | 否，干净删除 | 避免为不确定的未来长期背负死代码；重建意图记入 Agent Note |
| `submissions.llm_provider_config_id` | DROP 列 + 索引 | 无 BYOK 即无写入方；死列会污染 schema 快照与契约 |
| 用户 `llm_providers` 行 | DELETE（含加密 Key） | 与"干净删除"一致；**不可逆**，执行前须备份 |
| `llm_usage` 审计记录 | 保留 | 审计价值；`provider_id` 为无 FK 的文本列，不因删行失效 |
| `llm_providers.created_by` 列 | DROP | BYOK 是唯一非 `"0"` 来源；列本身无独立语义 |
| `request_user_llm_completion` capability | 删特殊分支，走 evaluator 通用路径 | 该帧将命中"未注册 capability"（`CapabilityNotFound`），非静默成功 |
| `cost_per_1k_tokens` 数值夹取 | 保留 | 通用纵深防御（防 u64 溢出/污染配额），非 BYOK 专属；仅改注释措辞 |

---

## 3. 变更清单（按模块）

### 3.1 契约层（core ↔ judge，同一提交改完）

- `noj-core/src/domains/submission/types/index.ts`：
  删 `JudgeTaskLlm user_llm`（`JudgeTask`、`BuildJudgeTaskInput`）、
  `buildJudgeTask` 的 `user_llm` 分支、`JUDGE_TASK_FIELDS` 的 `"user_llm"`。
- `noj-tests/fixtures/judge-task.contract.json`：删 `user_llm`。
- `noj-core/src/domains/submission/tests/types/judge-task-contract.test.ts`：删断言。
- `noj-judge/src/types.rs`：删 `JudgeTask.user_llm`。
- `noj-judge/tests/judge_task_contract.rs`：删 `user_llm` 断言与字段集条目。
- `noj-judge/tests/e2e_dual_container.rs`：删 `user_llm: None`。

### 3.2 noj-judge

- `src/dual/mod.rs`：
  删 `handle_user_llm_capability`、`user_llm_error_frame`、
  `map_user_llm_gateway_error`、`FRAME_CAPABILITY` 中
  `request_user_llm_completion` 特殊分支（该帧回落到通用转发路径）、
  `evaluate_dual_with_cpu_limit_and_user_llm` 的 `user_llm` 参数及其传递链，
  以及全部 capability 相关单元测试。
- `src/judge/runner.rs`：删除调用点的 `task.user_llm.as_ref()`。
- `AGENTS.md`：删 `user_llm` 描述。

### 3.3 noj-core 数据与 schema

- `src/shared/db/schema/submission.ts`：删 `llm_provider_config_id` 列与
  `idx_submissions_llm_provider_config_id` 索引。
- `src/shared/db/schema-ddl.ts`：删对应列 DDL 与索引 DDL 两行。
- 新增迁移：`deno task db:generate` 生成 `DROP COLUMN` + `DROP INDEX`。
  门禁 `scripts/check-migration-snapshot-chain.ts` 按迁移区间认显式 DROP，
  合法；`llm_providers` 表本身不删，不触碰 `INTENTIONAL_REMOVALS`。

### 3.4 noj-core 服务与路由

- `services/submissions/submissions-crud.ts`、`artifact-submissions.ts`、
  `submissions-rejudge.ts`（两处）：删 `userLlmTask`、
  `getUserLlmProvider` / `buildJudgeTaskLlmForProvider` 调用、`user_llm` 传参。
- `services/submissions/submissions-types.ts`：删 `llm_provider_config_id`。
- `mq/sweeper.ts`：删 BYOK 恢复块、`selectFields` 该列、行类型字段、相关日志。
- `routes/submissions.ts`：删 JSON body 字段与 multipart 解析分支。
- `identity/routes/users.ts`：删 5 条 `/me/llm-providers*` 路由及 import。
- `gateway/services/llm.ts`：删 6 个用户侧函数
  （`listUserLlmProviders` / `getUserLlmProvider` / `createUserLlmProvider` /
  `updateUserLlmProvider` / `deleteUserLlmProvider` / `testUserLlmProvider`）；
  保留 `listLlmProviders` / `getLlmProviderById` / `createLlmProvider` /
  `updateLlmProvider`。
- `gateway/services/llm-token.ts`：删 `buildJudgeTaskLlmForProvider`；
  保留 `buildJudgeTaskLlm`。

### 3.5 noj-llm-gateway

- `src/providers.ts`：删 `validateByokBaseUrl`、`isPrivateHostname`、
  `validateByokFields`、`BYOK_UPDATABLE_FIELDS`、`isByokRow`、
  `ProviderInput.created_by`、`ProviderRow.created_by`、`listProviders` 的
  `createdBy` 参数，以及 `createProvider` / `updateProvider` / `deleteProvider` /
  `testProviderConnection` 的 BYOK 分支。
- `src/routes/internal.ts`：删 5 处 `created_by` query 过滤与归属校验。
- `src/routes/llm.ts`：删 BYOK base URL 复验块。
- `src/config-registry.ts`：删 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 登记。
- `src/db/schema.ts`：删 `created_by` 列定义。
- 新增手写迁移 `drizzle/0002_remove_byok_created_by.sql`：
  `DELETE FROM llm_providers WHERE created_by <> '0';`
  `ALTER TABLE llm_providers DROP COLUMN IF EXISTS created_by;`
  （gateway 用独立 `llm_schema_migrations` runner、无 drizzle 快照门禁，
  `IF EXISTS` 保证老库幂等）

### 3.6 noj-ui

- `pages/settings.vue`：删整段「用户自带模型（BYOK）」（script + template）。
- `components/editor/EditorWorkspace.vue`：删 `enableByok` prop、
  `byokProviders` / `selectedByokProvider` / `byokLoading` / `loadByokProviders` /
  watch、模型配置下拉块、提交载荷中的 `llm_provider_config_id`。
- `pages/editor/[id].vue`：删 `:enable-byok` 绑定与载荷 spread。

### 3.7 文档与基建

- 删 `noj-docs/docs/users/byok.md`；清 `users/index.md` 链接、
  `.vitepress/config.ts` 导航项。
- `noj-docs/docs/operators/production-secrets.md`：删 BYOK 段落。
- `NOJ_LLM_BYOK_ALLOWED_HOSTS` 从 `docker-compose.yml` / `docker-compose.e2e.yml` /
  `docker-compose.prod.yml`、`.env.prod.example`、`noj-llm-gateway/.env.example`、
  `noj-llm-gateway/README.md` 删除。
- 重生成 `dev-docs/engineering/route-catalog.md`
  （`deno run -A scripts/gen-route-catalog.ts`）。
- 新增 Agent Note
  `.agents/notes/implemented/simplification/2026-09-21-remove-byok-full-path.md`。

### 3.8 测试

- core：`judge-task-contract.test.ts` 字段集与 fixture、提交服务/路由测试。
- gateway：`tests/providers_test.ts` 删 BYOK mass-assignment 与 base URL 用例
  （保留管理员用例）、`tests/config_registry_test.ts` 删 BYOK 断言、
  `tests/helpers.ts` 删 `created_by`。
- judge：`dual/mod.rs` 删 capability 相关 5 个测试、
  `tests/judge_task_contract.rs` 与 `tests/e2e_dual_container.rs` 同步。

---

## 4. 数据与迁移

### 4.1 core

`deno task db:generate` 由 schema 变更生成 `ALTER TABLE submissions DROP COLUMN`。
迁移安全门禁（`scripts/check-migration-safety.ts`）只约束 `ADD COLUMN NOT NULL`，
本变更为 DROP，不触发。

### 4.2 gateway

手写 `0002_remove_byok_created_by.sql`（见 §3.5）。

### 4.3 不可逆性与运维前置

- `DELETE FROM llm_providers WHERE created_by <> '0'` 会永久删除用户 Provider
  的**信封加密 API Key**。执行升级前必须完成数据库备份
  （`noj-cli backup create`）。
- `llm_usage` 历史审计记录保留；其中 `provider_id` 可能指向已删除的 Provider，
  属预期（无 FK）。

---

## 5. 执行顺序（保证 `main` 每步可部署）

1. **judge**：删 `user_llm` 与 capability 分支。此时 core 仍可能发 `user_llm`，
   Rust `serde` 忽略未知字段、`Option` 缺省，不破坏。
2. **core + 契约 + 迁移 + UI 载荷**：删字段/构造/路由/gateway 客户端，
   `db:generate` 出 DROP COLUMN 迁移，UI 停止发送 `llm_provider_config_id`。
3. **gateway**：删 `created_by` 代码 + 手写 `0002` 迁移 + 删 env。
4. **UI 设置页 + 文档 + Agent Note**。
5. **全链路门禁**：`deno fmt` / `deno lint`、`cargo fmt` / `cargo clippy`、
   `gen-route-catalog --check`、`check-migration-snapshot-chain`、
   契约测试、`verify-agent-note-format`。

---

## 6. 验证

- 契约：`noj-core` 与 `noj-judge` 两侧契约快照测试字段集一致且不含 `user_llm`。
- 路由目录：`scripts/gen-route-catalog.ts --check` 通过（无 `/me/llm-providers`）。
- 迁移：`check-migration-snapshot-chain.ts` 通过；
  在**存量库**上执行新迁移成功（非仅空库）。
- gateway：`providers_test.ts` 全绿；管理员 Provider 用例保留并通过。
- 端到端：普通提交与题目 LLM 评测链路不受影响；`request_user_llm_completion`
  帧返回 `CapabilityNotFound`。
- 文档：`verify-agent-note-format.ts` 通过。

---

## 7. 重建指引（写入 Agent Note）

未来重建 BYOK 时，本设计留下的关键约束：

- 用户 Provider 必须与管理员 Provider 在**归属模型**上显式分离——不要再次复用
  `llm_providers.created_by` 承载平台/用户双语义（本次移除的根因之一）。
- 更新路径必须**字段白名单化**，不允许整包转发（mass assignment）。
- 用户 Provider 出网必须走**精确主机 allowlist**，禁止 localhost/私网/元数据地址。
- judge 侧代打必须带**每任务调用计数上限**（F-09）。
- 契约字段（`JudgeTask.user_llm`）新增须同时更新
  `noj-tests/fixtures/judge-task.contract.json` 与 Rust 结构体。

---

## 8. Alternatives considered

- **分阶段多 PR（契约 → core → UI/gateway → 文档）**：中间态会产生跨模块不一致
  窗口，需要额外兼容胶水（正是要删的东西）。单仓同版本部署无真实兼容需求，否决。
- **两阶段发布（先开关禁用后物理删除）**：与"干净删除"冲突，会先引入临时 feature
  flag，并需要两次发布窗口。否决。
- **保留休眠接缝（保留字段与 capability 分支）**：长期维护死代码，且死代码会持续
  出现在契约与安全审计面。否决。
- **只 DROP 列不删用户行 / 完全不删列**：留下死数据或死列，污染 schema 快照。
  否决。

---

## 9. Consequences

- **正面**：跨模块契约收窄；安全面缩小（不再需要用户出网白名单与 mass assignment
  防护）；judge 侧 F-09 额度消耗面消失；schema 与路由目录更干净。
- **负面**：用户失去自带模型能力，需在文档与产品说明中明确；用户历史 Provider
  与其加密 Key 永久丢失（不可逆）。
- **中性**：`llm_usage` 可能含指向已删 Provider 的记录；平台 Provider 与题目 LLM
  能力完全不受影响。
