# Agent Note: 超大 page 使 OFFSET 溢出 PostgreSQL bigint（500）

Status: implemented

## Problem

分页的 `page` 参数此前只校验"正整数"，**没有上界**：

- `noj-core/src/shared/http/pagination.ts` 的 `parsePagination`（被 13 个端点复用）；
- `noj-core/src/domains/catalog/routes/problems.ts` 的 `/api/v1/problems`
  与另外 4 个 admin 路由的内联 `parseInt` 解析。

而 `offset = (page - 1) * perPage` 最终进入 PostgreSQL 的 `OFFSET`（bigint，
上限 `2^63-1`）。当 `page` 取到 `~9.9e16` 量级时 offset 越界，postgres.js 把它
序列化为十进制字符串交给 `OFFSET $n`，PG 报
`value "9900000000000000000" is out of range for type bigint`，
被全局 `onError` 映射为 **500 INTERNAL_ERROR**。

触发条件（匿名即可）：

```
GET /api/v1/problems?page=9900000000000000000&limit=100
```

实测（修复前，真实 HTTP 栈）：

```
status = 500
body = {"error":"服务器内部错误","code":"INTERNAL_ERROR","request_id":"16f3..."}
```

对照：`offset` 在 bigint 范围内（如 `page=9.9e16` 且 `perPage=20`）时返回空结果、
不报错——这正是"边界只在特定量级暴露"的典型。`page=0` / `page=abc` 都已被
正确拒绝（ValidationError），遗漏的只是**上界**。

## Decision

引入共享常量并把上界收敛到一处：

- `shared/http/pagination.ts` 定义
  `MAX_SAFE_PAGE = Number.MAX_SAFE_INTEGER`（≈9.007e15，远小于 bigint 上限），
  `parsePagination` 在 `page > MAX_SAFE_PAGE` 时抛 `ValidationError`（400）；
- 导出 `MAX_SAFE_PAGE`，供未走 `parsePagination` 的内联分页路由复用；
- 6 处内联解析（`catalog/routes/problems.ts`、`admin/routes/{system,catalog,submission,identity}.ts`）
  用同一上界：只读端点回退默认页（保持其"非法值回退"的既有风格），
  写操作无关端点抛 `BadRequestError`（与 `page=abc` 的既有处理一致）。

语义：超大 `page` 是**非法输入**（400），而不是"服务器内部错误"（500）。
正常业务永远不会用到这个量级的页码。

回归用例：

- `noj-core/tests/shared/pagination.test.ts`：`parsePagination` 对超大 page
  抛错、合法大 page 的 offset 不越界、`/api/v1/problems` 端到端 400
  （修复前为 500）。

## Alternatives considered

1. **在服务层统一夹取 offset 到 bigint 上限**：拒绝。需要改 13 处 `(page-1)*perPage`
   的调用点，且"巨大 offset 查空表"仍要扫索引，不如在参数层拒绝；
2. **把 `page` 上限设为某个业务值（如 100000）**：拒绝。会改变合法用户可感知的
   契约（深翻页变得不可用），而 `MAX_SAFE_INTEGER` 只是排除"必然溢出"的输入，
   对真实分页零影响；
3. **只修 `parsePagination`，不管内联路由**：拒绝。`/api/v1/problems` 是最常被
   扫描器命中的公开端点，只修一半会留下最易达的触发面。

## Consequences

- `page` 超出 `Number.MAX_SAFE_INTEGER` 从 500 变为 400（公开端点与 admin 端点
  一致）；合法分页行为完全不变。
- `MAX_SAFE_PAGE` 成为 OFFET 上界的单一事实源，新增分页路由应复用它。
- 不改动响应结构或其它参数语义，无需人工裁决。
