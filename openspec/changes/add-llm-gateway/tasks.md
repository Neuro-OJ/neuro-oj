## 1. 数据库与基础配置

- [ ] 1.1 新增 `noj-llm-gateway` 服务目录与基础骨架（package.json/deno.json、入口、健康检查）
- [ ] 1.2 新增数据库迁移：`problems.llm_config` JSONB 可空列
- [ ] 1.3 新增数据库迁移：`llm_providers`、`llm_usage`、`llm_quotas` 表
- [ ] 1.4 在 `.env.example` / `.env.prod.example` 增加 `NOJ_LLM_SERVICE_TOKEN`、`NOJ_LLM_STORE_KEY` 及说明
- [ ] 1.5 在 docker-compose 增加 `noj-llm-gateway` 服务（环境变量、网络、依赖 Redis/PG）

## 2. noj-llm-gateway 核心实现

- [ ] 2.1 实现 `SecretStore` 接口与默认 Env 实现（`NOJ_LLM_STORE_KEY`）
- [ ] 2.2 实现 Provider CRUD 服务：加密存储 API Key、脱敏返回、启停
- [ ] 2.3 实现 AEAD `eval_token` 签发与校验工具（载荷、TTL = Time Limit × 4）
- [ ] 2.4 实现 OpenAI 兼容代理端点 `POST /v1/chat/completions`（Bearer token 校验、转发、错误透传）
- [ ] 2.5 实现 Redis 限流/额度计数：单次提交、用户日/月、全局日/月、题目日/月、用户/IP 速率窗口
- [ ] 2.6 实现 `llm_usage` 审计写入：完整 `request_messages`、参数、token、费用、状态
- [ ] 2.7 实现 core↔gateway 管理 API 鉴权（`NOJ_LLM_SERVICE_TOKEN`）
- [ ] 2.8 为 gateway 核心服务编写单元测试（token 校验、限流、Provider 加密）

## 3. noj-core 集成

- [ ] 3.1 新增 LLM 相关 service：Provider 管理、用量查询、配额配置
- [ ] 3.2 新增管理 API：`/api/v1/admin/llm/providers`、`/api/v1/admin/llm/usage`、`/api/v1/admin/llm/quotas`
- [ ] 3.3 题目 CRUD 支持 `llm` 字段并落库 `llm_config`；服务端强制准入校验（仅 P 型/官方/审核题 + 强制网络开启）
- [ ] 3.4 题目导入 `problem-bundle-import` 支持 `manifest.llm` 字段及校验
- [ ] 3.5 提交评测时：若题目启用 LLM，调用 gateway 签发 `eval_token`（或本地 AEAD mint），构造 `JudgeTask.llm`
- [ ] 3.6 重测（rejudge）时重新签发 `eval_token` 并放入新 JudgeTask
- [ ] 3.7 在题目详情/列表响应中返回脱敏的 `llm_config` 信息
- [ ] 3.8 为题目 CRUD/导入校验与 token 签发编写 noj-core 测试

## 4. noj-judge 集成

- [ ] 4.1 扩展 Rust `JudgeTask` 类型：新增可选 `llm` 字段（`gateway_url`、`eval_token`、`provider_id`、`allowed_models`）
- [ ] 4.2 在 Evaluator exec 创建时注入 `NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_PROVIDER_ID`、`NOJ_LLM_ALLOWED_MODELS`
- [ ] 4.3 确保 Solution exec 不注入任何 `NOJ_LLM_*` 环境变量
- [ ] 4.4 为 LLM 任务环境注入编写单元/集成测试

## 5. noj_evaluator_sdk.llm

- [ ] 5.1 在 evaluator SDK 增加 `llm` 模块（读取环境变量、OpenAI 兼容请求、错误处理）
- [ ] 5.2 提供 `llm.complete(model=..., messages=..., **params)` 高层 API
- [ ] 5.3 为 SDK `llm` 模块编写单元测试（含缺少环境变量、成功/失败响应）

## 6. noj-ui 管理端

- [ ] 6.1 新增 Provider 管理页面：列表、创建、编辑、启停、Key 更新（脱敏展示）
- [ ] 6.2 新增用量查询页面：按时间/用户/题目/Provider/状态筛选，聚合指标
- [ ] 6.3 新增用量详情/导出 CSV（不包含敏感凭据）
- [ ] 6.4 题目编辑页：LLM 配置表单与“必须开启 Evaluator 联网”提示
- [ ] 6.5 为管理端页面接入 API 并编写基础组件测试

## 7. 端到端与部署

- [ ] 7.1 编写跨模块 E2E：创建 Provider → 创建 P 型 LLM 题 → 提交 → evaluator 经 gateway 调用 Mock LLM → 用量落库
- [ ] 7.2 编写 E2E：U 型题/未审核题携带 `llm` 被拒；LLM 题未开网络被拒
- [ ] 7.3 编写 E2E：重测重新签发 token 且旧 token 不可用于新评测
- [ ] 7.4 更新部署文档/README：新增服务、环境变量、网络要求、安全说明
- [ ] 7.5 更新 OpenSpec 归档准备：`/opsx:apply` 后按流程归档
