## Why

LMCC 第二轮上机题大量涉及“考生编写 Prompt/生成参数 → 评测器调用真实 LLM 生成结果”的形态，现有 NOJ 双容器评测栈没有安全、可计量、可审计的 LLM 调用通道。直接让 evaluator 持有上游 API Key 会把密钥暴露给不可信的出题人代码，也无法统一限流、防滥用和用量结算。

## What Changes

- 新增独立服务 **`noj-llm-gateway`**：负责上游 LLM API Key 加密托管、AEAD `eval_token` 签发/校验、OpenAI 兼容代理、限流/额度、用量计量与审计。
- 新增题目 LLM 元数据：题目可在 `problem.json` / 题目 API 中声明可用的 `provider_id` 与 `model`，由出题人固定，做题人不可选择。
- 新增 `JudgeTask.llm` 字段：每次评测由 noj-core 签发短期 `eval_token`，随任务传给 noj-judge，再注入 evaluator 容器环境变量。
- `noj_evaluator_sdk` 新增 `llm` 模块，evaluator 通过统一 OpenAI 兼容接口访问 gateway。
- 管理端新增 Provider 配置 UI 与 LLM 用量/费用查询 UI。
- 安全约束：仅管理员创建的 P 型/官方题或审核通过的题目可启用 LLM；启用 LLM 的题目必须同时启用 evaluator 网络，创建/变更接口强制校验。
- 微调类题目降级为“数据构造 + 外部 API 评测”，不提交模型目录，作为后续适配方向。

## Capabilities

### New Capabilities
- `llm-gateway`: noj-llm-gateway 服务本身——provider 密钥托管、AEAD eval_token、OpenAI 兼容代理、限流/额度、用量/审计。
- `llm-problem-runtime`: 题目 LLM 元数据、权限准入、强制网络、JudgeTask.llm 传递、evaluator SDK 接入与重测重新签发。
- `llm-admin-console`: 管理端 Provider 配置与 LLM 用量查询/费用报表。

### Modified Capabilities
- `problem-bundle-import`: `problem.json` manifest 支持可选 `llm` 字段并做结构校验。
- `problem-management`: 题目 CRUD 支持 `llm_config`，并强制“仅受信题目可启用 + 启用 LLM 必须开启 evaluator 网络”。
- `database-schema`: `problems` 表新增可空 `llm_config` JSONB 列。
- `judge-worker`: `JudgeTask` 结构新增 `llm` 字段，并在 evaluator exec 中注入 gateway 地址与 eval_token 环境变量。

## Impact

- 新增服务：`noj-llm-gateway`（独立进程/容器）。
- noj-core：新增 `llm_providers`、`llm_usage`、`llm_quotas` 表与相关服务/路由；题目 CRUD/导入校验；评测任务签发 `eval_token`。
- noj-judge：`JudgeTask`/`RuntimeConfig` 类型扩展，evaluator exec 环境变量注入。
- noj-ui：管理端 Provider 配置页、用量查询页；题目编辑页 LLM 配置提示。
- 基础设施：新增环境秘密 `NOJ_LLM_SERVICE_TOKEN`、`NOJ_LLM_STORE_KEY`；Redis 用量计数；PG 新表。
