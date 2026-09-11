# Agent Note: Nitro 代理把上游错误状态码重置为 200

Status: implemented

## Problem

**构建产物（生产与 CI 使用的 `noj-ui/.output/server`）中，所有经 Nitro 代理转发的
上游错误状态码都被重置为 200。** 表现是客户端的错误处理在**生产环境**静默失效：

- 401 不再触发跳转登录页（`useApi` 的 NOJ-210 分支以 `info.status === 401` 判定）；
- 403 / 404 / 429 / 5xx 全部丢失状态，`extractApiError` 拿到 200，
  表单与列表的错误分支、限流提示（`retry-after`）都不再工作；
- 上游的 `content-type` 等响应头一并被丢弃。

实测（同一请求、同一 token）：

| 场景 | 直连 core | dev 代理 `:3000` | 构建产物代理 |
|---|---|---|---|
| 不存在的通知（应 404） | 404 | 404 | **200** |
| 无 token（应 401） | 401 | 401 | **200** |

**根因**在 `noj-ui/server/api/[...slug].ts` 的非 SSE 分支：

```ts
const response = await proxyRequest(event, target);
return withSecurityHeaders(response);   // ← response 不是 Response
```

h3 1.15 的 `sendProxy()` 会把上游的**状态码写进 `event.node.res.statusCode`**、
把响应头写进 Node res、把响应体流式写入 Node res 并 `res.end()`，最后返回
`response._data` —— 而流式路径下 `_data` 为 `undefined`（即**返回值不是 Response**）。
于是 `withSecurityHeaders(undefined)` 构造出
`new Response(undefined, { status: undefined })`：

- `status: undefined` → **默认 200**，覆盖了已写入的真实状态码；
- `new Headers(undefined)` → **响应头清空**，上游 `content-type` 丢失。

`dev` 下之所以看起来正常，是 Node 兼容层保留了已写入的 `statusCode`，
返回的空 Response 未覆盖它；构建产物的 `deno-server` 预设则采用处理器返回值的
状态码。**同一份代码在 dev 与生产语义不同**，这正是该缺陷长期未被发现的原因
——它只在生产/CI 暴露。安全响应头仍存在，因为
`server/middleware/security-headers.ts` 对所有响应统一 `setHeader`，
掩盖了「响应头被清空」这一半症状，让问题更难察觉。

发现路径：新增的通知详情页浏览器 E2E 在 CI 失败——深链打开不存在的通知时页面
一直停在空白（`item` 为 `undefined`，三个状态分支都不命中），因为 404 变成了 200，
`api.get` 不抛错、`res.data` 又是 `undefined`。该用例同时也是本缺陷的回归护栏。

## Decision

**非 SSE 分支不再包装返回值**：`await proxyRequest(event, target)` 后直接 `return`，
让 h3 已写入的状态码与响应头生效。安全响应头由既有中间件统一设置，无需在此重复包装。

```ts
// h3 的 proxyRequest 会把上游响应（含状态码）直接写入 event.node.res 并结束响应，
// 其返回值是 undefined —— 不是 Response。包装它会把状态码重置为 200。
await proxyRequest(event, target);
return;
```

**SSE 分支保持不变**：`proxySseRequest()` 返回的是我们自己构造的真实 `Response`
（`new Response(upstream.body, {...})`），`withSecurityHeaders(response)` 在该路径上是
正确且必要的——返回 Response 会绕开事件上的 header 设置。

**回归护栏**（`noj-tests/e2e/browser/21_notifications.test.ts`）：除断言页面显示
「通知不存在」外，**直接断言该 API 响应的状态码为 404**。只断言文案的话，
本缺陷复发时表现为 20 秒超时（定位成本高）；断言状态码能让失败信息直指根因
（"若为 200，说明 Nitro 代理丢失了上游状态码"）。该用例在 CI 跑的是构建产物，
正是缺陷暴露的环境。

## Alternatives considered

- **改 `withSecurityHeaders` 让它容忍非 Response 入参（如 `response?.status ?? 200`）。**
  按下症状不治根因：状态码仍然取自一个不存在 Response 的值，只会把「静默 200」
  换成「静默沿用」，且掩盖 h3 已自行写响应这一事实。
- **用 `proxyRequest(event, target, { onResponse })` 回调里设置安全头。**
  可行，但安全头已由中间件对所有响应设置，再包一层属于重复；且 `onResponse`
  拿到的 response 与 Node res 状态码的一致性问题仍需额外推理。保持简单：直接不包。
- **在 `withSecurityHeaders` 之外改走 `sendWebResponse` / 手动 `fetch` 透传（像 SSE 分支那样）。**
  能同时拿到正确的状态码与完整响应头，但要自己处理重定向、cookie 拆分、
  hop-by-hop 头、流式转发等 h3 已经处理好的细节，改动面与风险都更大。当前修复是
  最小且语义正确的。
- **只在 E2E 里放宽断言（接受 200）以让 CI 变绿。** 否决：那等于用一个假通过把
  生产环境的错误处理失效盖住——本 PR 的价值恰在于暴露并修复它。
- **把安全响应头的包装从 SSE 分支一并去掉。** 否决：SSE 分支返回真实 Response，
  中间件的 `setHeader` 不保证作用于该 Response，去掉会丢安全头。

## Consequences

- 构建产物中上游状态码正确透传（实测：404→404、401→401、200→200），
  `content-type` 恢复，安全响应头仍在。
- 生产环境的客户端错误处理恢复正常：401 跳转登录、403/404/429/5xx 的错误提示与
  限流 `retry-after` 不再被吞。**这是行为变更**：此前依赖「错误被当作 200」的
  前端路径（若有）会开始走错误分支——这正是应有的语义。
- 通知详情页深链在构建产物上正确显示「通知不存在」（实测 2 秒内渲染，
  修复前为永久空白/超时）。
- `dev` 与构建产物的代理语义重新一致，消除了「本地正常、生产异常」这类最难排查的
  环境分歧。
- 未做 / 已知：
  - 这是**先于本 PR 存在**的缺陷（`[...slug].ts` 不在原改动范围内），
    由本 PR 新增的浏览器 E2E 暴露；
  - `proxyRequest` 的返回契约（写入 Node res 并返回 `_data`）未在代码中以类型层面
    固化，仍靠注释与回归用例约束；若将来 h3 升级改变该契约，需重新核对注释；
  - 本地 dev 环境无法完整运行既有 `19_search_unified` / `ui_flows` 浏览器用例
    （需要 E2E 栈的种子数据与仅在 E2E 环境返回的邮箱验证令牌），
    因此对这些用例的验证以 CI 为准。
