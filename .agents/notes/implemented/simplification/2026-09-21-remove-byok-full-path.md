# Agent Note: 移除 BYOK 全路径并保留日后重建能力

Status: implemented

## Problem

BYOK（Bring Your Own Key，用户自带模型）允许登录用户保存自己的 OpenAI 兼容
Provider，并在普通编程题提交时选用。该能力横跨四个运行模块与完整契约链，其维护
成本与安全面已超过收益：

1. **契约面持续扩张**：`JudgeTask.user_llm` 需要 noj-core（TypeScript）与
   noj-judge（Rust）双侧镜像，并牵动契约快照测试；每加一个字段要同时改多处。
2. **安全面需要专门加固**：2026-09-21 刚修复 `PUT /me/llm-providers/:id` 的
   mass assignment（用户可改写 `enabled` / 负 `cost` 为全局配额"退款"）；BYOK
   出网白名单 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 也是需要独立运维审计的安全开关。
3. **judge 侧存在额度消耗面**：`request_user_llm_completion` capability 无每任务
   调用上限（`dev-docs/audit/2026-09-05-noj-cheating-audit/summary.md` F-09）。
4. **产品优先级低**：平台已提供管理员配置的 Provider 与题目级 LLM 能力，用户
   自带 Key 属可选增强。

## Decision

移除 BYOK 全路径，保留平台/管理员 Provider 与题目 LLM 能力。判据为
`llm_providers.created_by === "0"`（平台）保留、`!== "0"`（用户）删除。

删除范围覆盖 8 层：

- **契约**：`JudgeTask.user_llm`（core `JUDGE_TASK_FIELDS` + Rust `JudgeTask` +
  `noj-tests/fixtures/judge-task.contract.json`）。
- **judge**：`request_user_llm_completion` capability 特殊分支与
  `handle_user_llm_capability` / `user_llm_error_frame` /
  `map_user_llm_gateway_error`；`dual` 模块的重复入口合并为唯一
  `evaluate_dual_with_cpu_limit`（移除 `user_llm` 参数后两者签名一致）。
- **core 数据**：`submissions.llm_provider_config_id` 列与索引（迁移
  `0086_brainy_venus.sql`）。
- **core 服务/路由**：提交创建/artifact/rejudge/sweeper 的 `user_llm` 构造、
  `SubmissionInput.llm_provider_config_id`、5 条 `/me/llm-providers` 路由、
  gateway 客户端 6 个用户侧函数、`buildJudgeTaskLlmForProvider`（实现并入
  `buildJudgeTaskLlm`）。
- **gateway**：`validateByokBaseUrl` / `validateByokFields` /
  `BYOK_UPDATABLE_FIELDS` / `isByokRow`、`created_by` 列与归属过滤、迁移
  `0002_remove_byok_created_by.sql`（DELETE 用户行 + DROP 列）。
- **UI**：设置页「自带模型」区块、编辑器模型配置下拉与提交载荷。
- **文档/基建**：`noj-docs/docs/users/byok.md`、导航项、`NOJ_LLM_BYOK_ALLOWED_HOSTS`
  于三个 compose 文件与各 `.env.example`。

保留项：管理员 Provider 管理（`admin/routes/gateway.ts`、`admin/llm/*.vue`、
`listLlmProviders` / `getLlmProviderById` / `createLlmProvider` /
`updateLlmProvider`）、题目平台 LLM（`problem.llm` → `buildJudgeTaskLlm` →
`JudgeTask.llm`）、gateway 代理主链路与 `llm_usage` / `llm_quotas`。
`cost_per_1k_tokens` 数值夹取 `[0, 1e6]` 保留，作为通用纵深防御。

### 不可逆性

`DELETE FROM llm_providers WHERE created_by <> '0'` 会永久删除用户 Provider 的
信封加密 API Key。执行升级前必须完成备份（`noj-cli backup create`）。

### 悬空引用（评审发现，必须升级前核查）

被删除的用户 Provider **可能仍被题目引用**：题目保存时的校验只检查
`getLlmProviderById(provider_id)` 存在且 `enabled`，**不校验归属**，而出题人 UI 的
Provider 下拉来自无过滤的 `listLlmProviders()`。因此历史上管理员可以把某个
用户自建 Provider 选为题目 Provider 并写进 `problems.llm_config->>'provider_id'`。

升级后的症状是**评测期静默失败**：提交阶段不做任何校验（
`submissions-crud.ts` 只读 `llm_config` 并签发 eval_token），直到 evaluator 打
gateway `POST /v1/chat/completions` 时 `getProviderSecret()` 抛错 → 400
`provider_not_found`；该题后续"编辑保存"也会以「LLM Provider 不存在或已停用」
失败，直到管理员手工更换 Provider。

处置（两道防线）：

1. **升级前核查 SQL**（文档
   `noj-docs/docs/operators/production-deploy.md` 的「升级前检查」小节）：
   `SELECT p.id, p.title, p.llm_config->>'provider_id' FROM problems p JOIN
   llm_providers lp ON lp.id = p.llm_config->>'provider_id' WHERE lp.created_by <> '0';`
2. **`llm_usage.provider_id`** 同样可能悬空，但那是**无 FK 的历史审计文本列**，
   不参与任何运行时决策、不影响功能；本 Note 在此登记即可（此前正文曾称
   "既有 Agent Note 已登记"，但 base 的 `.agents/` 中并无该记录——已更正为
   可核对的表述）。

> 为什么不在迁移里自动清空：`problems.llm_config` 是 jsonb，批量改写会静默改变
> 题目语义（题目可能仍需 LLM 能力，只是要换成平台 Provider）。运维按核查结果
> 逐题处置（改 Provider 或清空）比自动改写安全。

### 未来重建的关键约束

- 用户 Provider 必须与管理员 Provider 在**归属模型**上显式分离——不要再次复用
  `llm_providers.created_by` 承载平台/用户双语义（本次移除的根因之一）。
- 更新路径必须**字段白名单化**，不允许整包转发（mass assignment）。
- 用户 Provider 出网必须走**精确主机 allowlist**，禁止 localhost/私网/元数据地址。
- judge 侧代打必须带**每任务调用计数上限**（F-09）。
- 契约字段（`JudgeTask.user_llm`）新增须同时更新
  `noj-tests/fixtures/judge-task.contract.json` 与 Rust 结构体。

## Alternatives considered

- **分阶段多 PR（契约 → core → UI/gateway → 文档）**：中间态会产生跨模块不一致
  窗口，需要额外兼容胶水（正是要删的东西）。单仓同版本部署无真实兼容需求，否决。
- **两阶段发布（先开关禁用后物理删除）**：与"干净删除"冲突，会先引入临时 feature
  flag，并需要两次发布窗口。否决。
- **保留休眠接缝（保留字段与 capability 分支）**：长期维护死代码，且死代码会持续
  出现在契约与安全审计面。否决。
- **只 DROP 列不删用户行 / 完全不删列**：留下死数据或死列，污染 schema 快照。
  否决。

## Consequences

- **正面**：跨模块契约收窄；安全面缩小（不再需要用户出网白名单与 mass assignment
  防护）；judge 侧 F-09 额度消耗面消失；schema 与路由目录更干净。
- **负面**：用户失去自带模型能力；用户历史 Provider 与其加密 Key 永久丢失（不可逆）。
- **中性**：`llm_usage` 可能含指向已删 Provider 的历史记录（`provider_id` 为无 FK
  的文本列）；平台 Provider 与题目 LLM 能力完全不受影响。
- **测试**：`request_user_llm_completion` 帧不再被拦截，回落到 evaluator 通用
  capability 路径，返回 `CapabilityNotFound`（非静默成功）。
