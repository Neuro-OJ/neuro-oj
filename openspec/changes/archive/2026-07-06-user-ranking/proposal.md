## Why

当前所有"通过数 / 通过率 / 解题数"统计只在单用户级别（`GET /api/v1/users/:id/profile`）可见，用户无法跨用户对比。ROADMAP Phase 1 交付标准明文要求"榜单可查"——任何访问者应能看到全站用户按解题数排序的排行榜，并让登录用户看到自己在榜上的位置。本变更落地 Phase 1 的最后一块。

## What Changes

- **新增**：`GET /api/v1/rankings` 公开接口，按解题数 / 通过率 / 提交数三维度排序返回全站用户榜单，分页支持
- **新增**：`GET /api/v1/rankings/me` 已登录接口，返回当前用户在榜上的排名行
- **新增**：前端 `/ranking` 页面（公开），表格 + 分页，当前登录用户行高亮
- **新增**：前端 `composables/useRankings.ts`，封装数据类型与 `$fetch` 调用
- **修改**：`GET /api/v1/users/:id/profile` 响应追加 `rank` 字段（已有通过记录时为排名数值，否则 `null`）
- **修改**：前端 Navbar 菜单新增"榜单"入口（在"提交记录"与"队列"之间）
- **修改**：前端用户主页追加"排名"统计卡（仅当 `rank !== null` 时显示）

## Capabilities

### New Capabilities

- `ranking`: 全站用户榜单查询——公开访问、按解题数降序排序、分页、当前用户排名查询；用户主页响应追加 `rank` 字段

### Modified Capabilities

- `user-profile`: `GET /api/v1/users/:id/profile` 响应对象追加 `rank` 字段（number | null），表示该用户在全站榜单的排名

## Impact

- **数据库**：无 schema 变更，无迁移
- **noj-core**：新增 `src/services/rankings.ts`、`src/routes/rankings.ts`；修改 `src/routes/users.ts`（profile 响应追加 rank 字段）、`src/app.ts`（挂载新路由）
- **noj-ui**：新增 `pages/ranking.vue`、`composables/useRankings.ts`；修改 `components/Navbar.vue`（菜单）、`pages/users/[id].vue`（排名卡）
- **性能**：榜单聚合为单 SQL `GROUP BY user_id`（与 `users.ts:getUserProfile` L84-99 写法一致）；用户量 < 1K 时实时聚合足够，无需缓存
- **安全**：root 系统用户（id='0'）不计入榜单；榜单为只读公开数据，无需鉴权