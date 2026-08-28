## Context

NOJ 当前评测模型是双容器：Evaluator（出题人 `evaluate.py`）通过 `noj_evaluator_sdk.SolutionRunner` 调用 Solution 容器中的用户函数。现有能力只覆盖确定性函数评测；而 LMCC 第二轮上机题包含大量“考生提供 Prompt/生成参数，评测器调用真实 LLM 生成结果”的题目，以及少量“数据构造 + 模型微调”型题目。

直接让 evaluator 持有上游 API Key 不可行：evaluator 运行的是出题人代码，U 型题允许任意注册用户创建，key 会被恶意出题人读取。同时缺少统一限流、防滥用、用量审计与结算能力。

本项目新增独立服务 `noj-llm-gateway`，作为 evaluator 与外部 OpenAI 兼容 LLM API 之间的可信代理边界。

## Goals / Non-Goals

**Goals:**
- 提供安全的上游 LLM API 调用通道：真实 Key 永不出现在 evaluator 容器。
- 支持题目级固定 `provider_id + model`，做题人不可选择。
- 支持短期 `eval_token`，绑定 `submission_id/problem_id/user_id/provider_id`，可限流、可计量、可审计。
- 支持按单次提交/用户/全局/题目维度的限流与额度控制。
- 提供管理端 Provider 配置与用量/费用查询。
- 支持 LLM 调用题在现有双容器评测栈上运行。
- 为微调类题目提供“数据构造 + 外部 API 评测”的降级适配方向。

**Non-Goals:**
- 不做多租户/机构表；学校自部署场景下整个实例即一个机构。
- 不做多 provider 自动路由/负载均衡/故障转移；题目固定绑定单个 provider。
- 不做本地 GPU 模型推理。
- 不做模型微调/远端训练任务（第一版）。
- 不负责题目导入/题库整理。
- 不引入 deny list 做 token 撤销；撤销依赖短 TTL 与重测重新签发。
- 不自动清理 `llm_usage` 审计数据。

## Decisions

### 1. 新增独立 `noj-llm-gateway` 服务
- 自研薄网关，不魔改 New API/One API。
- 上游由学校/管理员自己管理（任意 OpenAI 兼容服务）。
- 理由：NOJ 需要的是“短期 eval_token + NOJ 上下文限流 + 审计”，与 New API 的长期 token/渠道管理模型不匹配；自研薄网关更贴合且无 license 风险。
- 不提供多 provider 自动路由/故障转移；如需多个上游，管理员可为不同题目配置不同 provider，由题目元数据固定选择。

### 2. AEAD 自包含 eval_token
- 使用 AES-256-GCM 签发自包含 token，`NOJ_LLM_SERVICE_TOKEN` 由 noj-core 与 noj-llm-gateway 共享。
- token payload 包含：`jti`、`submission_id`、`problem_id`、`user_id`、`provider_id`、`allowed_models`、`iat`、`exp`、`max_calls`、`max_tokens`。
- `Token TTL = 题目 evaluator Time Limit × 4`。
- 不建 `llm_tokens` 表，不引入 deny list。
- 重测时每次重新签发新 token；旧 token 自然过期。
- 理由：省去 token 表与撤销状态；自部署场景下短 TTL 足够。

### 3. 限流/额度状态放 Redis
- 必需状态：
  - `llm:sub:{submission_id}:calls/tokens/cost`（TTL = Time Limit × 4）
  - `llm:user:{user_id}:day:{date}:calls/tokens/cost`
  - `llm:global:day:{date}:calls/tokens/cost`
  - `llm:problem:{problem_id}:day:{date}:calls/tokens/cost`
  - `llm:rate:{user_id|ip}:{minute}`
- 使用 Redis 原子 `INCR/INCRBY`；`llm_usage` PG 表只做审计/结算，不承担高频限流。

### 4. 上游 Key 加密存储
- `llm_providers.encrypted_api_key` 使用 AES-256-GCM 加密，主密钥 `NOJ_LLM_STORE_KEY` 从环境/SecretStore 读取，不落 DB。
- `SecretStore` 接口预留：env → Vault/KMS/TPM。

### 5. 题目 LLM 元数据
- `problem.json` 与题目 CRUD API 新增可选 `llm` 配置：
  ```json
  {
    "provider_id": "uuid",
    "model": "qwen-plus"
  }
  ```
- 落库到 `problems.llm_config` JSONB（可空）。
- 出题人固定 `provider_id/model`，做题人不可选。
- 启用 `llm` 的题目必须同时满足：
  - 仅管理员创建的 P 型/官方题或审核通过的题目；
  - `runtime_config.evaluator.network.enabled = true`。
- 创建/变更接口在服务端强制校验，不满足返回 400/403。

### 6. JudgeTask 传递与 evaluator 注入
- `JudgeTask` 新增 `llm` 字段：
  ```json
  {
    "gateway_url": "http://noj-llm-gateway:8000",
    "eval_token": "...",
    "provider_id": "...",
    "allowed_models": ["qwen-plus"]
  }
  ```
- noj-judge 在创建 evaluator exec 时通过 `ExecConfig.env` 注入：
  - `NOJ_LLM_GATEWAY_URL`
  - `NOJ_LLM_TOKEN`
  - `NOJ_LLM_PROVIDER_ID`
  - `NOJ_LLM_ALLOWED_MODELS`
- `noj_evaluator_sdk.llm` 读取这些环境变量，提供 `llm.complete(...)` OpenAI 兼容封装。
- Solution 容器不接触任何 LLM 配置。

### 7. 管理端
- 第一版包含 Provider 配置 UI：新增/编辑/启停 provider（`base_url`、`model`、加密 Key）。
- 用量查询 UI：按用户/题目/时间范围查看调用次数、token、费用、状态；支持导出。
- 后端提供 `/api/v1/admin/llm/providers`、`/api/v1/admin/llm/usage` 等管理 API。

### 8. 微调题降级
- 不提交模型目录；考生实现 `build_training_data()` 等函数返回训练数据。
- Evaluator 校验数据质量，并用这些数据作为 few-shot / function-calling 示例，走外部 API 评测。
- 真微调/远端微调作为后续扩展。

### 9. 新增密钥职责

| 密钥 | 职责 | 谁持有/使用 | 泄露影响 | 轮换影响 |
|---|---|---|---|---|
| `NOJ_LLM_SERVICE_TOKEN` | AEAD `eval_token` 签发/校验 + core↔gateway 管理 API 服务间鉴权；token 自包含绑定 `submission_id/problem_id/user_id/provider_id/model/TTL` | noj-core 与 noj-llm-gateway 共享 | 攻击者可伪造 `eval_token` 调用 gateway，也可管理 Provider/查看用量，但无法解密上游 Key | 轮换会使所有未过期 token 失效，并需双端同步更新服务间鉴权 |
| `NOJ_LLM_STORE_KEY` | 信封加密主密钥，用于加密/解密 `llm_providers.encrypted_api_key` | 仅 noj-llm-gateway（经 SecretStore 读取） | 攻击者可解密数据库中所有上游 API Key | 轮换后必须用新主密钥重新加密所有 Provider Key |

> 两个密钥职责分离：`NOJ_LLM_SERVICE_TOKEN` 管“动态调用凭证 + 服务间管理面鉴权”，`NOJ_LLM_STORE_KEY` 管“静态上游密钥加密”。即使其中一个泄露，不应直接波及其他。

## Risks / Trade-offs

- [AEAD token 无法主动撤销] → 短 TTL（Time Limit × 4）；重测重新签发；token 绑定 submission 上下文，泄露窗口有限。
- [core 持有 `NOJ_LLM_SERVICE_TOKEN`，被攻破可无限 mint] → 自部署场景下 core 已是高权限服务，风险可接受；未来可把 mint 密钥收口到 gateway。
- [Redis 计数丢失导致限流失效] → 计数仅用于限流，丢失后最多放宽一次窗口；`llm_usage` PG 仍保留审计。
- [`request_messages` 包含隐藏测试数据且永久保留] → 访问控制限定 admin/机构管理员；文档声明数据保留策略。
- [外部 LLM API 延迟/不可用影响评测] → 单次调用超时、重试策略、评测总时限放大；gateway 返回标准化错误。
- [恶意用户通过大量提交刷 token] → core 侧提交限流 + 用户/全局额度 + LLM 题目准入 + 行为风控。
- [U 型题自定义 evaluate.py 滥用 gateway] → 默认禁止 U 型题启用 LLM；仅 P 型/官方/审核题可绑定。

## Migration Plan

1. 新增 `noj-llm-gateway` 服务骨架与数据库迁移（`llm_providers`、`llm_usage`、`llm_quotas`）。
2. noj-core 接入：新表服务、管理 API、题目 CRUD/导入校验、`JudgeTask.llm` 签发。
3. noj-judge：类型扩展与 evaluator exec 环境变量注入。
4. noj-ui：Provider 配置页、用量查询页、题目编辑提示。
5. 部署：新增容器与 2 个环境秘密（`NOJ_LLM_SERVICE_TOKEN`、`NOJ_LLM_STORE_KEY`），Redis/PG 复用现有实例。
6. 首批人工适配 1–2 道 LLM 调用题做端到端验证。

回滚：关闭 LLM 题目开关/移除 `llm_config` 即可停止 gateway 调用；`noj-llm-gateway` 可独立下线，不影响普通评测。

## Open Questions

- 管理端用量查询的导出格式（CSV/JSON）与聚合粒度。
- 微调题降级版的评测口径需要按具体题目单独设计。
