# noj-llm-gateway

LLM 调用网关，作为 evaluator 与外部 OpenAI 兼容 LLM API 之间的可信代理边界。

## 职责

- 托管上游 Provider 配置，真实 API Key 使用 `NOJ_LLM_STORE_KEY`
  信封加密后存储，任何接口都不返回明文 Key。
- 为每次评测签发/校验短期 AEAD `eval_token`，绑定
  `domain_id / attempt_id / submission_id / problem_id / user_id / provider_id / allowed_models`。
  当前协议为 v3；缺少使用域、尝试 ID 或使用旧协议的凭据拒绝执行。
- 提供 OpenAI 兼容代理端点 `POST /v1/chat/completions`，evaluator 通过
  `NOJ_LLM_TOKEN` 调用。
- 基于 Redis Lua 原子脚本执行限流/额度检查：单次尝试、实例总额、Domain 总额、
  域内用户、域内题目与域内用户×题目的日/月 calls/tokens/cost，及用户/IP
  分钟速率。
- 将调用审计写入 `llm_usage` 表，供管理后台查询。
- 负责 `llm_providers` / `llm_usage` / `llm_quotas` 三张表的迁移与默认配额
  seed。

## 环境变量

| 变量                                       | 必填 | 说明                                                          |
| ------------------------------------------ | ---- | ------------------------------------------------------------- |
| `DATABASE_URL`                             | 是   | PostgreSQL 连接串                                             |
| `REDIS_URL`                                | 是   | Redis 连接串                                                  |
| `NOJ_LLM_SERVICE_TOKEN`                    | 是   | core↔gateway 管理 API 鉴权 + eval_token 签发/校验（≥16 字符） |
| `NOJ_LLM_STORE_KEY`                        | 是   | 加密 Provider API Key 的主密钥（≥16 字符）                    |
| `NOJ_LLM_PORT` / `PORT`                    | 否   | 监听端口，默认 `8001`                                         |
| `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE`       | 否   | 每个用户每 UTC 分钟调用次数，默认 `60`，正整数                |
| `NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE`         | 否   | 每个 IP 每 UTC 分钟调用次数，默认 `60`，正整数                |
| `NOJ_LLM_USAGE_RETENTION_DAYS`             | 否   | `llm_usage` 用量审计保留天数，默认 `90`，`0` 表示不清理       |
| `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`           | 否   | 允许 http / 内网地址的上游主机白名单（逗号分隔），默认为空    |
| `NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>` | 否   | LLM 默认配额兜底值，见下节                                    |

### LLM 默认配额 fallback（`NOJ_LLM_DEFAULT_*`）

`SCOPE` ∈ `GLOBAL|USER|PROBLEM|USER_PROBLEM`，`WINDOW` ∈ `DAY|MONTH`，`FIELD` ∈
`CALLS|TOKENS|COST`， 共 **24 个**变量，例如
`NOJ_LLM_DEFAULT_PROBLEM_MONTH_COST`。

- **生效条件**：实例总额与默认域原有维度缺少精确配额记录时使用原有
  env/内置限制。 新 Domain 未配置的数值配额为
  `null`（未限制），不继承默认域的配额配置； 实例总额与单次尝试预算仍检查。`0`
  表示禁止，`null` 表示未限制。 `user`、`problem`、`user_problem` 的 `scope_id`
  精确匹配，不使用空 ID 通配。
- **消费方是 llm-gateway，不是 noj-core**（issue #497）：这些键不出现在 noj-core
  管理后台，改动后需**重启 llm-gateway**（重启 core 无效）。
- **声明位置**：`src/config-registry.ts`；`noj-core` 的
  `deno task check:config-usage` 会跨服务校验「声明 ↔ 读取点」一致性，
  `tests/config_registry_test.ts` 钉死枚举集合，避免新增窗口时静默漏登记。

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
deno task db:migrate # 执行 LLM 表迁移（幂等）
deno task db:generate # 使用时间戳前缀生成下一份增量迁移
```

分钟限流配置在网关启动时读取和校验；缺失时继续使用每个用户和 IP 每分钟 60 次。
设置后重启网关即可生效，`0`、负数、小数、空值和非数字值会阻止网关启动。

## 内部管理 API

以下端点使用 `Authorization: Bearer <NOJ_LLM_SERVICE_TOKEN>` 鉴权，仅 noj-core
管理端使用。`X-Noj-Domain-Id` 由 core 已授权的工作空间上下文设置；缺省仅映射固定
默认域，body、query 不接受归属覆盖。Provider 与用量查询、更新均追加该域条件：

- `GET /internal/providers` — Provider 列表（Key 已脱敏）
- `GET /internal/providers/:id` — Provider 精简信息（不含 Key）
- `POST /internal/providers` — 新增 Provider
- `PUT /internal/providers/:id` — 更新本域 Provider，支持 `enabled` 与单价配置
- `DELETE /internal/providers/:id` — 停用本域 Provider，保留历史引用，不物理删除
- `POST /internal/providers/:id/test` — Provider 连通性测试（**必须带
  `model`**， 缺失返回 400 `model_required`）
- `GET /internal/usage` — 用量查询（支持
  submission/user/problem/provider/status/时间范围/分页）
- `GET /internal/quotas` — 配额列表
- `POST /internal/quotas` — 新增或更新配额

Provider 创建、更新、停用及配额写入都必须带 `If-Match`。新建使用 0；Provider
和配额行的初始 revision 为 1，更新使用列表或详情中读取的 revision。更新和停用 在
PostgreSQL 的 UPDATE 条件中比较 Domain、ID 和 revision，成功后原子增加版本。
缺少前置条件返回 428，已有资源版本冲突返回 409，其他域或不存在的 ID 返回 404。
配额写入不再按缺失 id 自动插入；新增不传 id，更新明确传既有 id。 显式 null
数值保存为 SQL NULL，表示未限制，不触发默认额度。

实例配额 `scope_type=global` 额外需要 `X-Noj-Instance-Quota: 1`；Domain
管理端不能发送该标记。实例配额列表使用相同标记，返回 `domain_id=''` 的实例行；
普通列表只返回使用域的配额，互不混合。新域引用公共题时仍必须使用本域
Provider，没有本域配置时拒绝新尝试。 执行 token 的使用域必须与 Provider
归属一致，任何不匹配在调用上游和扣额度前拒绝。

迁移将原 Provider、用量和域内配额归入固定默认域，保留实例 global 配额。
`0000_volatile_umar.sql` 是首次 Drizzle snapshot 登记文件（无 DDL），实际增量在
`0005_domain_ownership.sql`；以后生成迁移使用时间戳前缀，不重编号历史文件。

## 域隔离验收

标准 `deno task test` 始终覆盖凭据、Provider、用量与配额键隔离。真实数据库与
Redis 测试可在隔离测试库运行：

```bash
NOJ_GATEWAY_TEST_DATABASE_URL=postgres://noj:noj@127.0.0.1:5432/noj_gateway_test \
NOJ_GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:6379/14 deno task test
```

数据库测试为每次运行建立随机 schema，验证空库、原 0000–0004 升级、重复迁移及
跨域 ID 请求。Redis 测试所有 Lua
键使用随机前缀，验证并发最后一次额度、实际结算、
域间独立及实例总额，结束后只删除本次键。没有相应环境变量时两项集成测试跳过。
上游返回后的用量可能超过预估，结算会如实记录超额；预占额度并非上游账单的绝对封顶。

## 安全说明

- `NOJ_LLM_SERVICE_TOKEN` 同时控制 eval_token 签发和管理
  API，泄露可伪造调用凭证，请与 core 保持一致并妥善保管。
- `NOJ_LLM_STORE_KEY` 泄露会解密所有 Provider Key；轮换后需重新加密已存 Key。
- 真实上游 Key 不进入 evaluator 容器、日志或提交代码。

## 调用账本与额度恢复

每次受理生成 `X-Noj-Call-Id`。`llm_call_ledger` 在上游调用前保存使用域、尝试及
预占计数快照，已知实际用量与待结算快照同事务写入数据库。Redis 结算使用同一调用
ID 的幂等标记；Lua 已执行但回复丢失、数据库提交失败时可以继续重放，保持额度只扣
一次。快照保存原窗口与绝对失效时刻，延迟补算不会移到下一日/月。

后台每 5 秒从数据库以 `FOR UPDATE SKIP LOCKED` 领取待结算记录，服务重启继续读取
持久事实。Redis 暂时不可用时返回 503
`accounting_pending`，实际用量已保存；恢复后 继续结算。预占基础设施故障返回 503
`quota_unavailable`，与明确额度不足的 429 区分。 受理前检查 Redis 进程身份与共享
ready 标记；整库丢失或重启恢复旧快照后先按账本
重建，再受理新调用。存在无法重建的旧窗口时保持拒绝，等待明确建立测量基线。
网络失败无法证明上游未计费，保留预估占用及 `unknown` 状态；进程退出留下的预占
三分钟后也会列为未知，供治理核对，不自动重发上游。

实例治理（服务凭据及 `X-Noj-Instance-Quota: 1`）可使用：

- `GET /internal/accounting`：当前头指定域的待结算/未知定位；只返回
  ID、状态与时间。
- `POST /internal/accounting/reconcile`：从账本重建活动额度键；排他数据库锁与受理/
  结算共享锁协调，避免覆盖并发调用。
- `POST /internal/accounting/bootstrap`：旧开发窗口首次建立测量基线。扫描实际存在
  的 Redis 计数及 TTL，扣除已进入新账本的用量，把旧平台域内维度映射至 main。
  Redis 和 DB 之间发生失败时复用同一基线标记，不重复累加。

旧审计没有预占快照，`reconcile` 会返回 409
`accounting_legacy_window_requires_baseline`，保护原计数。先核对并执行明确的
`bootstrap`；没有可测旧计数则返回
`accounting_baseline_counts_missing`，未处理的新 调用状态则返回
`accounting_baseline_unresolved_calls`，由平台治理核对后处理。基线
只覆盖实际测得的键和值，不把丢失的 Redis 数值或旧上游账单猜成零。

新 HTTP 请求生成新调用 ID；后台对同一笔结算重试的幂等性不代表上游支持重复 POST
去重。完整账单仍以 Provider 记录为准。

## 实例对各域的 LLM 上限

Gateway 通过 `NOJ_CORE_INTERNAL_URL` 在每次调用前读取 core 内部
`GET /api/v1/internal/llm/quota-caps`（同一服务凭据）。持久实例设置
`domain_llm_quota_caps` 提供日/月 `max_calls`、`max_tokens`、`max_cost`，默认全
`null`。Domain 配额与实例上限取较小值，平台降低配置后下一次调用即时生效；政策
读取不可用时返回 503 `quota_policy_unavailable`，尚未预占或调用上游。

Domain 管理员保存配额时也检查该持久上限，不能用更大数值或 `null` 解除数值上限。
域日/月总额度的当前有限维度只允许降低，换新 ID 也不能绕过；平台治理可在实例
上限内提高。相同域窗口有多条记录时，各维度取最严格有限值，保留原记录；用户/
题目分配额度仍可在总限制内调整。新域缺省配额为 `null`，默认域及实例原数值限制
保留。成本额度为整数，单位与 管理员设置的 Provider 每 1K token
单价一致，未固定为特定货币。
