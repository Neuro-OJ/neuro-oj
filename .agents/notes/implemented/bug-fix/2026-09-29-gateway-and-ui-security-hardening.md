# Agent Note: LLM 网关防御、单次 Token 原子吊销与前端安全加固

Status: implemented

## Problem

在开赛前安全审计中发现 LLM 网关与前端 UI 存在以下安全风险：
1. **GW-01 / GW-03 (DoS 与内存溢出)**：LLM 网关对请求体与上游大响应缺乏严格字节上限与及时的 Stream 取消，恶意构造或失控的大上游返回可能耗尽 Node/Deno 堆内存；审计日志将整段 50MB 消息体落库导致 PostgreSQL 膨胀。
2. **GW-02 / G-02 (负 Cost 漏洞)**：Provider 成本单价未做非负夹取校验，恶意或误配负数单价可导致扣费变成反向充值。
3. **GW-04 / G-14 (时序攻击)**：内部 API 认证使用弱比较而不是恒定时间比对。
4. **AR-08 / 决策 7 (评测 Token 越权复用)**：评测完成或判题结束后未原子吊销 `eval_token`，可能被参赛者在 10 分钟 TTL 内盗取并在评测机外部刷用。
5. **G-01 / G-05 / G-07 (配额语义与跨日 Delta)**：`limit=0` 未明确表示禁用，跨日负 delta 污染月度配额。
6. **UI-01 / UI-02 / UI-03 (前端 XSS、钓鱼与 CSP 漏洞)**：DOMPurify 未禁用 `style` 属性与标签，允许 CSS 悬浮劫持；MarkdownRenderer 图片过滤正则仅支持双引号且误杀站内相对图片路径；CSP 缺少 Monaco Editor 所需的 `worker-src 'self' blob:` 与 `media-src 'none'`。

## Decision

1. **网关请求与响应双向截断**：
   - 全局挂载 `bodyLimit({ maxSize: 10 * 1024 * 1024 })`（10MB）。
   - 上游响应使用自定义流式累加读取器，超过 10MB 立即 `reader.cancel()` 释放上游连接并抛出 502。
   - 明确拒绝 `stream: true`（400），禁止重定向跟随（`redirect: "error"`）。
   - 审计消息体进入数据库前进行安全截断，单条 message 最大 64KB。
2. **安全比对与数值校验**：
   - 内部 API key 比对改用 `crypto.subtle.timingSafeEqual`。
   - `cost_per_1k_tokens` 强制校验有限数值且大于等于 0。
3. **Token 生命周期原子注销**：
   - 评测结果完成落库时，在 Redis 写入 `llm:token:revoked:${submission_id}`（EX 3600）。
   - 网关每次收到请求先检查该吊销标记，已吊销立即拒绝（401 token_revoked）。
4. **配额逻辑收敛**：
   - 明确 `limit == 0` 为禁用并直接拦截；跨日 delta 为负时重置为 0。
5. **UI 与 CSP 加固**：
   - DOMPurify 增加 `{ FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }`。
   - `secureExternalImages` 扩展正则支持单引号/无引号，放行以 `/` 开头且不以 `//` 开头的站内图片相对路径，保留 `alt` 文本。
   - CSP 头中补齐 `worker-src 'self' blob:; media-src 'none';`，并在 Nginx 与 Nitro 保持一致。

## Alternatives considered

1. **在 noj-core 统一拦截 LLM 流量**：架构违背网关独立解耦原则，增加 core 代理负担与延迟。
2. **在 Redis 中维护所有有效 Token 白名单**：每次 mint 时写白名单，管理开销大；采用黑名单/吊销标记（仅在评测提早结束时写入，自动过期）更加轻量可靠。

## Consequences

- 彻底杜绝 LLM 网关内存耗尽与反向充值漏洞。
- 评测 Token 生命周期与单次评测严格绑定，赛后无法再次调用。
- 前端防范 CSS 钓鱼，站内图片渲染恢复正常，CSP 策略更严谨。
