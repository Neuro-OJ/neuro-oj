# Agent Note: 题目 LLM 能力与平台配置解耦

Status: implemented

## Problem

「一道题需要 LLM 能力」与「这道题用哪个供应商的哪个模型」此前写在同一个位置：
`problems.llm_config` 与题包 manifest 的 `llm` 块同时携带**部署期生成的 gateway
Provider UUID** 与具体模型名：

```
problems.llm_config = { provider_id: "<gateway UUID>", model: "qwen-plus", max_calls?, max_tokens? }
problem.json manifest.llm = { provider_id: "<gateway UUID>", model: "qwen-plus" }
```

由此产生三类问题：

1. **题包不可跨部署移植**：`provider_id` 是每个部署实例自己生成的 UUID，换环境
   或重建数据库后失效，题包无法直接复用。
2. **平台无法整体切换模型/供应商**：改模型要逐题改 `llm_config`；换 Provider
   更要改 UUID，运营者无法一次操作让全部 LLM 题跟随新配置。
3. **出题人被迫了解 gateway 内部**：在编辑器里从 admin Provider 列表选 UUID 并
   手填模型名，暴露了本应属于平台运营的实现细节。

附带缺陷：`llm_providers.model` 列在运行时**从不参与转发决策**——gateway 的
`routes/llm.ts` 用请求体里题包发来的 `model` 并按 `allowed_models` 校验，
`provider.model` 只用于后台展示与连通性测试，是一列名义上的“默认模型”。

## Decision

**题目只声明「需要 LLM 能力 + 本次评测预算」；用哪个 Provider、哪个模型，完全由
平台级全局默认决定。**

- `problems.llm_config` 收缩为 `{ max_calls?, max_tokens? }`（**非 null 即启用，
  null 即禁用**），不再出现 `provider_id` / `model`。仍为 JSONB，**无 core SQL
  迁移**。
- 平台全局默认由 noj-core 的 **runtime 系统设置**持有：
  `llm_default_provider_id` + `llm_default_model`，后台「系统设置 → LLM」可热改，
  读取链 `DB → env 兜底 → default`。env 兜底为 `NOJ_LLM_DEFAULT_PROVIDER_ID` /
  `NOJ_LLM_DEFAULT_MODEL`。
- **两项必须同时配置，无回退**：`getLlmPlatformDefault()` 在 trim 后任一项为空时
  返回 `null`，`buildJudgeTaskLlm` 据此在提交时抛 400（文案明确）。
- `JudgeTaskLlm` 与 `eval_token` 的 **wire 契约不变**：core 在签发时用全局默认
  填充 `provider_id` / `allowed_models: [model]`，gateway / judge / evaluator SDK
  **零运行时代码改动**；`judge-task.contract.json` 不变。
- 存量数据**容忍并忽略**：旧 `llm_config` 与旧 manifest 中的 `provider_id` /
  `model` 被忽略（`isValidLlmConfig` 只校验可选预算字段，未知键静默忽略），存量
  题目自动跟随平台默认。
- 题目 CRUD 删除 Provider 存在性/启用校验；Provider 的存在性与启用校验移到提交
  路径（`buildJudgeTaskLlm`），语义与现状等价。保留：客观题拒绝 LLM、仅 P 型可
  启用、必须开启 evaluator 网络、预算天花板校验。
- **删除 `llm_providers.model` 死列**：gateway `providers.ts` 的
  `ProviderInput`/`ProviderRow`/`ProviderView` 与 INSERT/UPDATE/SELECT 全部去掉
  model；连通性测试改为从请求体取 `model`（未提供 → 400 `model_required`，该端点
  无 core/UI 调用方）。迁移 `noj-llm-gateway/drizzle/0003_remove_provider_model.sql`
  为破坏性 `DROP COLUMN IF EXISTS`，不可逆，升级前须备份。
- UI 同步：出题编辑器移除 Provider 下拉与模型输入（保留启用 + 预算，文案「模型与
  供应商由平台统一配置」）；Provider 管理页移除「默认模型」列与表单输入。
- `noj-cli` 的契约副本 `problems.ts` / `problem-bundle.ts` 与共享
  `fixtures/problem-bundle-manifest.json` 同步，双侧 fixture 契约测试锁定等价。
- e2e（`noj-tests/e2e/cross-domain/llm_gateway.test.ts`）的 `llmManifest()` 改为
  `{ llm: { max_calls: 30 } }`；Setup 在创建 Provider 后经
  `PUT /api/v1/admin/system/settings/:key` 写入平台默认两项，使提交链路可用。
- 文档同步：`llm-problem.md`、`problem-bundle.md`、`llm-call-capability.md`、
  `admin-guide.md`。

## Alternatives considered

- **逻辑别名（default / fast / reasoning）**：题目声明别名，管理员维护别名 →
  (provider, model) 映射。解耦更强，但引入一层目前无需求支撑的间接，且题包仍需
  引用平台定义的别名集合，可移植性依赖别名约定。否决（当前 YAGNI）。
- **题目声明能力需求（上下文长度 / 质量档位）**：最灵活，但需要模型元数据与匹配
  规则，实现最重。否决。
- **默认 provider/model 放 gateway（`llm_providers.is_default`）**：provider 选择
  归属 gateway，但 provider 表已无 model 列，且 core 已能经设置读取；放 core 设置
  与现有配置分层一致，热改体验最好。否决。
- **eval_token 不带 provider、由 gateway 自行决定默认**：解耦最彻底，但需改
  eval_token 契约与 gateway 转发逻辑，超出“最小改动”范围。否决（可作后续）。
- **保留 `provider.model` 列但不依赖**：留下一个不参与决策的死列，污染 schema 与
  后台语义。否决。
- **继续在题目写入时校验 Provider**：题目已不含 `provider_id`，无从校验；改到
  提交路径与平台默认解析天然同点，避免两处校验漂移。

## Consequences

- **正面**：题包不含部署期 UUID 与模型名，可跨部署直接导入；运营者改一处设置即可
  让全部 LLM 题切换 Provider 或模型；出题人界面收敛；`llm_providers` 表语义单一
  （endpoint + key + 计费）；无 core 迁移。
- **负面**：全平台 LLM 题共用同一模型，无法逐题指定模型（当前即为目标形态）；部署
  者漏配平台默认时 LLM 题提交返回 400（fail-fast，有明确文案）；gateway `model`
  列为破坏性 DROP（不可逆，需备份）。该迁移须与 core 客户端同步发布——core 旧版本
  即使仍发送 `model` 字段，gateway 也会忽略未知字段，故实际安全。
- **中性**：存量题目自动跟随平台默认——若原题目本意是指定某模型，语义会变化；这是
  本次解耦的预期结果，已在文档中明确。
- **wire 契约零改动**通过 core + judge 契约快照测试与 `judge-task.contract.json`
  锁定；e2e 的新形状 manifest 与平台默认写入链路在完整栈下覆盖。

## 评审收尾（2026-09-22）

本 PR 的核心设计（题目只声明能力与预算、Provider/模型由平台决定）在评审中未发现
blocker，但补了以下几处**可运维性/竞态**缺口：

1. **单条重测的 LLM 解析前置**（`submissions-rejudge.ts`）。`buildJudgeTaskLlm`
   在平台默认缺配/停用时抛 400，而该调用此前位于「事务把提交置回 `pending` 并
   递增 `rejudge_seq`」**之后**：抛错会让提交卡在 `pending`（MQ 无任务，sweeper
   又不带 `llm`）。现改为**先解析、后改状态**，解析失败不产生任何状态变更，补一条
   回归测试断言「状态仍为 finished 且 rejudge_seq 未变」。
2. **sweeper 的取舍显式化**。`recoverPendingRows` 刻意不组装 `llm`（避免 gateway
   抖动把提交永久标记为 `error`），但该决定此前只存在于代码行为里。现补注释说明
   取舍与「若将来支持重建 `llm`，必须把解析失败降级为跳过本轮重试」。
3. **半配的平台默认在启动期告警**。新增 `describeLlmPlatformDefaultGap()`：两项
   只配一项时输出可操作告警（两项都空 = 不启用 LLM 题，不告警），补单测覆盖四种
   组合。部署者此前只能等到用户提交才看到 400。
4. **Provider ID 可见性**。平台默认要求填 gateway 内部 UUID，而管理端 Provider
   列表不展示 `id`、运营者无从获取。现补「Provider ID」列。
5. **文档与注释同步**：`schema/catalog.ts` 的 `llm_config` 注释按收缩后的语义重写；
   `llm-token.ts` 的函数注释改为「题目声明的能力与预算」；gateway README 补
   `POST /internal/providers/:id/test` 必须带 `model` 与 PUT 的作用域语义。
6. **`silent-skip-report` 的排序改为码位比较**（`compareCodeUnits`）：报告会被
   `--check` 逐字节比对，`localeCompare` 受 `LC_ALL`/ICU 版本影响，存在跨环境
   误报风险。

静默跳过基线 +1（993 → 994）来自上述第 1 条的回归测试：它遵循
`submissions.test.ts` 既有的 `ignore: !hasDb` 模式（该文件 14 个用例同此），
在完整测试环境（CI）中会真正执行，仅裸跑缺 PG 时跳过。
