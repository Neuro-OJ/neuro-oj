# noj-llm-gateway

LLM 调用网关，作为 evaluator 与外部 OpenAI 兼容 LLM API 之间的可信代理边界。

## 职责

- 托管上游 Provider 配置，真实 API Key 使用 `NOJ_LLM_STORE_KEY`
  信封加密后存储，任何接口都不返回明文 Key。
- 为每次评测签发/校验短期 AEAD `eval_token`，绑定
  `submission_id / problem_id / user_id / provider_id / allowed_models`。
- 提供 OpenAI 兼容代理端点 `POST /v1/chat/completions`，evaluator 通过
  `NOJ_LLM_TOKEN` 调用。
- 基于 Redis Lua 原子脚本执行限流/额度检查：单次提交、用户/全局/题目日/月维度
  calls/tokens/cost，以及用户/IP 分钟速率窗口。
- 将调用审计写入 `llm_usage` 表，供管理后台查询。

## 环境变量

| 变量                    | 必填 | 说明                                                          |
| ----------------------- | ---- | ------------------------------------------------------------- |
| `DATABASE_URL`          | 是   | PostgreSQL 连接串                                             |
| `REDIS_URL`             | 是   | Redis 连接串                                                  |
| `NOJ_LLM_SERVICE_TOKEN` | 是   | core↔gateway 管理 API 鉴权 + eval_token 签发/校验（≥16 字符） |
| `NOJ_LLM_STORE_KEY`     | 是   | 加密 Provider API Key 的主密钥（≥16 字符）                    |
| `NOJ_LLM_PORT` / `PORT` | 否   | 监听端口，默认 `8001`                                         |

本地开发可复制 `.env.example` 为 `.env` 后启动：

```bash
cp .env.example .env
deno task dev
```

## 常用命令

```bash
deno task dev        # 热重载开发
deno task start      # 启动
deno task test       # 运行测试
deno task check      # fmt + lint + typecheck
```

## 内部管理 API

以下端点使用 `Authorization: Bearer <NOJ_LLM_SERVICE_TOKEN>` 鉴权，仅 noj-core
管理端使用：

- `GET /internal/providers` — Provider 列表（Key 已脱敏）
- `GET /internal/providers/:id` — Provider 精简信息（不含 Key）
- `POST /internal/providers` — 新增 Provider
- `PUT /internal/providers/:id` — 更新 Provider
- `GET /internal/usage` — 用量查询（支持
  submission/user/problem/provider/status/时间范围/分页）
- `GET /internal/quotas` — 配额列表
- `POST /internal/quotas` — 新增或更新配额

## 安全说明

- `NOJ_LLM_SERVICE_TOKEN` 同时控制 eval_token 签发和管理
  API，泄露可伪造调用凭证，请与 core 保持一致并妥善保管。
- `NOJ_LLM_STORE_KEY` 泄露会解密所有 Provider Key；轮换后需重新加密已存 Key。
- 真实上游 Key 不进入 evaluator 容器、日志或提交代码。
