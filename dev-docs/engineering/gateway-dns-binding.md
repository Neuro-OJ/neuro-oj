# 网关出站 DNS 校验与连接绑定（R1）

> 适用模块：`noj-llm-gateway`。审计来源：2026-11-02 rc/v0.11 审计 R1
> （“校验对象与连接对象不是同一批地址”）。本文记录 spike
> 结论、实现选择、残余风险 与回滚点，对应 Agent Note
> [rc/v0.11 审计阻断项修复](../../.agents/notes/implemented/bug-fix/2026-11-02-rc-v011-audit-blockers.md)。

## 1. 问题

G-03 控制分两道：登记时 `assertSafeBaseUrl`（协议/凭据/内网字面量），调用时
`assertResolvesPublic`（解析
A/AAAA，任一落内网即拒绝）。两道都只**看**解析结果， 真正发请求的是
`fetch(upstreamUrl, ...)`，由运行时**重新解析** hostname 并选择地址。 于是存在
TOCTOU／DNS rebinding 窗口：

```text
t0  校验：api.evil.example → 93.184.216.34（公网，通过）
t1  连接：api.evil.example → 10.0.0.12（攻击者切换解析，连到内网）
```

窗口内请求仍带上 Host 头与原 URL 路径，响应体还会原样回传给调用方 —— 与 G-03
要防的 SSRF 完全等价，只是需要攻击者控制 DNS 记录。

## 2. Spike 结论（本机实测，Deno 2.x + node:https）

目标：确认 Deno 下能否“以已校验 IP 建连，同时保留真实主机名的 TLS 校验”。

| 尝试 | 做法                                                                                            | 结果                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| S1   | `https.request({ host, servername: host, lookup: (_h,_o,cb)=>cb(null, ip, 4) })`                | ❌ `Invalid IP address: undefined`：node 的 `lookup` 约定要求按 `options.all` 分两种回调形状，直接忽略 option 形状会失败 |
| S2   | 同上，但按 `options.all` 分支回调 `cb(null, [{address, family}])` / `cb(null, address, family)` | ✅ 真实 IP → `200`；注入 `127.0.0.1` → `ECONNREFUSED 127.0.0.1:443`                                                      |

S2 的第二行是关键证据：连接**确实**走到了注入的地址（否则不会出现
`ECONNREFUSED 127.0.0.1:443`），说明 `lookup` 覆盖生效、连接阶段没有重新解析。
同时 `servername` 保持真实主机名，证书仍按主机名校验（spike 对真实主机返回 200，
说明 SNI/证书链未被 IP 化破坏）。

结论：**方案 A（连接层注入 lookup，钉住已校验地址）在 Deno 下可行，无需退路方案
B （受控出口代理）**。

## 3. 实现

`noj-llm-gateway/src/upstream-guard.ts`：

1. `resolvePublicUpstream(baseUrl, allowedHosts, resolve)` → `PublicResolution`
   （`{ host, addresses }`）。与原 `assertResolvesPublic` 同规则，另加两点：
   - A/AAAA
     结果**去重**（双栈主机常见重叠；地址集合语义是“可连接的已验证地址”）；
   - 白名单主机与 IP 字面量返回**空地址集合**，表示“无需固定，按原样连接”
     （登记时已校验，与旧行为一致）。
2. `fetchPinned(url, init, resolution)` → 默认实现 `nodePinnedTransport`：
   - 自定义 `lookup` 只回调 `resolution.addresses[0]`，连接阶段不再解析 DNS；
   - `servername` = 真实主机名（TLS 校验不被 IP 化破坏），`Host`
     头沿用真实主机名；
   - 3xx 一律拒绝（等价原
     `fetch(..., { redirect: "error" })`，不把跳转目标当上游）；
   - 写请求按 body 计算 `Content-Length`（node 默认 chunked，部分 Provider
     不接受）；
   - 响应体经 `Readable.toWeb` 透传，SSE 增量输出不变。
3. `setPinnedTransport()` / `setRequestImplementations()` 是**测试接缝**：
   路由用例（`tests/helpers.ts::stubFetch`）把传输层指向 fetch
   替身，生产路径始终是 默认实现；`upstream_guard_test.ts` 用注入的 request
   实现验证 lookup 真的被固定。

`noj-llm-gateway/src/routes/llm.ts`：调用前
`resolvePublicUpstream(...)`（仍在额度 扣减之前），上游请求改
`fetchPinned(upstreamUrl, init, resolution)`。

## 4. 残余风险与已知限制

- **只连验证集合里的第一个地址**：不做多地址重试（重试等于扩大目标集合、削弱“钉住”
  语义）。首个地址不可达时表现为上游错误，由 Provider 侧健康检查处理。
- **不支持上游 HTTP 代理**：`node:https` 不读 `HTTPS_PROXY`，与改造前 `fetch` 在
  Deno 下的行为一致；若将来需要出口代理，应显式实现并在此登记。
- **白名单主机不做钉住**：`NOJ_LLM_UPSTREAM_ALLOWED_HOSTS` 的语义就是“允许内网/
  自建模型”，钉住无意义。
- **重定向一律拒绝**：与旧语义一致，若某 Provider 依赖 302
  取流需先改这条并补授权 决策（跳转目标必须重新走 `resolvePublicUpstream`）。
- **连接失败不回退**：见第一条，这是刻意的 fail-closed 取舍。

## 5. 验证

```bash
cd noj-llm-gateway
deno task test:logic        # 含 upstream_guard_test.ts 全部用例
deno task check             # fmt --check + lint + check src/mod.ts
```

固定证据（`tests/upstream_guard_test.ts`）：

| 用例                                                  | 断言                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| `resolvePublicUpstream: 返回已验证地址，供连接层固定` | 返回 host + 地址集合                           |
| `resolvePublicUpstream: 私网地址直接拒绝`             | 私网地址抛 `UPSTREAM_BLOCKED`                  |
| `resolvePublicUpstream: A/AAAA 重叠地址去重`          | 双栈两条都保留；重复项被去掉                   |
| `fetchPinned: 连接使用 lookup 固定的已校验地址`       | 注入 request 实现后，`lookup` 只吐出已验证地址 |
| `fetchPinned: 传输层可注入，且调用方拿到已验证地址`   | 路由接线契约：地址集合真的被传进传输层         |

路由级用例（`tests/routes_llm_test.ts` 等 6 个文件）经 `stubFetch`
继续拦截上游， 证明改造后限流/额度/流式/审计语义未变。

## 6. 回滚点

单模块、两处改动：`src/upstream-guard.ts`（新增部分）与 `src/routes/llm.ts`
的两行 调用。回滚到 `assertResolvesPublic(...)` + `fetch(...)`
即可恢复旧行为（同时恢复 TOCTOU 风险，必须同步在发布说明登记为已知限制）。
