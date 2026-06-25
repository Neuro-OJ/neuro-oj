## Context

Issue #36 要求实现提交历史页面，目前完成度：

- **后端 API**：`/api/v1/submissions` 和 `/api/v1/admin/submissions` 已完整实现分页、筛选（按题目、语言、状态、日期范围），返回数据包含 `problem.title`、`result.status`、`result.score`
- **详情页**：`pages/submissions/[id].vue` 已完整实现，含轮询、结果状态映射（AC/WA/TLE/MLE/RE）、代码高亮
- **管理后台表格**：`pages/admin/submissions.vue` 存在但缺少得分、耗时、内存列，且只显示提交状态（pending/judging），未展示评测结果状态标签（AC/WA/TLE）
- **用户列表页**：`pages/submissions/index.vue` **不存在**，普通用户无法查看自己的提交历史

## Goals / Non-Goals

**Goals:**
- 创建用户提交历史列表页 `/submissions`，支持分页浏览和筛选
- 改进管理后台提交表格，补充得分、耗时、内存列和评测结果状态标签
- 统一状态标签展示逻辑（管理后台和用户页共享相同的映射）

**Non-Goals:**
- 不修改提交详情页（已完整实现）
- 不涉及评测结果详情展开或图表可视化

## Decisions

### 1. 权限模型：user 级别可访问，API 自动按用户隔离

**选择**：`/submissions` 页面使用 `GET /api/v1/submissions`（用户端 API），路由挂载在 `default` 布局下，不需 `admin` 中间件。默认仅需用户已登录（`authMiddleware` 已在 API 层处理）。

**原因**：
- `GET /api/v1/submissions` 在服务端已强制按 `userId` 筛选，只返回当前认证用户的提交
- 不需要额外的 `user_id` 筛选参数——API 层自动做了隔离
- 管理后台 `/admin/submissions` 使用 `GET /api/v1/admin/submissions`，可查看所有用户，两者职责清晰
- 用户端页面放在 `default` 布局下，和管理后台的 `admin` 布局分离

**效果**：用户访问 `/submissions` → 调用 `/api/v1/submissions` → 自动只看到自己的提交 = "默认只筛选自己的提交"

### 2. 用户列表页提取共享逻辑到 composable

**选择**：将 `SubmissionListItem` 类型定义、`statusLabels`、`statusColors`、评测结果映射等共享逻辑提取为 `composables/use-submissions.ts`

**原因**：管理后台和用户列表页需要重复的类型定义和映射表。详情页已有类似的 `resultDefMap`，但列表页只需要更精简的映射（状态名→标签→颜色）。抽取后可避免维护两份映射。

### 2. 列表状态标签仅显示「最高等级」结果状态

**选择**：列表页每个提交显示一个状态标签，优先展示 `result.status`（如 Accepted、WrongAnswer），回退到提交状态（pending/judging/error）

**原因**：列表的每行空间有限，显示一个代表性标签更清晰。详情页已包含完整的多状态详情。颜色方案：
- Accepted → 绿色 (#10b981)
- WrongAnswer → 红色 (#ef4444)
- TimeLimitExceeded → 橙色 (#f59e0b)
- MemoryLimitExceeded → 橙色 (#f59e0b)
- RuntimeError → 红色 (#ef4444)
- SystemError → 红色 (#ef4444)
- Pending → 灰色 (#9ca3af)
- Judging → 蓝色 (#3b82f6)

### 3. 用户列表页复用现有组件

**选择**：用户列表页不直接使用 `AdminTable`（有管理后台样式依赖），而是用 `PaginationNav` 组件 + 原生 `<table>`，保持与用户端其他页面一致

**原因**：`AdminTable` 的样式（背景、边框、字号）偏管理后台风格，用户端页面需要更轻量的展示。`PaginationNav` 已足够通用可直接复用。

### 4. Problem 列展示题目名称

**选择**：列表中的「题目」列展示 `problem.title`（API 已返回），并链接到题目详情页

**原因**：比显示 `problem_id` 更直观，方便用户快速识别题目。

### 5. 新增模糊搜索参数（题目名/ID、用户名/ID、提交ID）

**选择**：在后端 `listSubmissions` 中新增三个查询参数：

| 参数 | 后端匹配逻辑 | 前端输入框 |
|------|-------------|-----------|
| `problem_search` | `submissions.problem_id` 精确匹配 OR `problems.title` ILIKE 模糊搜索 | 一个输入框：搜索题目名或输入题目 ID |
| `user_search` | `users.username` ILIKE 模糊搜索 OR `submissions.user_id` 前缀匹配 | 一个输入框：搜索用户名或输入用户 ID（仅 admin 端） |
| `submission_id` | `submissions.id` ILIKE 前缀匹配（输入前几位） | 一个输入框：提交 ID |

**原因**：
- 用户期望在搜索框中直接输入"1001"即可匹配题目 ID，或输入"T0-LMCC"匹配题目名称
- 管理后台的"用户"筛选用一个框处理用户名和用户 ID 两种输入，避免两个输入框
- 提交 ID 支持前缀匹配方便复制粘贴前几位即可定位
- 所有搜索参数在路由层解析，传到 `listSubmissions` 函数后在 `WHERE` 子句中组合

## Risks / Trade-offs

- **[数据延迟]** 刚提交的评测可能 `result` 为 `null`（尚未返回结果）→ 列表显示提交状态 `pending`/`judging` 而非评测结果，等待自动轮询跳转
- **[状态标签宽度]** 评测结果状态名较长（`TimeLimitExceeded`）在窄屏可能换行 → 列表字号用 12px，和详情页状态标签保持一致
