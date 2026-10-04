# Agent Note: 网关 Provider 上游地址出站校验（防 SSRF）

Status: implemented

## Problem

2026-09-28 审计 G-03（High）：Provider 的 `base_url` 无任何校验，可指向
`169.254.169.254`、`noj-postgres`、`noj-core` 等内网地址。llm-gateway 是唯一同时接入评测网络与
内网的服务，沙箱触发 LLM 调用即可让网关代为访问内网 HTTP 服务且响应体原样回传；后台"连通性测试"
的状态码差异还可作为内网端口探测预言机。BYOK 时期的外网白名单函数已随 BYOK 一并删除。

## Decision

- 新增 `src/upstream-guard.ts`，两道校验：
  - **登记时** `assertSafeBaseUrl`（`/internal/providers` 新建与更新）：仅允许 https；禁止 URL 内嵌凭据；
    禁止 `localhost`、单段主机名（Docker 服务名）、`*.internal/.local/.lan/.localhost` 与私网 / 回环 /
    链路本地 / CGNAT / 组播 / IPv6 ULA / IPv4 映射等 IP 字面量；
  - **调用时** `assertResolvesPublic`（chat/completions 与连通性测试访问上游前）：解析 A/AAAA，任一记录
    落在内网即拒绝，两类记录都解析失败时失败关闭；先于额度扣减执行，被拦截调用不消耗配额；
- 新增 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS` 显式白名单，白名单主机允许 http 与内网地址（内网自建模型、
  E2E mock）；`docker-compose.e2e.yml` 放行 `noj-e2e-llm-mock`；
- core `mapLlmError` 将 `provider_base_url_blocked` 映射为可操作的中文提示。

## Alternatives considered

- 只做登记时校验：无法防御"公网域名解析到内网 IP"（含 DNS rebinding），存量 Provider 也不受约束；
- 在 Docker 网络层禁止网关访问内网：网关必须访问 postgres / redis，网络层无法区分；
- 固定解析结果后按 IP 直连（彻底消除 DNS rebinding 的 TOCTOU）：Deno `fetch` 不支持指定解析结果，
  需自建 HTTP 客户端，超出发布前范围。残余窗口为"校验与连接之间 DNS 结果改变"，需要攻击者控制
  权威 DNS 且拥有管理员权限登记该域名。

## Consequences

- 已登记的 http 或内网 Provider 在升级后会被拦截，需加入白名单或改为 https 公网地址；
- 每次上游调用增加一次 DNS 解析；
- `198.18.0.0/15`（透明代理 fake-IP 段）不视为内网，避免代理部署环境下所有上游被误拦。
