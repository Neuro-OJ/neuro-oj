# Training / 题单功能设计

> 日期：2026-08-17
> 关联 Issue：#224 feat: 支持训练计划/题单（training）
> 状态：已与需求方确认，待评审

## 1. 背景与目标

当前 NOJ 只有 admin 管控的分类树，用户无法自主组织题目、形成系统刷题路径。本设计对标 HydroOJ `training` / 洛谷题单的**基础形态**，为 NOJ 增加用户可创建的“题单”。

第一版范围明确为**扁平题单**：

- `trainings` 主表 + `trainingProblems` 关联表
- 题目在题单内按 `position` 排序
- 不引入章节、前置依赖等 DAG 能力（后续可扩展）

## 2. 范围决策（已确认）

| 决策点 | 结论 |
| --- | --- |
| 结构复杂度 | 扁平题单，不引入 DAG/章节/前置依赖 |
| 创建权限 | 所有登录用户可创建题单 |
| 可见性模型 | 三态：`private` / `unlisted` / `public` |
| 公开审核流 | 第一版不做申请审核流；仅具备 `training:publish` 的管理员可直接设 `public` |
| 置顶 | 独立权限 `training:pin`，默认仅管理员 |
| RBAC 粒度 | 细粒度 `training:resource:action`，含独立 `publish` / `pin` |
| 进度覆盖 | 编程题 + 客观题套卷（客观题满分视为 AC） |
| 题目类型 | 题单可收录 U/P/客观题任意类型，不额外过滤 |
| 题目页入口 | “加入题单”仅操作自己创建的题单；管理员在前台对他人题单保持只读 |
| 个人主页 | 本人看全部，他人只看 public |
| 后台管理 | 管理员对任意题单的编辑/置顶/设 public 仅出现在后台管理页 |

## 3. 数据模型

沿用现有约定：`text` 主键、ISO 8601 文本时间戳、Drizzle ORM。

### 3.1 `trainings` 题单主表

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | UUID |
| `title` | text notNull | 1–100 字符 |
| `description` | text notNull default `""` | Markdown 描述 |
| `visibility` | text notNull default `"private"` | `private` / `unlisted` / `public`，CHECK 约束 |
| `is_pinned` | boolean notNull default `false` | 仅管理员可置顶 |
| `created_by` | text notNull FK→users.id | 创建者；用户删除时级联删除其题单 |
| `created_at` | text notNull | ISO 8601 |
| `updated_at` | text notNull | ISO 8601 |

### 3.2 `training_problems` 题单题目关联表

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `training_id` | text notNull FK→trainings.id ON DELETE CASCADE | 所属题单 |
| `problem_id` | text notNull FK→problems.id ON DELETE CASCADE | 题目；题目删除自动清理 |
| `position` | integer notNull default `0` | 题单内排序 |

约束/索引：

- 主键 `(training_id, problem_id)`：同一题单不重复收录同一题。
- 唯一约束 `(training_id, position)`：同一题单内顺序唯一（参考 `contest_problems`）。
- 索引：`trainings(visibility, is_pinned, created_at)` 供公开列表；`trainings(created_by)` 供“我的题单”；`training_problems(training_id, position)` 供详情按序取题。

### 3.3 可见性与权限模型

- `visibility=public` 仅可由具备 `training:publish` 权限的管理员设置；创建者只能设 `private/unlisted`。
- `is_pinned` 仅可由具备 `training:pin` 权限的管理员设置。
- 题单可收录 U/P/客观题任意类型，不额外过滤。
- U 型题目维持“unlisted”式语义：不展示在官方题目目录中，可通过 URL 或题单跳转打开；题单允许收录 U 题，无论题单自身可见性。

## 4. API 设计

### 4.1 用户/公开路由（`/api/v1/trainings`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 公开 | 公开题单列表：仅 `visibility=public`，置顶优先、`updated_at` 倒序，分页 |
| GET | `/mine` | 登录 | 当前用户创建的全部题单（private/unlisted/public），分页 |
| POST | `/` | `training:create` | 创建题单；`visibility` 只能为 `private/unlisted` |
| GET | `/:id` | 公开/受限 | 详情：public/unlisted 任何人可看；private 仅创建者或 `training:read_any` |
| PUT | `/:id` | `training:write_own` / `write_any` | 更新 title/description/visibility；设为 `public` 需 `training:publish`，置顶需 `training:pin` |
| DELETE | `/:id` | `training:delete_own` / `delete_any` | 删除题单（级联删关联） |
| GET | `/:id/problems` | 同详情访问规则 | 有序题目列表，分页；登录用户附带 `accepted` 进度，匿名一律 `false` |
| POST | `/:id/problems` | `training:write_own` / `write_any` | 加题：`{ problem_id, position? }`，不传 `position` 追加到末尾 |
| PUT | `/:id/problems` | 同上 | 批量重排：`{ problems: [{ problem_id, position }] }`，一次提交全量顺序 |
| DELETE | `/:id/problems/:problemId` | 同上 | 从题单移除某题 |

### 4.2 管理员后台路由（`/api/v1/admin/trainings`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `training:read_any` | 查看全部题单（含 private/unlisted），支持按 visibility/creator 筛选 |
| PATCH | `/:id` | `training:publish` 或 `write_any` + `training:pin` | 后台改 `visibility`（可设为 public）、`is_pinned` |
| DELETE | `/:id` | `training:delete_any` | 后台删除任意题单 |

### 4.3 关键规则

- **路由顺序**：`GET /mine` 必须注册在 `GET /:id` 之前，避免 `mine` 被当作 `:id`。
- **可见性访问矩阵**：

| 访问者 | private | unlisted | public |
| --- | --- | --- | --- |
| 匿名 | ❌ | ✅（仅 URL） | ✅ |
| 登录用户（非创建者） | ❌ | ✅ | ✅ |
| 创建者 | ✅ | ✅ | ✅ |
| admin（read_any） | ✅ | ✅ | ✅ |

- **进度（accepted）**：
  - 编程题：当前用户是否存在 `submissions.status='Accepted'`（或经 `evaluationResults` 聚合）的提交。
  - 客观题套卷：当前用户是否存在 `score=10000` 的 `objectiveSubmissions` 提交。
  - 匿名请求不计算进度。
- **加题/排序**：
  - `position` 在同一题单内唯一；插入/重排时服务端统一重写 `position`，避免中间插入产生冲突。
  - 重复收录同一题返回 `ConflictError`。
- **错误处理**：统一走 `AppError`（NotFound/Forbidden/BadRequest/Conflict）。

## 5. RBAC 权限与默认角色

### 5.1 新增权限定义（`PERMISSION_DEFS`）

| resource | action | 说明 |
| --- | --- | --- |
| `training` | `create` | 创建题单 |
| `training` | `read` | 查看题单（自己的 + public/unlisted） |
| `training` | `read_any` | 查看任意题单（含 private） |
| `training` | `write_own` | 编辑自己的题单 |
| `training` | `write_any` | 编辑任意题单 |
| `training` | `delete_own` | 删除自己的题单 |
| `training` | `delete_any` | 删除任意题单 |
| `training` | `publish` | 设置 `visibility=public` |
| `training` | `pin` | 设置/取消 `is_pinned` |

### 5.2 默认角色授权

- **user 角色默认新增**：
  - `training:create`
  - `training:read`
  - `training:write_own`
  - `training:delete_own`
- **admin 角色**：不显式新增，`admin:full_access` 通配覆盖全部（含 `publish`/`pin`/`read_any`/`write_any`/`delete_any`）。
- `training:publish` 与 `training:pin` **不加入 user 默认权限**；如需授予自定义运营角色，在 RBAC 管理面板单独勾选。

### 5.3 服务层权限检查

- 创建：`training:create`
- 查看：`private` → 创建者或 `training:read_any`；`unlisted/public` → `training:read`（匿名可读）
- 更新/加题/排序/移除：创建者 `training:write_own`，非创建者 `training:write_any`
- 设置 `visibility=public`：额外 `training:publish`
- 设置/取消 `is_pinned`：额外 `training:pin`

## 6. 前端 UI 设计

### 6.1 页面路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/trainings` | 题单列表页 | 公开题单（public），置顶优先 + 更新时间倒序，分页；卡片显示标题/简介/创建者/题目数 |
| `/trainings/mine` | 我的题单 | 当前用户创建的全部题单（private/unlisted/public），可新建/编辑/删除/管理题目 |
| `/trainings/[id]` | 题单详情页 | 标题/简介/创建者/可见性；按 `position` 展示题目，每题带 AC 绿勾/灰勾；创建者可见“管理题目”控件 |
| `/users/[id]` | 用户主页扩展 | 新增“我的题单”区块：本人看全部，他人只看 public |
| `/problems/[id]` | 题目详情页扩展 | 新增“加入题单”入口：仅操作自己创建的题单，可新建题单后加入 |
| `/admin/trainings` | 后台题单管理 | admin 查看/筛选全部题单，可改 visibility（含 public）、置顶/取消置顶、编辑/删除任意题单、管理题目 |

### 6.2 关键组件

| 组件 | 用途 |
| --- | --- |
| `components/feature/training/TrainingCard.vue` | 题单卡片 |
| `components/feature/training/TrainingProblemList.vue` | 详情页有序题目列表 + AC 状态 |
| `components/feature/training/TrainingFormModal.vue` | 创建/编辑题单（标题、简介、可见性） |
| `components/feature/training/TrainingProblemManager.vue` | 创建者管理题目：加题/移除/拖拽排序 |
| `components/feature/training/AddToTrainingMenu.vue` | 题目页“加入题单”下拉/弹窗 |
| `components/admin/TrainingManagementSection.vue` | 后台题单管理表格 |

### 6.3 Composables

- `composables/useTrainings.ts`
  - `listPublic()`
  - `listMine()`
  - `getTraining(id)`
  - `createTraining(input)`
  - `updateTraining(id, input)`
  - `deleteTraining(id)`
  - `listTrainingProblems(id)`
  - `addProblem(id, problemId, position?)`
  - `reorderProblems(id, problems[])`
  - `removeProblem(id, problemId)`

### 6.4 交互规则

- **详情页管理控件**：仅创建者本人可见；管理员在前台看他人题单时保持只读，不显示任何“可编辑/管理”标识。
- **后台管理页**：admin 专属，可管理任意题单。
- **进度展示**：登录用户看详情时每题返回 `accepted: true/false`；匿名一律灰勾（或“未登录”提示），不计算进度。
- **加入题单**：题目页弹窗列出当前用户自己的题单；勾选即调用 `addProblem`；也提供“新建题单并加入”。

## 7. 测试计划

### 7.1 noj-core

- **服务层**（`tests/services/trainings.test.ts`）：
  - 创建/更新/删除题单的权限矩阵（创建者、他人、admin、匿名）
  - 可见性访问矩阵（private/unlisted/public × 匿名/登录/创建者/admin）
  - 加题/重复加题/移除/重排（position 唯一、重写顺序）
  - 题目删除后 `training_problems` 级联清理
  - 进度聚合：编程题 Accepted、客观题满分；匿名不计算
- **路由层**（`tests/routes/trainings.test.ts`）：
  - 路由注册顺序（`/mine` 在 `/:id` 前）
  - 请求参数校验（title 长度、visibility 枚举、problem_id 存在性）
  - RBAC 中间件拦截（无 `training:create` 不能建题单；无 `publish` 不能设 public；无 `pin` 不能置顶）
- **RBAC 种子**：验证 `PERMISSION_DEFS` 新增 9 项、user 默认权限新增 4 项、`publish`/`pin` 不在 user 默认中

### 7.2 noj-ui

- 组件/页面走现有 lint + build（`deno lint` / `deno fmt` / `nuxt build`）
- 若项目已有前端测试模式则补充题单列表/详情渲染测试

### 7.3 跨模块 E2E（`noj-tests`）

- 建题单 → 按序加题 → 详情按 position 返回 → 提交 AC 后进度变为 true
- 私有题单对他人不可见、unlisted 仅 URL 可访问、public 出现在列表
- 无 `training:publish` 的用户不能设 public；admin 可设 public/pin
- 删除题目后题单内关联自动消失

## 8. 实施文件清单（预估）

### noj-core

- `src/db/schema.ts`（新增 2 表）
- `drizzle/`（新迁移，自动生成）
- `src/types/trainings.ts`
- `src/services/trainings.ts`
- `src/routes/trainings.ts`
- `src/routes/admin/trainings.ts`（或并入现有 admin 路由）
- `src/app.ts`（挂载路由）
- `src/types/index.ts`（PERMISSION_DEFS）
- `src/services/seed-rbac.ts`（user 默认权限）

### noj-ui

- `pages/trainings/index.vue`、`pages/trainings/mine.vue`、`pages/trainings/[id].vue`
- `pages/admin/trainings.vue`
- `pages/users/[id].vue`、`pages/problems/[id].vue` 扩展
- `components/feature/training/*`、`components/admin/TrainingManagementSection.vue`
- `composables/useTrainings.ts`

### noj-tests

- `e2e/trainings.test.ts`（或按现有命名）
