# 如何提供 LLM 调用能力（运营者）

本页面向运营者/管理员：如何在本实例上提供“LLM 调用能力”，让出题人可以创建
调用真实 LLM API 的题目。

> 若只需**能提交 LLM 题**，关键就三步：gateway 两个密钥就位 → 后台建一个启用
> 的使用域 Provider → 在该域选择默认 Provider 和模型。缺少域内配置时，提交返回
> `DOMAIN_LLM_NOT_CONFIGURED`，不会借用其他域的密钥。

## 总体流程

1. 部署并配置 `noj-llm-gateway`。
2. 在使用域的「LLM 管理」添加并启用 Provider。
3. 配置该域默认 Provider 与模型。
4. 按需配置实例、域及域内用户／源题／用户×源题配额。
5. 确认 Judge Worker 的 evaluator 能访问 gateway。
6. 出题人在题库创建 LLM 题并完成评测验证。

出题人侧的接入说明见 [出 LLM 调用题](../problemsetters/llm-problem.md)。

## 1. 部署 noj-llm-gateway

生产环境使用 `docker-compose.prod.yml`：

- 必须设置 `NOJ_LLM_SERVICE_TOKEN`（core↔gateway 服务间鉴权 + eval_token
  签发/校验，≥16 字符）。
- 必须设置 `NOJ_LLM_STORE_KEY`（加密 Provider API Key，≥16 字符）。
- `llm-gateway` 容器加入 `noj-net`，core 通过 `http://llm-gateway:8001` 访问。

::: warning 即使不做 LLM 题也必须填这两个密钥 `docker-compose.prod.yml`
默认**始终启动** `llm-gateway` 且对这两个密钥使用 `${...:?}`
必填校验，缺失会导致 `docker compose config` 直接报错。 :::

网关分钟限流可通过环境变量调整：

- `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE`：每个用户在 UTC 分钟窗口内的调用上限。
- `NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE`：每个 IP 在 UTC 分钟窗口内的调用上限。
- 两项均为可选正整数，默认均为 `60`；配置缺失不会改变既有行为。
- 配置在网关启动时读取，修改后需重启 `llm-gateway`；非法值会导致启动失败。

Provider 上游地址（Base URL）的出站限制：

- 默认只允许 **https 公网地址**。`localhost`、Docker
  服务名等不带点的短名、`*.internal` / `*.local` / `*.lan`、私网与回环
  IP、云元数据地址（`169.254.169.254`）均会被拒绝； 网关每次调用上游前还会解析
  DNS，域名解析到内网地址同样被拦截（防止借网关访问内网服务）。
- 内网自建模型（如 vLLM）需在 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`
  中显式放行主机名或 IP （逗号分隔），白名单内的主机允许 http 与内网地址。
- 被拦截时后台保存 Provider 会提示"Base URL 不被允许"；评测中的调用返回
  `provider_base_url_blocked`，不消耗额度。

用量审计（`llm_usage` 表）的保留与写入规则：

- `NOJ_LLM_USAGE_RETENTION_DAYS`：保留天数，默认 `90`，`0`
  表示不清理。网关启动时及之后每 6
  小时删除过期记录；多副本部署时同一轮只有一个副本执行。
- 调用前就被限流或额度拒绝的请求**不保存 prompt
  原文**（只保留哈希），且同一提交、同一拒绝原因 60
  秒内只记录一条，避免被拒请求持续写库；拒绝次数仍可从
  `noj_llm_rate_limited_total` 指标查看。

## 2. 创建并启用 Provider

在 `/d/:slug/llm` 的 Provider 管理中新增上游 OpenAI 兼容服务：

- 名称：便于识别的显示名。
- Base URL：上游服务地址（如 `https://api.openai.com/v1`）。
- API Key：仅保存到 gateway，加密存储；列表只显示掩码。
- 费用/1K token：用于用量估算。
- 启用状态：只有 `enabled=true` 的 Provider 才能被 LLM 题目使用。
- RPM / TPM 上限：按上游账号限额填写每分钟请求数与 token 数，`0` 表示不限。

> Provider 不自带默认模型；调用哪个模型由使用域配置决定。

保存后可点击「测试连接」，指定模型，使用本域已保存的 Key 发起一次
`max_tokens: 1` 的真实请求（10 秒超时，产生少量费用），验证地址、密钥和模型。

### 模型别名（逐题选择模型）

域内「模型别名」卡片维护 `别名 → 本域 Provider + 真实模型`。题目中的
`llm.models`
只声明允许调用的能力名称；引用题在目标域解析这些名称，不携带源域的密钥或模型选择。

- `default` 是保留别名，表示使用域的默认 Provider 与模型，不写入别名表。未声明
  `models` 时使用它。
- 同一次评测所用的别名必须解析到同一个本域 Provider。
- 发布题目仅校验别名语法；缺少本域配置或别名映射时，新提交返回明确错误，不回退至
  main 或源域。
- 修改别名映射只影响新建评测尝试。每次新重测也重新解析并冻结当时配置；已经创建的尝试保持其冻结映射。
- 别名修改和删除使用 revision 检查。删除后依赖该名称的新提交须等管理员重新配置。

### Provider 速率上限与排队

上游服务按账号限制每分钟请求数（RPM）与 token 数（TPM）。配置本域 Provider
后，网关在转发前节流：

- 超过上限的请求按到达顺序排队，窗口有余量后转发。
- 使用 60 秒滑动窗口；TPM 先按 prompt 估算与 `max_tokens`
  预占，响应后按实际用量修正。
- 超过 `NOJ_LLM_PROVIDER_QUEUE_TIMEOUT_SECONDS`（默认 `60`，`0` 表示不排队）返回
  429、`provider_queue_timeout` 与 `Retry-After`；未转发的调用释放预占额度。
- 排队状态保存在 Redis，多副本共享；失效的排队记录按租约清理。
- 指标包括 `noj_llm_provider_queue_wait_seconds` 与
  `noj_llm_provider_queue_timeouts_total`。

## 3. 配置使用域默认 Provider 与模型

题目版本描述 LLM 能力与单次预算。域负责人或管理员在 `/d/:slug/llm`
选择本域已启用的 Provider，并明确填写模型名，两项一起保存。配置更新使用当前
revision，写库后用于新评测尝试。

- 未配置、Provider 不属于本域或已停用时，不创建新的上游调用。
- 学校引用公开题时，Provider、模型、提交、用量与额度均归学校。
- 新域不继承 main 或平台配置；不同域的 LLM 成绩不承诺可比。
- 每次尝试冻结 Provider、模型映射和预算，排队后修改默认值不改变该尝试。
- 旧 `llm_default_provider_id` / `llm_default_model`
  仅在默认域初始化时映射已有配置，不能作为其他域的执行回退。

## 4. 配额（可选）

域配额在 `/d/:slug/llm` 中维护，接口位于
`/api/v1/domains/:slug/llm/quotas`，支持域总量及域内用户、源题、用户×源题的
day/month calls/tokens/cost 上限。实例总量与上限由平台管理员治理。

- 域 API 的 `null` 表示不限，`0` 表示禁止调用，正数为上限；Gateway 内部旧数值
  使用 `-1` 表示不限。
- 更新使用配额资源的
  revision；域管理员不能通过本域接口修改实例总量或其他域额度。
- 同一源题在不同学校分别计数。上游调用前预估预占，结束后按实际用量结算，失败释放。
- 预估费用与上游实际账单可能有差异，不将预占额度描述为上游账单的绝对封顶。

用户×题目组合维度（`scope_type=user_problem`，`scope_id` 形如
`<userId>:<problemId>`）用于防止一名选手反复提交打满**本域选手共享**的题目日桶，
导致他人 LLM 题评测因 `out_of_usage` 得 0 分。默认兜底值见网关 `.env.example` 的
`NOJ_LLM_DEFAULT_USER_PROBLEM_*`（网关**启动期读取
env**，改动后需重启网关；`llm_quotas` 里的 占位行按 `scope_id=''` 写入，与
`<userId>:<problemId>` 精确匹配不上，不参与限额计算—— 需要单条覆盖时请写
`scope_id` 为具体组合的行）。

分钟维度限流对无客户端 IP 的评测流量（Evaluator 直连网关、无
`X-Forwarded-For`）按 submission 隔离，不再共用全局 `unknown` 桶。

## 5. 网络要求

LLM 调用题要求 evaluator 联网访问 gateway：

- `JUDGE_ALLOW_EVALUATOR_NETWORK=true`
- `JUDGE_EVALUATOR_NETWORK` 必须指向 `llm-gateway` 所在 Docker 网络，生产默认
  `noj-eval-net`（**评测隔离网络**：只承载 Evaluator 沙箱与 `llm-gateway`，
  沙箱因此能出公网、能访问 `http://llm-gateway:8001`，但对 postgres / redis /
  minio / core 的 DNS 与路由为 0）。**不得**填 `bridge` / `host`，noj-judge 会在
  启动校验中直接拒绝。
- Solution 容器始终无网，且不注入任何 `NOJ_LLM_*` 环境变量。

## 6. 验证

1. 在目标域确认 Provider 启用，且本域默认 Provider 与模型已填写。
2. 按出题人文档创建一道 LLM 题，或引用获授权公开题，并在目标域提交。
3. 在同一域的用量页确认调用记录已落库、状态为 `ok`，模型与评测尝试一致。

## 密钥与安全

- 轮换 `NOJ_LLM_SERVICE_TOKEN` 会让所有未过期 eval_token 失效，需 core 与
  gateway 同步更新。
- 轮换 `NOJ_LLM_STORE_KEY` 后需要用新主密钥重新加密所有 Provider Key。
- 真实上游 Key 不会出现在 evaluator 容器、支持包、日志或提交代码中。

更多部署细节见 [生产部署](production-deploy.md) 与
[后台管理指南](admin-guide.md)。
