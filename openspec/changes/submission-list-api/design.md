## Context

当前 noj-core 已实现提交的创建 (`POST /`) 和详情查询 (`GET /:id`)，但缺少列表查询能力。数据库 `submissions` 表已有针对 user_id、problem_id、status、created_at 的单列索引，可支持基础的筛选查询。现有路由使用 Hono 框架，认证通过 `authMiddleware` 注入 `userId` 和 `userRole`。

需要新增列表端点的同时，避免在列表场景下产生 N+1 查询（前端需逐条请求题目信息），同时确保管理员可跨用户查询。

## Goals / Non-Goals

**Goals:**
- 提供 `GET /api/v1/submissions` 端点，返回当前用户的提交列表（分页 + 筛选）
- 提供 `GET /api/v1/admin/submissions` 端点，管理员可查看所有用户提交
- 列表响应中包含题目基本信息（id、title）和评测结果摘要（status、score），避免 N+1
- 支持按 problem_id、language、status、日期范围筛选
- 使用 offset-based 分页，与主流前端分页组件兼容

**Non-Goals:**
- 不实现 cursor-based 分页（本次采用 offset-based，更简单直观）
- 不在列表响应中返回完整源代码（`code` 字段仅详情接口返回）
- 不实现排序切换（固定按 created_at DESC）
- 不对正式题目数据做额外权限控制（题目信息对所有登录用户可见）

## Decisions

### 1. 分页方式：Offset-based

选择 `page` + `per_page` 而非 cursor-based。

**理由：**
- 前端分页组件（如 Element Plus、Vuetify）原生支持 offset-based 分页
- 提交数据量在 OJ 场景下增长可控，offset 深分页性能问题不突出
- 实现简单，`COUNT` + `OFFSET/LIMIT` 即可

**考虑过的替代方案：**
- Cursor-based：对实时数据流更高效，但前端适配成本高，OJ 场景不需要实时性

### 2. 列表响应字段取舍

列表接口不返回 `code` 字段（源代码），仅在详情接口 (`GET /:id`) 返回。

**理由：**
- 源代码体积大，列表场景不需要，返回会导致响应膨胀
- 保持与主流 OJ（如 AtCoder、Codeforces、Luogu）的列表 API 一致

### 3. 查询策略：单次 JOIN 查询

使用单条 SQL JOIN 查询同时获取提交、题目和评测结果，而非多次查询后在应用层组装。

**理由：**
- 避免 N+1 问题
- 数据库层面完成关联，网络往返次数 O(1)
- Drizzle ORM 支持 LEFT JOIN，利用现有索引

### 4. 管理端点路由

管理员端点使用独立路由 `GET /api/v1/admin/submissions`，而非在 `/api/v1/submissions` 上通过查询参数切换。

**理由：**
- 符合现有架构惯例（`/api/v1/admin/` 前缀统一管理端点）
- 语义清晰：`adminMiddleware` 与路由绑定，非通过参数动态切换
- 与 `admin-authorization` spec 中 `PATCH /api/v1/admin/users/:id/role` 风格一致

**考虑过的替代方案：**
- 共用 `/api/v1/submissions`，通过 `?all=true` 或 `?user_id=` 查询参数 + adminMiddleware 控制：权限逻辑嵌入业务路由，职责混杂，不符合现有分层约定

### 5. 默认排序与分页参数

- 默认排序：`created_at DESC`（最新提交在前）
- 默认 `per_page=20`，最大 `per_page=100`
- 当 `page` 超出范围时返回空列表（而非 404）

### 6. 评测结果联查方式

使用 `LEFT JOIN evaluation_results`，无结果时返回 `null`。

**理由：**
- pending/judging 状态的提交还没有评测结果，LEFT JOIN 确保这些提交仍出现在列表中
- 返回 `{ status, score }` 摘要，与详情接口的完整 `result` 对象有所区分

## Risks / Trade-offs

- **[Risk] 深分页性能**：offset-based 分页在大页码时 `OFFSET` 效率下降 → **Mitigation**：限制 `per_page` 最大值 100，后续可按需引入 cursor-based 分页
- **[Risk] 筛选条件组合导致全表扫描**：多个可选的 WHERE 条件可能使查询计划选择不佳 → **Mitigation**：利用已有的单列索引，初次实现保持查询简单，监控慢查询后按需添加复合索引
- **[Trade-off] 列表不返回 code 字段**：前端需额外请求详情接口获取代码 → 减少列表响应体积，符合常见实践
