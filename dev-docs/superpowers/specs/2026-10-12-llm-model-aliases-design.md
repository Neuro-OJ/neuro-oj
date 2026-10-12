# LLM 模型别名：逐题选择调用模型 设计稿

> **状态**：待评审（未实现） **背景决策**：2026-09-21
> [题目 LLM 能力与平台配置解耦](../../../.agents/notes/implemented/architecture/2026-09-21-llm-capability-platform-config-decoupling.md)
> 把题目里的 `provider_id` / `model` 删除，全部 LLM
> 题统一使用平台默认。该笔记在「Alternatives considered」中以 YAGNI
> 否决了「逻辑别名」方案；现出现逐题选模型的需求，本稿落地该方案。

## 1. 目标与非目标

**目标**

- 出题人可为每道 LLM 题声明允许调用的模型（一个或多个），题包仍可跨部署移植；
- 运营者改一处别名映射，即可让引用该别名的全部题目切换模型；
- 已发布版本重测时使用**当时**的模型，不受别名后续变更影响；
- 存量题目与题包零改动、行为不变（继续使用平台默认）。

**非目标**

- 一道题跨多个 Provider（eval_token 只有一个 `provider_id`，见 §5）；
- 逐模型独立配额 / 计费（沿用 Provider 的 `cost_per_1k_tokens`）；
- 评测代码自行枚举平台有哪些模型。

## 2. 概念

- **别名（alias）**：运营者定义的稳定名称，如 `fast`、`reasoning`；格式
  `^[a-z][a-z0-9_-]{0,31}$`。
- **别名映射**：`alias → { provider_id, model }`。
- **`default` 别名**：保留名，**不存储**，恒等于现有平台设置
  `llm_default_provider_id` + `llm_default_model`。因此现有配置与「Provider
  管理页顶部默认卡片」无需迁移。
- **题目的 `models`**：`llm_config.models: string[]`（别名列表，可选）。缺省 =
  `["default"]`。

## 3. 数据模型与契约

### 3.1 别名存储（noj-core）

新增 runtime 系统设置
`llm_model_aliases`（JSON：`{ "<alias>": { "provider_id": "...", "model": "..." } }`），
读取链沿用
`DB → env → default`，热改无需重启。禁止新增进程内可变缓存；失效须走既有「重新加载」路径
（见 AGENTS.md 多副本约束）。

> 实现前需确认系统设置注册表是否支持 JSON 类型值；若不支持，退路为在 core 新增
> `llm_model_aliases` 表（迁移用「可空 → 回填 → NOT
> NULL」三步，且仅新增表，无存量风险）。

校验（写入时）：别名格式、不得为 `default`、`provider_id` 须在 gateway
存在、`model` 非空且 ≤ 128 字符、 别名总数 ≤ 32。

### 3.2 题目与题包

- `problems.llm_config`（JSONB，无需 SQL
  迁移）：`{ max_calls?, max_tokens?, models?: string[] }`。 `models` 去重后 1–8
  项，每项须符合别名格式或为 `default`。
- 题包 `problem.json` 的 `llm` 块新增可选 `models`，仅含别名字符串，**不含 UUID
  与真实模型名**。
- `noj-cli` 契约副本（`src/problem/vendor/problems.ts`、`problem-bundle.ts`）与
  `fixtures/problem-bundle-manifest.json` 同步；旧题包缺 `models` 合法。
- 旧版 core 读到含 `models` 的题包：`isValidLlmConfig`
  对未知键静默忽略，降级为平台默认（安全）。

### 3.3 eval_token 与 JudgeTask（仅新增可选字段，向后兼容）

| 字段                      | 现状              | 变更                                          |
| ------------------------- | ----------------- | --------------------------------------------- |
| `provider_id`             | 平台默认 Provider | 不变；须是所选全部别名共同的 Provider         |
| `allowed_models`          | `[真实模型名]`    | **变为别名列表**（如 `["fast","reasoning"]`） |
| `model_map`（新增，可选） | —                 | `{ alias: 真实模型名 }`，随 token 加密签发    |

- 评测代码请求体里写 `model: "<别名>"`；评测机环境变量 `NOJ_LLM_ALLOWED_MODELS`
  即别名列表， noj-judge **无需改代码**（原样透传 `allowed_models`）。
- 仅 `models` 缺省（即 `["default"]`）时，为保持线上行为完全一致，core 仍签发
  `allowed_models: [真实模型名]` 且**不带** `model_map`——存量题的 token
  与现在逐字节同构。
- `judge-task.contract.json` 增加 `model_map` 可选字段及快照测试。

### 3.4 gateway 转发

`routes/llm.ts` 在 `allowed_models.includes(model)` 校验通过后：

1. 若 token 带 `model_map`：`upstreamModel = model_map[model]`，转发前改写请求体
   `model`； 缺失映射 → 400 `model_not_allowed`（token 畸形，不应发生）；
2. 无 `model_map`：行为不变；
3. 审计 `llm_usage.model` 记录**真实模型名**（便于核账），`request_params`
   额外记录 `model_alias`；
4. 响应体里的 `model` 字段保持上游返回值。

## 4. 版本冻结与重测

现有 `FrozenLlmExecution`（`provider_id` / `model` / 预算）扩展为：

```ts
interface FrozenLlmExecution {
  provider_id: string;
  model: string; // 旧字段：保留并等于 models[0].model，兼容旧快照
  max_calls: number;
  max_tokens: number;
  models?: { alias: string; model: string }[]; // 新增；缺省 = 旧快照，按单模型处理
}
```

- 题目发布 /
  提交评测时解析别名并写入冻结快照；重新派发只续签凭据，**不重新解析别名**；
- 管理员事后修改别名映射只影响此后新建的尝试与新版本，不影响重测——与现有「重测不换模型」语义一致；
- 旧快照无 `models` 字段：按 `[{alias:"default", model}]` 读取，无需数据迁移。

## 5. 约束：同一题的别名须属于同一 Provider

eval_token 只有一个 `provider_id`。校验在三处执行，文案一致：

1. 管理端写入别名映射时不校验（别名之间无关）；
2. **题目保存 / 题包导入**：对已存在的别名做校验——任一别名不存在，或所选别名跨
   Provider，返回 400
   并列出冲突项；别名尚未在本部署定义时，题包导入**允许并给出警告**（题包可能先于运营配置导入）；
3. **提交 / 重测解析（`buildJudgeTaskLlm`）**：最终兜底，不满足即
   400，提示「题目引用的模型别名 X 未配置」 或「所选别名属于不同
   Provider」。解析须先于任何状态变更（沿用 2026-09-22 评审收尾第 1 条）。

后续若需跨 Provider：token 改为 `providers: [{provider_id, model_map}]` 并由
gateway 按别名选路， 属于独立的 token
协议升级（`protocol_version: 3`），不在本稿范围。

## 6. 管理与出题界面

- **Provider 管理页**：新增「模型别名」卡片（位于「平台默认 Provider /
  模型」下方）：表格 + 新增 / 编辑 / 删除；`default`
  行只读并指向上方默认卡片；每行显示「被 N 道题引用」，被引用的别名
  删除时二次确认并列出题目。
- **出题编辑器**：LLM 区域新增「允许调用的模型」多选，选项来自
  `GET /api/v1/.../llm/model-aliases` （出题人可读，只返回别名与描述，**不返回
  Provider ID 与真实模型名**，不暴露 gateway 内部细节）； 缺省选中 `default`。
- **评测代码约定**：文档说明请求里写别名；`default` 总是可用。
- 别名可带可选 `description`（≤ 80
  字符，如「低延迟、低成本」），仅用于出题人下拉展示。

## 7. API

| 方法   | 路径                                             | 权限   | 说明                                 |
| ------ | ------------------------------------------------ | ------ | ------------------------------------ |
| GET    | `/api/v1/admin/gateway/llm/model-aliases`        | 管理员 | 完整映射（含 Provider、真实模型）    |
| PUT    | `/api/v1/admin/gateway/llm/model-aliases/:alias` | 管理员 | 新增 / 更新；带 `If-Match` 乐观锁    |
| DELETE | `/api/v1/admin/gateway/llm/model-aliases/:alias` | 管理员 | 被引用时需 `?force=true`             |
| GET    | `/api/v1/problems/llm-model-aliases`             | 出题人 | 仅别名 + description（含 `default`） |

写入均走 `adminAudit`（`llm_model_alias.upsert|delete`）。

## 8. 迁移与兼容

- 无 SQL 迁移（别名存设置；`llm_config` 为 JSONB）；gateway 无 schema 变更；
- 新旧组件交错发布安全：
  - 新 core + 旧 gateway：仅在题目使用非 `default` 别名时才会签发带 `model_map`
    的 token，旧 gateway 会因 `allowed_models`
    含别名而按别名原样转发给上游并失败 → **发布顺序：先 gateway，后 core**；
    发布说明需注明；
  - 旧 core + 新 gateway：token 无 `model_map`，行为不变。
- 存量题 / 题包 / 冻结快照零改动。

## 9. 测试计划

- core：别名校验、`buildJudgeTaskLlm`（缺省 / 单别名 / 多别名 / 跨 Provider /
  别名缺失 / 冻结快照 / 旧快照）、
  题目保存与题包导入校验、路由权限（出题人不得读真实模型）、审计；
- gateway：别名改写与审计字段、无 `model_map` 回归、畸形 token；
- 契约：`judge-task.contract.json` 快照（含 / 不含 `model_map`）、`noj-cli`
  fixture 双侧等价；
- E2E（`noj-tests/e2e/cross-domain/llm_gateway.test.ts`）：两个别名映射到 mock
  上游的不同模型，
  验证评测代码用别名调用后上游收到真实模型名，且改别名后重测仍使用旧模型；
- 前端：别名卡片与出题多选的组件测试。

## 10. 风险与待决问题

| # | 问题                                    | 倾向                                                                               |
| - | --------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 | 别名存设置（JSON）还是单独表            | 优先设置；先确认注册表支持 JSON（§3.1）                                            |
| 2 | 题包导入时别名未定义：拒绝还是警告      | 警告并允许（§5）                                                                   |
| 3 | 评测代码未写别名而写了真实模型名        | 返回 `model_not_allowed`，错误信息列出可用别名                                     |
| 4 | 别名被删除后引用它的已发布题            | 删除需 force；提交时 400 明确提示；版本冻结的重测不受影响                          |
| 5 | 排队（RPM/TPM）按 Provider 而非模型计数 | 沿用；同 Provider 多模型共享额度，符合多数上游的账号级限额，若上游按模型限流再扩展 |

## 11. 实施拆分（建议）

1. gateway：`model_map` 解析与改写、审计字段、契约与测试（可独立先发）；
2. core：别名设置与管理 API、`buildJudgeTaskLlm` / 冻结快照、题目与题包校验；
3. ui + noj-cli + 文档：别名卡片、出题多选、题包格式文档；
4. E2E 与发布说明（注明「先 gateway 后 core」）。
