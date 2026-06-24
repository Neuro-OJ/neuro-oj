## Context

现有的 `pages/problems.vue` 是一个 161 行的单文件组件，已实现基础功能：
- 题目表格（题号、标题、难度、分类、时间限制、内存限制）
- 简单的上一页/下一页分页
- 加载中、空数据、错误状态

缺少功能：
- 搜索框（按标题/题号搜索）
- 按难度筛选
- 按分类筛选（需要加载分类树）
- 通过率展示
- 用户的通过状态（已解决/尝试过/未开始）
- 响应式优化

后端 API 支持（由 noj-core 提供）：
- `GET /api/v1/problems?keyword=&difficulty=&page=&limit=` — 多维度筛选与分页
- `GET /api/v1/categories` — 分类树
- `GET /api/v1/submissions?problem_id=&user_id=` — 查询提交记录（用于判定通过状态）

## Goals / Non-Goals

**Goals:**
- 将 `pages/problems.vue` 重构升级为完整的题目列表页
- 实现搜索框、难度筛选、分类筛选
- 实现完整分页组件（页码导航）
- 显示每道题的通过率
- 显示用户对每道题的通过状态（已解决/尝试过/未开始）
- 响应式布局适配移动端

**Non-Goals:**
- 不涉及题目详情页（`problems/[id].vue` 已有独立实现）
- 不涉及后端 API 修改（API 已满足需求）
- 不涉及通过率统计的后端实现（API 已提供 `acceptance_rate` 等字段）
- 不涉及服务端渲染优化（Nuxt SSR 由现有架构处理）

## Decisions

### Decision 1: URL 查询参数作为筛选状态源

当前使用内联的 `page` ref 管理分页状态。重构后改用 URL 查询参数（`?keyword=&difficulty=&category_id=&page=`）作为状态的单一来源（SSOT）。

- **理由**：
  - URL 可分享：用户可复制 URL 分享给他人，保持相同的筛选条件
  - 浏览器前进/后退按钮自然支持
  - 页面刷新后状态不丢失
- **实现**：使用 `useRoute().query` 读取，`router.push({ query })` 更新
- **替代方案**：`useState` + `watch` 双向同步 → 一致性难以保证，放弃

### Decision 2: 分类筛选使用客户端缓存

分类树数据（`GET /api/v1/categories`）是低频变更数据，可在页面加载时一次性获取并缓存。

- **理由**：
  - 减少 API 请求次数
  - 分类筛选变化频繁（用户切换不同分类查看），无需重复请求分类树
- **实现**：使用 `useAsyncData` + `getCachedKey`，或在 composable 中做手动缓存
- **替代方案**：每次请求都带分类数据 → 增加请求开销，放弃

### Decision 3: 通过状态通过独立 API 获取

用户的通过状态（已解决/尝试过/未开始）需要获取用户对每个题目的提交记录。

- **方案**：页面加载后，对有提交记录的用户，异步查询已通过的题目 ID 列表
- **实现**：使用 `GET /api/v1/submissions?status=finished` 或专门的「已解决题目」端点（如果 API 支持）；在没有专用端点时，遍历 problem IDs 查提交状态
- **注意**：用户未登录时，不显示通过状态（全部显示"未开始"）

### Decision 4: 组件拆解

当前是单文件组件，重构后拆分为以下组件：

| 组件 | 职责 |
|------|------|
| `problems.vue` | 页面容器，组合子组件，管理状态 |
| `ProblemFilterBar.vue` | 搜索框 + 难度/分类筛选控件 |
| `ProblemTable.vue` | 题目表格展示 |
| `PaginationNav.vue` | 分页导航组件（可复用） |
| `StatusBadge.vue` | 通过状态徽标（已解决/尝试过/未开始） |

## Risks / Trade-offs

- **通过状态 API 性能风险**：如果 `GET /api/v1/submissions` 不支持批量查询已解决题目，可能需要 N+1 查询 → **缓解**：统一在项目初期确认后端支持 `GET /api/v1/submissions?status=finished&limit=9999` 获取用户全部已解决题目 ID 列表，前端做 Set 匹配
- **URL 查询参数字段名一致性**：需要与后端 API 参数名对齐（`keyword`、`difficulty`、`category_id`、`page`、`limit`）→ **缓解**：在 composable 中统一管理参数映射
- **与现有简单 pagination 的兼容**：当前调用 `nextPage`/`prevPage` 函数直接修改 `page.value` → 重构为 URL 驱动后需要移除
