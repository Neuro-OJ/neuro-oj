## Context

NOJ 当前所有"通过数 / 通过率 / 解题数"统计都在 `users.ts:getUserProfile` 单用户级别实时聚合（`count(*) filter (where evaluation_results.status = 'Accepted')` + `count(distinct problem_id)`），没有跨用户排序视图。ROADMAP Phase 1 列出"排行榜：通过数 / 通过率"作为 noj-core 待办，但当前未实现。

### 现有约束

- `submissions` 表已有 `idx_submissions_user_id` 索引，`evaluation_results` 表有 `(submission_id)` UNIQUE 索引
- 没有 `user_stats` / `leaderboard` 物化视图，所有聚合均为运行时 SQL
- `dashboard.ts` L78-99 已有跨用户聚合模板（`count(*) filter (where ... = 'Accepted')`）
- `getUserProfile` 排除 root 系统用户（`id != '0'`）
- Nitro 代理已通配 `/api/v1/*`，前端无需新增代理路由
- 分页响应包络统一为 `{ data: [...], pagination: { page, per_page, total, total_pages } }`
- OpenSpec 绿地：全仓 `ranking|leaderboard|scoreboard` 零匹配

### 调研结论

- **零数据库迁移**：现有 schema 完全够用
- **零向后兼容负担**：绿地实现
- **样板可直接复用**：`users.ts:getUserProfile` 的聚合写法 + `dashboard.ts` 跨用户聚合 + `submission-list-api` 分页响应包络

## Goals / Non-Goals

**Goals:**
- 全站用户榜单查询，按解题数（主）/通过率（次）/提交数（tiebreaker）排序
- 当前登录用户排名查询
- 用户主页追加 `rank` 字段
- 前端 `/ranking` 公开页面，表格 + 分页 + 当前用户高亮
- 排除 root 系统用户（id='0'）
- MVP 只展示有通过记录的用户（`accepted > 0`）

**Non-Goals:**
- ❌ 比赛榜（Phase 2 实时榜单再用基础）
- ❌ 时间范围筛选 `?range=7d/30d/all`（数据量小不需要）
- ❌ 难度/分类分组榜单（基础版先全站）
- ❌ Redis 缓存（用户量 < 1K 实时聚合足够）
- ❌ 物化视图 / `user_stats` 表（同上理由）
- ❌ SSE 实时推送榜单变化（榜单变动慢，刷页面即可）
- ❌ 导出 CSV
- ❌ 国家/地区/学校维度（无数据模型）
- ❌ 多语言（C++/Java）：按用户要求不做

## Decisions

### 1. 聚合查询策略

**选择：实时 SQL 聚合（无缓存、无物化）。**

**理由：**
- 用户量 < 1K（Phase 1 MVP 用户基数），单次聚合 < 50ms 可接受
- 与现有 `getUserProfile` / `dashboard` 保持一致
- 无缓存失效复杂性（写路径无需变更）
- 数据量增长后再考虑物化视图或 Redis 缓存

**SQL 核心**：
```sql
SELECT
  u.id, u.username,
  count(*) FILTER (WHERE er.status = 'Accepted') AS accepted,
  count(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted') AS solved_count,
  count(*) AS total_submissions,
  CASE WHEN count(*) = 0 THEN 0
       ELSE count(*) FILTER (WHERE er.status = 'Accepted')::float / count(*)
  END AS acceptance_rate
FROM users u
JOIN submissions s ON s.user_id = u.id
LEFT JOIN evaluation_results er ON er.submission_id = s.id
WHERE u.id != '0'  -- 排除 root 系统用户
  AND s.status = 'finished'  -- 只统计已完成的提交
GROUP BY u.id, u.username
HAVING count(*) FILTER (WHERE er.status = 'Accepted') > 0
ORDER BY solved_count DESC, acceptance_rate DESC, total_submissions ASC, u.created_at ASC
LIMIT $1 OFFSET $2
```

### 2. 排序键设计

**选择：四级排序键确保稳定性。**

```
solved_count DESC,           -- 主要：解题数
acceptance_rate DESC,        -- 次要：通过率（solved 相同时更高效者靠前）
total_submissions ASC,       -- tiebreaker：提交数少者靠前（更精炼）
u.created_at ASC             -- 最终 tiebreaker：老用户优先
```

**理由**：仅按 `solved_count` 排序在相同题数时会不稳定；`acceptance_rate` 是相对指标，避免"刷提交"行为排名靠前。

### 3. 排除无通过记录的用户

**选择：`HAVING count(*) FILTER (WHERE er.status = 'Accepted') > 0`。**

**理由：**
- 榜单对"通过 0 题"的用户无意义（`acceptance_rate = 0`，`solved_count = 0`）
- 避免空行噪声
- "我的排名"接口对未上榜用户返回 `null`

### 4. API 端点设计

**`GET /api/v1/rankings`（公开）：**
- Query: `page` (默认 1), `limit` (默认 50, 上限 100)
- Response: `{ data: RankingRow[], pagination: {...} }`

**`GET /api/v1/rankings/me`（需登录）：**
- 从 JWT 取 `userId`，内部调用聚合查询 LIMIT 1 OFFSET 0 WHERE user_id=?
- 若用户已通过 ≥1 题：返回 `{ rank, user_id, username, solved_count, total_submissions, acceptance_rate }`
- 若用户未上榜：返回 `null`

**复用 JWT 中间件**：`middleware/auth.ts` 已在 `app.ts` 全局挂载，子路由直接调用 `c.get("user")` 或 `c.get("jwtPayload")` 即可。

### 5. 用户主页 rank 字段

**选择：在 `getUserProfile` 响应中追加 `rank: number | null`。**

**实现**：在 `routes/users.ts` 的 GET `/:id/profile` 处理函数内，调用 `getMyRanking(userId)`，取 `rank` 字段后合并到响应对象。

**理由**：
- 零 schema 变更，纯计算字段
- 与现有 `solved_count`、`acceptance_rate` 等字段并列，用户无需额外请求
- 后续 Phase 2 比赛榜可复用此模式扩展

### 6. 前端页面设计

**路径**：`pages/ranking.vue`（公开，无需 `middleware: "auth"`）。

**布局**：
- 顶部：标题 + 简短说明
- 主体：表格（排名 / 用户名 / 解题数 / 通过率 / 提交数）
- 当前登录用户行：`bg-primary/5` 高亮
- 底部：分页组件
- 三态容器：复用 `components/ui/AsyncContent.vue`

**空状态文案**："还没有用户通过任何题目，做第一个吧 👉 /problems"

**借鉴样板**：`pages/users/[id].vue` 的统计卡 + `pages/problems.vue` 的列表 + 分页组合模式。

### 7. 命名约定

- API: `/api/v1/rankings`（与 `users`、`problems`、`submissions` 同款复数）
- 前端页面: `/ranking`（单数路径，与 `/problems` `/users/:id` 一致）
- composable: `useRankings`（camelCase，新代码遵循主流）
- 文件名: `rankings.ts`（后端 service/route）、`ranking.vue`（前端页面）

## Risks / Trade-offs

- **[风险] 大量提交数据时聚合慢** → 缓解：用户量 < 1K 暂不优化；后续可加 `(user_id, evaluation_results.status='Accepted')` 复合索引
- **[取舍] 实时聚合无缓存** → 有意识选择。简化实现，避免写路径失效复杂度
- **[风险] 榜单分页下"我的排名"不在当前页** → 缓解：单独 `/rankings/me` 接口，返回当前用户完整行，前端可据此在榜单页底部追加"我的排名"提示卡
- **[取舍] root 用户绝对排除** → 一致性考虑：与 `dashboard.ts` L62 模式保持一致，root 系统用户永远不出现在任何用户列表
- **[风险] acceptance_rate 小数精度** → 缓解：返回 0–1 浮点数，前端用 `toFixed(2)` 百分比展示；DB 端通过 `::float` 强转避免整数除法