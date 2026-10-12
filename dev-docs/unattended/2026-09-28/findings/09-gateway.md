# 面 9 — noj-llm-gateway 审计报告

> 审计面：noj-llm-gateway ｜ 类型：**I 新面审计** ｜ 审计员：subagent（只读，覆盖 src 全部 22 个文件 / 3521 行）
> 派发/返回：2026-09-29 08:5x ｜ 复核：**未经独立复核**（按 L1 口径为单方证据）

## 1. Findings

| id | 严重度 | 位置 | 最小 PoC | 影响面 | 备注 |
|---|---|---|---|---|---|
| **G-01** | **High** | `internal.ts:237-239` + `limits.ts:219-221,282` | `POST /internal/quotas {"scope_type":"global","window_type":"day"}`（**不带** `max_*`） | 配额行写入 `max_calls/max_tokens/max_cost = 0`；Lua 侧 `if limit > 0 then` 直接**跳过检查** → 该 scope **无限量**。与 `limits.ts:95`「缺失配额 MUST NOT 视为无限」的注释**完全相反** | 省略字段即触发（`?? 0` 是默认路径）；管理员一次手滑即关掉全站 LLM 预算闸门。语义应改为 `-1=无限 / 0=零` 或拒绝 0 |
| **G-02** | **High** | `providers.ts:127-129`（create 无夹取）vs `:169-178`（update 有夹取） | `POST /internal/providers {"name":"x","base_url":"https://api.x/v1","api_key":"sk-…","cost_per_1k_tokens":-1000}` → 沙箱正常调用 | `estimateCost` 返回负值 → `INCRBY` 负值**回退共享 cost 桶**（user/global/problem）→ cost 配额被"充值"，可超发。update 路径的夹取注释正是为防此攻击，**create 路径漏网** | 极端值 `1e308` → `Infinity` → Lua `tonumber("Infinity")` 报错 → 该 Provider 全线 429/500 |
| **G-03** | **High**（需 admin，拿到 admin 即 Critical） | `providers.ts:117-134,137-206`、`routes/llm.ts:34-39,197-208` | `PUT /api/v1/admin/llm/providers/:id {"base_url":"http://169.254.169.254/latest/meta-data"}`，沙箱随后 `POST /v1/chat/completions`（合法 token） | **gateway 是唯一双网卡服务**（`docker-compose.prod.yml:318-323` 同挂 `noj-net` + `noj-eval-net`）→ 沙箱触发 → gateway 代打内网，响应体经 `llm.ts:341 c.json(upstreamBody)` **原样回给沙箱** → 内网探测/读取（含 `noj-postgres`/`noj-redis`/`noj-core`、云 metadata） | 设计文档承诺的"出网白名单"**从未对 admin 路径生效**：`validateByokBaseUrl`/`isPrivateHostname` 随 BYOK 一起被删，全 src **零命中**。已核实无用户自助写 `base_url` 的路径（BYOK 全路径已删；题目 `llm_config.provider_id` 被忽略） |
| **G-04** | **High** | `routes/llm.ts:128`（入站无体积上限；`content-length\|bodyLimit\|MAX_INPUT` 零命中）+ `:172-195`（**拒绝分支仍落库**）+ `usage.ts:37-38` + `db/schema.ts:42-46`（jsonb 无约束、不自动清理） | 沙箱 `POST /v1/chat/completions`，body = `{"model":"<allowed>","messages":[{"role":"user","content":"<50MB>"}],"max_tokens":0}` | 估算 token ≈ 12.5M > 单提交上限 → 429，**但那一行含 50MB JSON 已进 `llm_usage`**；Lua 在检查失败时于 bump 之前 return → **配额桶零消耗**，只吃 60/min 速率桶 → 单 token ≈ **3GB/min 灌 PG**（jsonb+TOAST+WAL），平台无清理任务 | **沙箱无需任何前置即可打持久化存储**；也可用于把 prompt 内容刷进长期审计表（"选手 prompt 全量留存"本身是隐私面） |
| **G-05** | **High**（可行性中） | `limits.ts:387`（enforce 取 now）vs `:548-551`（settle 重取 now，delta 可负）+ `:674` | UTC 23:59:5x 发起请求使上游响应落在次日 → `settleUsage` 在**次日新桶** `INCRBY` 负 delta | 新一天计数器变负 → `cur + inc > limit` 被负基数放宽 → **跨窗口配额超发/退款**；计数器不再单调 | 净额在同窗口内自洽；漏洞只在窗口翻转时出现。`settle` 应钳制 `delta < 0 → 0` 或用 enforce 时的窗口键 |
| **G-06** | Medium | `routes/llm.ts:102,167,274` + `limits.ts:198-203` | 每请求带 `X-Forwarded-For: 1.2.3.<rand>` | 走 `llm:rate:ip:*` 分支 → IP 60/min 维度失效（只剩 user 桶）；同时污染 `llm:token-ips:*` 多来源 IP 监控 → **"同 token 多 IP"告警可被恒触发/恒规避，并能把任意 IP 栽赃进日志** | gateway **无 `TRUSTED_PROXIES` 概念**（core 有）；F-10 的假设"无 XFF 就用 submission 桶"被调用方自己提供 XFF 绕过一半 |
| **G-07** | Medium | `config.ts:35-45` + `crypto.ts:11-23,81,100` + `auth.ts:7-15` | — | **一个 secret 双用途**：`NOJ_LLM_SERVICE_TOKEN` 既是 eval_token 的 AEAD 主密钥、又是 `/internal/*` 的管理凭据；而 eval_token 会被注入 Evaluator 容器（`noj-judge/src/dual/llm_env.rs:20`）供选手代码驱动。任一侧泄漏 = eval_token 可任意伪造（跨提交/跨用户计费）+ `/internal/providers*`（改 base_url → G-03）+ `/internal/quotas`（零成本关全站预算）全部沦陷；**无多密钥/轮换机制** | 建议密钥分离（token 签名密钥 ≠ 管理 API 密钥）；`auth.ts:11` 用 `!==` 非常量时间比较（Low） |
| **G-08** | Medium | `routes/llm.ts:200-208`（无 `redirect`，与 `providers.ts:241 redirect:"error"` 不一致）+ `:233`（`await text()` 无大小封顶，`MAX_UPSTREAM_BODY_BYTES` 只限制解析） | 控制 Provider 端点（或中间人）返回 302 → 内网；或返回 2GB 响应体 | 跟随重定向 = SSRF 变体（跨源会剥 Authorization，但请求仍打到内网且响应回传沙箱）；超大响应体把 gateway（`mem_limit 512m`）打 OOM，连带该时段全部 LLM 评测 502 | 与 G-03 同源：出站目标控制面缺校验 |
| **G-09** | Medium | `routes/llm.ts:235-242,254,341` | `POST /v1/chat/completions {...,"stream":true}` | 流式响应被 `text()` 读成 SSE → `JSON.parse` 失败 → `upstreamBody=null` → usage 回退**估算**、返回 `c.json(null)` 且 **HTTP 200**、状态记 `"ok"` | 沙箱拿不到内容却被计费，计费口径与响应契约同时失真。要么明确拒绝 `stream:true`（400），要么支持 SSE |
| **G-10** | Medium | `crypto.ts:96-123`（只查 `exp`）+ `jti` 在 src 仅声明**从不使用**；`revoke\|blacklist\|replay` 零命中 | 把 `NOJ_LLM_TOKEN` 交给同伙/其他容器，在 TTL（`max(60, 4×time_limit)`）内无限重放 | 无撤销、无一次性、不绑定来源（IP 仅告警不阻断）→ 提交者的 user 桶供他人消耗（计费与责任错配），评测结束后仍可用探针 | 加 `jti` 一次性/次数上限（Redis）即可收敛 |
| **G-11** | Medium | `providers.ts:112` + `routes/llm.ts:144-146` | 轮换 `NOJ_LLM_STORE_KEY` 后调用 | 解密失败被降级成 `provider_not_found`/400 与 `api_key_masked:"****"` → 真实故障（密钥轮换/损坏）被伪装成"Provider 不存在"，运维与安全响应被误导 | 密文无 `kid`/版本号，无轮换支持 |
| **G-12** | Low | `app.ts:23-59` | `curl http://llm-gateway:8001/metrics` | 沙箱/匿名可读健康与指标（`metrics.ts:22-37` 无业务标签 → 无租户数据泄漏，仅请求量/限流/上游错误量） | 建议网络级限制或内网鉴权 |
| **G-13** | Low | `internal.ts:127-199` | `GET /internal/usage?page=1e30&limit=1000` | **2026-09-21 修复经核实彻底**：page 夹取到 `MAX_SAFE_INTEGER`（offset ≤ 9.007e18 < int8 max，不 500）、LIMIT/OFFSET 全参数化、`$` 前缀回归有 `internal_usage_sql_test.ts:76-130` 守护；残余仅为大 OFFSET 的索引全量游走（admin-only） | **非缺陷**，仅性能残余 |
| **G-14** | Low | `auth.ts:7-15`、`app.ts`（无审计中间件） | 反复 `GET /internal/providers` 带错 token | 401 无日志/无限速 → 探测隐身；`!==` 非常量时间比较 | 16+ 字符随机 token 下暴力不可行，属加固项 |

## 2. 从沙箱（noj-eval-net）出发的可达面（本面核心结论）

沙箱唯一合法入口：`POST http://llm-gateway:8001/v1/chat/completions` + `NOJ_LLM_TOKEN`（`noj-judge/src/dual/llm_env.rs:19-24`）。

**可达 / 可影响**
1. **间接指定出站目标**：转发目标取自 DB `base_url`（admin 写）。一旦被指向内网（G-03），沙箱即获得**内网 HTTP 读写能力**——这是"SSRF 升级为横向移动"的唯一实际链路，且响应体（含状态码）原样回传。
2. **烧平台钱包**：真实 Provider 调用、任意 prompt；单提交 100 calls/50k tokens、user 1000 calls/100k、global 10000 calls/1M（内置默认）。多账号协同可打满 **global/day 桶 → 全站 LLM 题同时 429（关门攻击）**。
3. **污染配额桶**：负 cost（G-02）、`0=无限`（G-01）、跨日负 delta（G-05）三条路径可反向"充值"或静默解除限额。
4. **写持久化存储**：任意大小 `llm_usage` 行（G-04），无上限、无清理。
5. **污染反作弊证据**：伪造 XFF → IP 限流绕过 + "同 token 多来源 IP"告警可任意触发/规避（G-06）。
6. 读 `/metrics`、`/health`、`/health/ready`（未鉴权，低敏）。
7. **拿到长期 bearer 凭据**：eval_token 可重放（G-10），TTL 内可脱离评测上下文使用。

**明确不可达（已核实的边界）**
- `/internal/*` **全部**要求 `NOJ_LLM_SERVICE_TOKEN`（`internal.ts:34` 路径级中间件）；eval_token 与 service token 是不同值、不可互换；AEAD 密文改一字节即解密失败 → 401（fail-closed）。
- **无法跨提交/跨用户**：`submission_id/problem_id/user_id/provider_id/allowed_models/max_*` 全部封在 AES-GCM 密文内，服务端只解不读客户端声明。
- 模型白名单强制（`llm.ts:133`）；**无任何"调用方指定 URL"字段**（全 src URL 来源仅 DB `base_url`）；无 `download`/`webhook`/`proxy`/模型列表拉取端点。
- Provider 明文 key 与**他人**用量/配额不可读（`/internal/*` 一律脱敏；沙箱侧只有自己的 token）。

## 3. 已审且未发现问题的子面（检索词 → 命中）

| 子面 | 检索词 | 结论 |
|---|---|---|
| SQL 注入 / 分页上界 | `db.unsafe`、`$${`、`MAX_SAFE_PAGE`、`OFFSET` | `internal.ts:143-197` 数字参数化 + page 夹取；`internal_usage_sql_test.ts:76-130` 守护。**无注入、无 bigint 溢出** |
| Provider Key 回显 | `encrypted_api_key`、`api_key_masked` | 对外仅 `api_key_masked`。**无回显** |
| 日志脱敏 | `authorization`/`api_key`/`encrypted_api_key`（`logger.ts:143-157`）、`sk-` | 敏感键集合完整 + 递归 + 深度/循环占位符。**未发现明文密钥入日志路径** |
| mass assignment（BYOK 回归） | `sets.push`（`providers.ts:158-187`） | update 走显式白名单 + cost 夹取。**无整包转发**（create 例外 → G-02） |
| 启动配置 fail-closed | `loadConfig`（`config.ts:40-51`） | service token/store key 缺失或 <16 字符即拒启动。**OK** |
| 指标标签 | `metrics.ts:22-37` | 6 个指标全部无业务标签。**无跨租户泄漏** |
| 网络暴露面 | `docker-compose.prod.yml:304-323` | 仅 `expose: 8001`（**未** `ports:` 发布到宿主）；双网卡符合预期 |
| 单提交预算上限 | `llm-limits.ts`（core 侧） | 题目声明值被 `Math.min` 截断到平台默认且写库前断言；**LLM 题作者无法挑选/注入 Provider** |

## 4. 最值得优先修的 3 条

1. **G-01 + G-02：配额闸门可被静默关闭/污染**。`max_* = 0` 在 Lua 里等于"无限"，而写入路径默认值就是 0；create 路径漏掉 cost 夹取（update 有）。→ `-1` 表无限、`0` 表零、显式拒绝歧义值；create/update 共用同一校验函数。
2. **G-04：拒绝路径仍全量落库 + 入站无体积上限**。给 `c.req.json()` 加硬上限（如 256KB，超限 413 且**不落库**）、拒绝路径只记 `prompt_hash`/长度、并为 `llm_usage` 加保留期清理。这是沙箱唯一**无需前置**的持久化 DoS。
3. **G-03：恢复并扩展到 admin 路径的出站校验**。`base_url` 强制 https + 解析后 IP 校验（拒绝 `127/8`、`169.254/16`、`10/8`、`172.16/12`、`192.168/16`、`::1`、`*.internal` 及解析结果落在上述范围者）、`fetch` 统一 `redirect:"error"`、改 `base_url` 时拒绝（需显式"允许内网"开关 + 审计）。**当前这道防线在双网卡拓扑下是零。**

## 5. 本轮处置

**未修任何一条**：G-01/G-02/G-04 修法明确但都改动配额语义或请求契约（需配套测试与 `deno task check`+`test` 全套回归），而收尾时点余量不足以完成"修复 + 回归 + 门禁"；G-03 属"恢复被删安全控制 + 新增出站白名单"，是设计级变更。按 spec §7 全部交 Owner 裁决。
