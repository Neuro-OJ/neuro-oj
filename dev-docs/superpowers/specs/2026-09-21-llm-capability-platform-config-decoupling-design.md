# 题目 LLM 能力与平台配置解耦设计

**日期**：2026-09-21
**状态**：设计待评审
**范围**：noj-core / noj-llm-gateway / noj-cli（题目包 CLI）/ noj-ui / noj-docs / fixtures

---

## 1. Problem

当前「一道题需要 LLM 能力」与「这道题用哪个供应商的哪个模型」被写进了同一份
题目数据：`problems.llm_config` 同时携带部署期生成的 gateway Provider UUID 与
具体模型名。

```
problems.llm_config = { provider_id: "<gateway UUID>", model: "qwen-plus", max_calls?, max_tokens? }
problem.json manifest.llm = { provider_id: "<gateway UUID>", model: "qwen-plus" }
```

由此产生三类耦合：

1. **题包不可跨部署移植**：`provider_id` 是每个部署实例自己生成的 UUID，换环境
   或重建数据库后题包里的 UUID 失效，题包无法直接复用。
2. **平台无法整体替换模型/供应商**：改模型要逐题改 `llm_config`；换 Provider
   更要改 UUID。运营者无法一次操作让所有 LLM 题跟随新模型。
3. **出题人必须了解 gateway 内部**：出题人在编辑器里从 admin Provider 列表选
   UUID 并手填模型名，暴露了本应属于平台运营的实现细节。

附带的问题：`llm_providers.model` 列在运行时**从不参与转发决策**——gateway 的
`routes/llm.ts` 用请求体里题包发来的 `model` 并按 `allowed_models` 校验；
`provider.model` 只用于后台展示与连通性测试。这是一列名义上的“默认模型”，
实际上默认模型来自题目。

---

## 2. Decision

**题目只声明“需要 LLM 能力 + 本次评测预算”；用哪个 Provider、哪个模型，完全由
平台级全局默认决定。**

- `problems.llm_config` 收缩为 `{ max_calls?, max_tokens? }`（**非 null 即启用，
  null 即禁用**），不再出现 `provider_id` / `model`。
- 平台全局默认由 noj-core 的 **runtime 系统设置** 持有：
  `llm_default_provider_id` + `llm_default_model`，后台可热改。
- **部署者必须同时配置这两项**，无回退（`llm_providers.model` 列一并删除，不再
  存在任何“Provider 自带默认模型”的来源）。
- `JudgeTaskLlm` 与 `eval_token` 的 wire 契约**保持不变**：core 在签发时用全局
  默认填充 `provider_id` / `allowed_models`，gateway / judge / evaluator SDK
  **零运行时代码改动**。
- 存量数据**容忍并忽略**：旧 `llm_config` / 旧题包里的 `provider_id` / `model`
  被忽略并记 warning，存量题目自动跟随平台默认。

### 2.1 目标 / 非目标

**目标**

- 题包（`problem.json`）不含任何部署期 UUID 与模型名，可跨部署直接导入。
- 运营者改一处设置即可让全部 LLM 题切换 Provider 或模型。
- 出题人界面只保留“启用 LLM”与预算，不接触 Provider / 模型。
- 删除 `llm_providers.model` 死列，消除“两个默认模型来源”。

**非目标**

- 不引入逻辑别名（fast / reasoning）或能力需求（上下文长度等）声明。
- 不改 `JudgeTaskLlm` / `eval_token` wire 契约，不删 evaluator 的
  `NOJ_LLM_PROVIDER_ID` 环境变量（该收窄作为后续单独变更）。
- 不改 gateway 的转发、限流、结算逻辑。
- 不改题目预算的 `max_calls` / `max_tokens` 语义与平台天花板校验。

---

## 3. 数据模型与配置

### 3.1 题目 llm_config

```ts
/** 题目 LLM 配置：非 null 即启用；provider/model 由平台全局默认决定。 */
export interface LlmConfig {
  /** 单次评测 LLM 调用上限；缺省 = 平台默认 */
  max_calls?: number;
  /** 单次评测 LLM billed token 上限；缺省 = 平台默认 */
  max_tokens?: number;
}
```

- `problems.llm_config` 仍为 JSONB，**无 core SQL 迁移**。
- `{ "max_calls": 30, "max_tokens": 20000 }`、`{}`（启用 + 平台默认预算）均为合法。
- `null` = 未启用 LLM。
- 校验 `isValidLlmConfig`：只校验 `max_calls` / `max_tokens` 若存在则为正整数。

**未知键策略**：`isValidLlmConfig` 对 `provider_id` / `model` **不再报错**，直接
忽略（容忍存量）。其余未知键同样忽略——保持 JSONB 前向兼容。

### 3.2 平台全局默认（新 runtime 设置）

在 `noj-core/src/shared/config/settings-registry.ts` 新增两条 runtime 项：

| key | type | envFallback | 说明 |
| --- | --- | --- | --- |
| `llm_default_provider_id` | string | `NOJ_LLM_DEFAULT_PROVIDER_ID` | gateway Provider UUID |
| `llm_default_model` | string | `NOJ_LLM_DEFAULT_MODEL` | 模型名（必须显式） |

- 新增 `SettingCategory` 成员 `"llm"`；`noj-ui/pages/admin/settings.vue` 的
  `CATEGORY_LABEL` 增加 `llm: "LLM"`。
- 读取链沿用 settings 框架：`DB → env 兜底 → default`；default 为空串（未配置）。
- `.env.example`、`.env.prod.example`、`env.e2e.template` 登记兜底键（注释示例），
  `deno task check:env` 保持一致。
- `check-env.ts` 中 `NOJ_LLM_DEFAULT_PROVIDER_ID` / `NOJ_LLM_DEFAULT_MODEL`
  如被列入忽略清单则移出。

---

## 4. 解析与签发（noj-core）

### 4.1 新增解析函数

在 `noj-core/src/domains/gateway/services/llm.ts`（或 `llm-limits.ts` 同域）
新增：

```ts
/** 读取平台全局默认 Provider/模型；缺任一项返回 null。 */
export function getLlmPlatformDefault(): {
  provider_id: string;
  model: string;
} | null;
```

- 经 `getSetting("llm_default_provider_id" / "llm_default_model")` 读取，trim 后
  任一为空则返回 `null`。

### 4.2 buildJudgeTaskLlm

`noj-core/src/domains/gateway/services/llm-token.ts` 的 `buildJudgeTaskLlm`
签名不变（仍接收 `LlmConfig` + 提交/题目/用户/runtime），内部改为：

1. 解析平台默认；为 `null` → 抛业务错误（提交时 400，文案：“平台未配置默认
   LLM Provider / 模型”）。
2. 校验默认 Provider 存在且 `enabled`（`getLlmProviderById`）；失败 → 400。
3. `resolveLlmLimits(llmConfig)` 得到预算（已有逻辑，不变）。
4. 用解析出的 `provider_id` 与 `model` 填充 `eval_token` 的
   `provider_id` / `allowed_models: [model]`，`JudgeTaskLlm` 结构不变。

> 由于 `buildJudgeTaskLlm` 目前返回 `Promise`，引入 400 错误只需抛出
> `BadRequestError`；调用点已在外层 try 中，错误映射沿用现有提交错误处理。

### 4.3 调用点

`submissions-crud.ts` / `artifact-submissions.ts` / `submissions-rejudge.ts`
（两处）继续传入现有的 `LlmConfig`，**无需改签名或改逻辑**。

### 4.4 题目 CRUD 校验变化

`problems-crud.ts` 的 create / update 中：

- 删除 `getLlmProviderById(input.llm.provider_id)` 存在性/启用校验（题目不再
  携带 provider_id）。
- 保留：客观题拒绝 LLM；仅 P 型可启用；必须开启 evaluator 网络；
  `assertLlmLimitsWithinDefault` 天花板校验。
- 提交时（§4.2）成为 Provider 存在性与启用的唯一校验点，语义与现状等价
  （原先在写题时校验，现在在提交时校验）。

---

## 5. 删除 `llm_providers.model` 列

### 5.1 noj-llm-gateway

- `src/db/schema.ts`：删除 `model` 列定义。
- `src/providers.ts`：
  - `ProviderInput` / `ProviderRow` / `ProviderView` 删 `model`；
  - `createProvider` INSERT 去掉 model 列；
  - `updateProvider` 去掉 model 分支与 `Pick<..., "model">`；
  - `toView` 去掉 model；
  - `testProviderConnection` 不再读 `row.model`，改为从**请求参数**取 `model`
    （见下）。
- `src/routes/internal.ts`：
  - `GET /internal/providers/:id` SELECT 列去掉 `model`；
  - `POST /internal/providers` 必填校验去掉 `body.model`；
  - `POST /internal/providers/:id/test` 从请求体读取可选 `{ model }`；
    未提供 → 400 `model_required`（该端点当前无 core/UI 调用方，改动不影响
    现有链路）。
- `src/routes/llm.ts`：**不改**（转发只用请求体 model + allowed_models）。
- 新增手写迁移 `drizzle/0003_remove_provider_model.sql`：

  ```sql
  ALTER TABLE llm_providers DROP COLUMN IF EXISTS model;
  ```

  gateway 使用独立 `llm_schema_migrations` runner、无 drizzle 快照门禁，
  `IF EXISTS` 保证老库幂等。**不可逆**，升级前须备份（`noj-cli backup create`）。

### 5.2 noj-core

- `gateway/services/llm.ts`：`LlmProviderInput` / `LlmProviderView` 删 `model`。
- `admin/routes/gateway.ts`：`POST /llm/providers` 必填校验去掉 `body.model`；
  注释更新。
- `catalog/services/problems/problems-crud.ts`：删除 `getLlmProviderById` 调用
  （§4.4）。

### 5.3 noj-ui

- `pages/admin/llm/providers.vue`：删「默认模型」列与表单输入、`formModel` 及其
  校验与 payload 字段。

---

## 6. 题目包 manifest

`problem.json` 的 `llm` 块：

```jsonc
// 新
{ "llm": { "max_calls": 30, "max_tokens": 20000 } }

// 旧（容忍并忽略 provider_id / model）
{ "llm": { "provider_id": "uuid", "model": "qwen-plus" } }
```

- `ProblemBundleManifest.llm` 类型改为新 `LlmConfig`。
- `validateBundleManifest`：`llm` 存在 → 仍强制 P 型 + evaluator 联网 +
  `isValidLlmConfig`；不再要求 `provider_id` / `model`。
- 旧 manifest 携带 `provider_id` / `model` 时：忽略，可选记 warning（若引入
  warning 汇聚结构；否则静默容忍）。

---

## 7. noj-ui 出题编辑器

`components/editor/CodingProblemEditor.vue`：

- 删除 `llmProviderId` / `llmModel` / `llmProviders` / `loadLlmProviders()` 及
  Provider 下拉、模型输入与对应 fieldErrors。
- 保留 `llmEnabled` / `llmMaxCalls` / `llmMaxTokens`。
- 回填逻辑只读 `max_calls` / `max_tokens`。
- 提交 payload 的 `llm` 只含预算字段；启用但两项留空 → 发送 `{}`（启用 + 平台
  默认预算）。
- 文案：`模型与供应商由平台统一配置`。
- 若组件类型定义含 provider/model，同步删除。

---

## 8. noj-cli 契约副本

`noj-cli/src/problem/vendor/problems.ts` 与 `vendor/problem-bundle.ts` 是
noj-core 的**刻意副本**（issue #514），必须同步：

- `LlmConfig` 收缩为预算字段；
- `isValidLlmConfig` 同步；
- `validateBundleManifest` 的 llm 校验同步。

同步后运行双侧共享 fixture 契约测试：
`noj-cli/src/problem/contract_test.ts` 与
`noj-core/src/domains/catalog/tests/types/problem-bundle-contract.test.ts`。

fixture `fixtures/problem-bundle-manifest.json`：LLM 反例 `"LLM 未开 evaluator
网络"` 当前值为 `{ "enabled": true }`，在旧实现下会先因缺少 `provider_id`/`model`
被拒；改造后应改为合法预算形状 `{ "max_calls": 1 }`，使其**只**因未开网络被拒，
断言与测试名一致。另补一条“旧形状 `{ provider_id, model }` 被接受”的正例，
锁住容忍语义。

---

## 9. 文档

- `noj-docs/docs/problemsetters/llm-problem.md`：题目配置不再写 provider/model；
  改为说明“平台已统一配置模型”，出题人只需启用 + 预算。
- `noj-docs/docs/standards/problem-bundle.md`：`llm` 字段说明与新示例同步。
- `noj-docs/docs/operators/llm-call-capability.md`：新增“配置平台默认 Provider
  与模型”步骤（设置页两项；部署者必须同时配置）。
- 新增 Agent Note（`architecture` 或 `simplification` 分类，视最终判据）。

---

## 10. 兼容性

- **存量 `problems.llm_config`**：旧行含 `provider_id` / `model`，读取时忽略，
  只取预算；题目照常跟随平台默认。无需数据迁移。
- **旧题包 manifest**：携带旧字段仍可导入，字段被忽略。
- **JudgeTaskLlm / eval_token / gateway / judge / evaluator SDK**：wire 契约与
  运行时代码全部不变。
- **`judge-task.contract.json`**：不变。
- **已删除的 BYOK 路径**：无关，不受影响。

---

## 11. 测试计划

| 模块 | 测试 |
| --- | --- |
| core types | `isValidLlmConfig` 接受 `{}` / 预算字段、忽略 `provider_id`/`model`、拒绝非法预算 |
| core bundle | manifest 新形状通过；旧形状（provider_id/model）通过且被忽略；U 型 / 未开网络 / 客观题仍拒绝 |
| core CRUD | 启用 LLM 不再要求 provider；预算超限仍 400；非 P 型 / 未开网络仍拒绝 |
| core llm-token | `buildJudgeTaskLlm` 用全局默认填充 provider/model；未配置默认 → 抛错；默认 Provider 不存在/停用 → 抛错；预算沿用题目值 / 平台默认 |
| core settings | 新增 `llm_default_*` 注册表项、类型与 env 兜底读取 |
| gateway | `providers_test` 删 model 断言；`helpers.ts` 去 model；连通性测试改传 model |
| noj-cli | 共享 fixture 契约测试两侧全绿 |
| noj-ui | 出题编辑器不再加载/发送 provider、model；类型检查通过 |
| e2e | `llm_gateway.test.ts`：`llmManifest` 改为新形状；测试 Setup 额外写入平台默认设置（provider_id + model），使提交链路可用 |

> e2e 需要把 `providerId` + `MOCK_MODEL` 写入平台默认。方式：调用管理端
> `PUT /api/v1/admin/system/settings/llm_default_provider_id`（或等价 API），
> 或设置 env 兜底。以实施计划为准。

---

## 12. 执行顺序（保证 `main` 每步可部署）

1. **core 设置**：注册 `llm_default_*`，新增 `getLlmPlatformDefault`。
2. **core 契约**：`LlmConfig` 收缩；`buildJudgeTaskLlm` 改用全局默认；
   CRUD 删 provider 校验；manifest 校验放宽。
3. **noj-cli 副本 + fixture**：同步，契约测试全绿。
4. **gateway**：删 model 代码 + `0003` 迁移；core 客户端与 admin 路由同步。
5. **UI**：出题编辑器 + Provider 管理页。
6. **文档 + Agent Note**。
7. **全链路门禁**：`deno fmt` / `deno lint`、`cargo clippy`（若触及）、
   `check:env`、`check-domains`、契约测试、e2e、`verify-agent-note-format`。

> 步骤 4 的迁移对 gateway 是**破坏性 DROP**；须与 core 客户端同步发布，避免
> core 仍发送 `model` 字段（gateway 忽略未知字段即可，故实际安全）。

---

## 13. 验证

- 题包：新形状 manifest 导入成功；旧形状（provider_id/model）导入成功且忽略。
- 移植性：同一题包在 Provider UUID 不同的部署上导入并成功评测。
- 切换：改 `llm_default_model` 后，新提交的 LLM 题使用新模型（查 `llm_usage`）。
- 失败路径：未配置默认 / Provider 停用时提交返回 400，文案明确。
- 契约：core + judge 契约快照测试字段集合一致，不含新增/删除字段。
- 迁移：在**存量库**上执行 gateway `0003` 成功（非仅空库）。
- 门禁：`check:env`、`check-domains`、双侧 fixture 契约测试通过。

---

## 14. Alternatives considered

- **逻辑别名（default / fast / reasoning）**：题目声明别名，管理员维护别名→
  (provider, model) 映射。解耦更强，但引入一层目前无需求支撑的间接，且题目包
  仍需引用平台定义的别名集合（可移植性依赖别名约定）。否决（当前 YAGNI）。
- **题目声明能力需求（上下文长度 / 质量档位）**：最灵活，但需要模型元数据与
  匹配规则，实现最重。否决。
- **默认 provider/model 放 gateway（`llm_providers.is_default`）**：provider 选择
  归属 gateway，但 provider 表不再有 model 列，且 core 已能经设置读取；放 core
  设置与现有配置分层一致，热改体验最好。否决。
- **eval_token 不带 provider，gateway 自行决定默认**：解耦最彻底，但需改
  eval_token 契约与 gateway 转发逻辑，超出“最小改动”范围。否决（可作后续）。
- **保留 `provider.model` 列但不依赖**：留下一个不参与决策的死列，污染 schema
  与后台语义。否决。

---

## 15. Consequences

- **正面**：题包可跨部署移植；平台可一处切换模型/供应商；出题人界面收敛；
  `llm_providers` 表语义单一（endpoint + key + 计费）；无 core 迁移。
- **负面**：全平台 LLM 题共用同一模型，无法逐题指定模型（当前即为目标形态）；
  部署者必须显式配置默认 provider 与模型，漏配则 LLM 题提交 400（fail-fast，
  有明确文案）；gateway `model` 列为破坏性 DROP（不可逆，需备份）。
- **中性**：存量题目自动跟随平台默认——若原题目本意是指定某模型，语义会变化；
  这是本次解耦的预期结果，需在文档与发布说明中明确。
