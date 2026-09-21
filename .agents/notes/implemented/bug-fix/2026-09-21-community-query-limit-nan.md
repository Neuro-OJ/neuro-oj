# Agent Note: 社区列表端点非法 limit 使夹取失效并静默返回空列表

Status: implemented

## Problem

社区 5 个列表端点直接把查询串交给 `Number()` 再传入服务层：

- `noj-core/src/domains/community/routes/community.ts`：`/posts`、`/bookmarks`、
  `/feed`、`/notifications` 的 `limit: Number(c.req.query("limit") ?? 20)`
- `noj-core/src/domains/admin/routes/community.ts`：`/comments/pending` 的
  `Number(c.req.query("limit") ?? 50)`

服务层的夹取写作 `Math.min(Math.max(options.limit ?? 20, 1), 100)`。
`Number("abc")` 为 `NaN`，而 `Math.max(NaN, 1)` / `Math.min(NaN, 100)` 均为
`NaN` —— 夹取**整体失效**。

触发条件：

```
GET /api/v1/community/posts?type=discussion&limit=abc
```

实际行为（实测，PGlite 路径）：

- `listPosts` 内 `collected.length <= limit` 因 `NaN` 判定为 `false`，
  普通帖补齐分支被跳过；
- 置顶段 SQL 的 `.limit(NaN)` 被 Drizzle **静默省略**（`toSQL()` 无 LIMIT 子句），
  无数据时返回空集；
- 最终响应为 `200 {"data":[],"next_cursor":null}`。

即：非法（但极易由爬虫、手工拼 URL 或前端截断产生）的 `limit` 会让
**整个列表静默变空**——正文"看起来不存在"，而非报错或被夹取到合法上限，
用户与排障者都无法从响应判断原因。`feed` / `bookmarks` / `notifications`
的 `Math.min(Math.max(nan,1),100)` 同样整体变 `NaN`。

对照：同仓库 `shared/http/pagination.ts` 的 `parsePagination` 对非法
`per_page` 用 `Number.isInteger` 显式拒绝，说明此处是遗漏而非既定设计。

## Decision

新增纯函数 `parseQueryLimit(raw, { default, min, max })`
（`noj-core/src/domains/community/services/community/query-limit.ts`），
把「解析 → 夹取 → 非有限值回退」收敛到一处：

- `undefined` / 空白 → 默认值；
- `NaN` / `±Infinity` / 非整数（如 `2.5`）→ 默认值；
- 越界 → 夹取到 `[min, max]`（默认 `[1, 100]`）。

5 个调用点全部改用该函数。语义故意保持"宽松回退"而非报 400：与
`parsePagination` 对缺省/非法值的既有宽容口径一致，且不改变任何合法请求行为。

回归覆盖：

- 路由级用例（`community/tests/routes/community.test.ts`）：先造 25 条讨论帖，
  断言 `limit=abc` 返回默认 20 条（修复前为 0 条），并覆盖另三个端点；
- 纯函数单测（`community/tests/services/query-limit.test.ts`）：NaN、Infinity、
  小数、越界、默认值越界等 6 组。

## Alternatives considered

1. **路由层对非法 limit 返回 400**：拒绝。会改变合法用户可感知的契约
   （缺省/非法从"能用"变成"报错"），且与 `parsePagination` 对 `per_page`
   之外的宽松口径不一致。
2. **只在服务层把 `options.limit` 做 `Number.isFinite` 防御**：拒绝。根因在
   路由层把原始字符串直接 `Number()`；只改服务层会留下 5 处重复防御，
   且其它域仍可能重蹈覆辙。
3. **改用 `parsePagination` 统一处理 limit**：拒绝。社区列表用的是
   `cursor` 键集分页（不是 page/per_page），语义不同，强行套用会改变响应结构。

## Consequences

- `limit=abc`（及 `Infinity`、小数、越界）从"静默返回空列表"变为"回退/夹取到
  合法区间"，是**纯修复**，对合法 `limit` 行为无变化。
- 新增 `query-limit.ts` 已从社区域门面 `community.ts` 再导出，admin 路由可直接
  复用，避免同类缺陷在管理端点复现。
- 未改动产品行为（不改状态码、不改响应结构），无需人工裁决。
