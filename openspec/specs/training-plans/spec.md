## Purpose

定义 Neuro OJ 题单（Training Plan）功能规范，包括题单数据模型、可见性访问控制、用户侧与管理员 CRUD API、题目管理、AC 进度聚合以及前端页面。

## Requirements

### Requirement: 题单数据模型

系统 SHALL 提供 `trainings` 与 `training_problems` 两张表存储题单数据。

`trainings` 表字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | TEXT | PRIMARY KEY, UUID |
| title | TEXT | NOT NULL, 1-100 字符 |
| description | TEXT | NOT NULL, DEFAULT '' |
| visibility | TEXT | NOT NULL, DEFAULT 'private', CHECK IN ('private', 'unlisted', 'public') |
| is_pinned | BOOLEAN | NOT NULL, DEFAULT false |
| created_by | TEXT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

`training_problems` 表字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| training_id | TEXT | NOT NULL, REFERENCES trainings(id) ON DELETE CASCADE |
| problem_id | TEXT | NOT NULL, REFERENCES problems(id) ON DELETE CASCADE |
| position | INTEGER | NOT NULL, DEFAULT 0 |
| PRIMARY KEY (training_id, problem_id) | | |
| UNIQUE (training_id, position) | | |

系统 SHALL 在题目被删除时通过 `ON DELETE CASCADE` 自动清理 `training_problems` 中的关联行。

#### Scenario: 创建题单
- **WHEN** 登录用户创建题单并指定标题与可见性
- **THEN** `trainings` 表新增一行，`created_by` 为该用户，`is_pinned` 为 false

#### Scenario: 题目删除自动清理关联
- **WHEN** 管理员或题主删除一道已被题单收录的题目
- **THEN** `training_problems` 中关联该题目的行被自动删除，题单本身保留

### Requirement: 题单可见性与访问控制

系统 SHALL 支持三种可见性：`private`（仅创建者或 `training:read_any` 可见）、`unlisted`（知道 URL 即可访问，不出现在公开列表）、`public`（出现在公开题单列表）。

系统 SHALL 仅允许具备 `training:publish` 权限的用户将题单可见性设为 `public`，仅允许具备 `training:pin` 权限的用户设置 `is_pinned`。

访问矩阵 MUST 为：

| 访问者 | private | unlisted | public |
|--------|---------|----------|--------|
| 匿名 | 不可见 | 可见（仅 URL） | 可见 |
| 登录用户（非创建者） | 不可见 | 可见（仅 URL） | 可见 |
| 创建者 | 可见 | 可见 | 可见 |
| admin / read_any | 可见 | 可见 | 可见 |

对于无权访问的 private 题单，系统 MUST 返回 404（不暴露题单存在）。

#### Scenario: 私有题单对他人隐藏
- **WHEN** 非创建者用户访问一个 `private` 题单详情
- **THEN** 系统返回 404

#### Scenario: 创建者访问自己的私有题单
- **WHEN** 创建者访问自己的 `private` 题单详情
- **THEN** 系统返回题单详情

#### Scenario: unlisted 不出现在公开列表
- **WHEN** 匿名用户请求公开题单列表
- **THEN** 列表只包含 `public` 题单，不包含 `unlisted` 题单

#### Scenario: 普通用户不能设为 public
- **WHEN** 普通用户更新自己的题单可见性为 `public`
- **THEN** 系统返回 403

#### Scenario: 普通用户不能置顶
- **WHEN** 普通用户更新自己的题单 `is_pinned` 为 true
- **THEN** 系统返回 403

### Requirement: 题单 CRUD API（用户侧）

系统 SHALL 在 `/api/v1/trainings` 下提供以下端点：

- `GET /api/v1/trainings` — 公开题单列表，仅 `public`，置顶优先、`updated_at` 倒序，分页
- `GET /api/v1/trainings?created_by=:userId` — 用户主页题单列表：本人或 admin 返回全部可见性，其他访客仅返回 public
- `GET /api/v1/trainings/mine` — 当前用户创建的全部题单，分页
- `POST /api/v1/trainings` — 创建题单，需 `training:create`，可见性只能为 `private/unlisted`
- `GET /api/v1/trainings/:id` — 题单详情，按可见性访问矩阵控制
- `PUT /api/v1/trainings/:id` — 更新题单，创建者需 `training:write_own`，非创建者需 `training:write_any`；设 `public` 需 `training:publish`，设 `is_pinned` 需 `training:pin`
- `DELETE /api/v1/trainings/:id` — 删除题单，创建者需 `training:delete_own`，非创建者需 `training:delete_any`

`title` MUST 为 1-100 字符。创建时 `visibility` MUST 只能是 `private` 或 `unlisted`。

#### Scenario: 登录用户创建题单
- **WHEN** 登录用户 POST `/api/v1/trainings` 提供合法 title 和 visibility
- **THEN** 系统返回 201 和题单详情

#### Scenario: 创建题单时设为 public 被拒
- **WHEN** 普通用户 POST `/api/v1/trainings` 且 `visibility=public`
- **THEN** 系统返回 400

#### Scenario: 非创建者编辑他人题单被拒
- **WHEN** 普通用户 PUT 他人的题单
- **THEN** 系统返回 403

#### Scenario: 我的题单只返回本人创建
- **WHEN** 登录用户 GET `/api/v1/trainings/mine`
- **THEN** 系统只返回该用户创建的题单

### Requirement: 题单题目管理 API

系统 SHALL 在 `/api/v1/trainings/:id/problems` 下提供题目管理端点：

- `GET /api/v1/trainings/:id/problems` — 返回题单内有序题目列表，按 `position` 升序
- `POST /api/v1/trainings/:id/problems` — 加题，body `{ problem_id, position? }`，不传 position 追加到末尾
- `PUT /api/v1/trainings/:id/problems` — 批量重排，body `{ problems: [{ problem_id, position }] }`，必须包含题单当前全部题目
- `DELETE /api/v1/trainings/:id/problems/:problemId` — 从题单移除题目

权限 MUST 与更新题单一致：创建者需 `training:write_own`，非创建者需 `training:write_any`。

同一题单 MUST 不能重复收录同一道题，重复时返回 409。`position` MUST 为非负整数且在同一题单内唯一。

#### Scenario: 按序加题
- **WHEN** 创建者向题单连续加入题目 A、B、C
- **THEN** 题目按加入顺序获得 position 0、1、2，详情按 position 返回

#### Scenario: 指定位置插入
- **WHEN** 创建者向已有 [A,B] 的题单在 position 0 插入 C
- **THEN** 原 position 0/1 的题目变为 1/2，C 的 position 为 0

#### Scenario: 重复加题被拒
- **WHEN** 创建者向已包含题目 A 的题单再次加入 A
- **THEN** 系统返回 409

#### Scenario: 批量重排
- **WHEN** 创建者 PUT `/api/v1/trainings/:id/problems` 提交全量新顺序
- **THEN** 题单内题目顺序按新 position 保存

#### Scenario: 批量重排缺少题目被拒
- **WHEN** 创建者提交的重排数组未包含题单当前全部题目
- **THEN** 系统返回 400

### Requirement: AC 进度聚合

系统 SHALL 在题单题目列表的响应中为登录用户返回每题 `accepted` 布尔值。

判定规则 MUST 为：

- 编程题：当前用户存在 `submissions` join `evaluation_results` 且 `evaluation_results.status='Accepted'` 的记录
- 客观题套卷：当前用户存在 `objective_submissions` 且 `score=10000` 的记录
- 匿名请求不计算进度，`accepted` 恒为 false

#### Scenario: 编程题 AC 后进度为 true
- **WHEN** 登录用户对题单内编程题提交并通过（Accepted）
- **THEN** 该题在题单题目列表中 `accepted=true`

#### Scenario: 客观题满分后进度为 true
- **WHEN** 登录用户对题单内客观题套卷提交并获得满分 10000
- **THEN** 该套卷在题单题目列表中 `accepted=true`

#### Scenario: 匿名用户查看进度
- **WHEN** 匿名用户请求题单题目列表
- **THEN** 每题 `accepted` 均为 false

### Requirement: 管理员后台管理

系统 SHALL 在 `/api/v1/admin/trainings` 下提供后台管理端点：

- `GET /api/v1/admin/trainings` — 查看全部题单（含 private/unlisted），分页，需 `training:read_any`
- `PATCH /api/v1/admin/trainings/:id` — 更新任意题单的可见性、置顶、标题、简介；设 `public` 需 `training:publish`，设 `is_pinned` 需 `training:pin`
- `DELETE /api/v1/admin/trainings/:id` — 删除任意题单，需 `training:delete_any`

管理员对他人题单的编辑 MUST 只通过后台管理端点暴露，前台展示他人题单时不得显示编辑/管理控件。

#### Scenario: 管理员查看全部题单
- **WHEN** 具备 `training:read_any` 的用户 GET `/api/v1/admin/trainings`
- **THEN** 系统返回包含 private/unlisted/public 的全部题单分页列表

#### Scenario: 管理员将题单设为公开并置顶
- **WHEN** 具备 `training:publish` 和 `training:pin` 的管理员 PATCH 题单为 `{ visibility: "public", is_pinned: true }`
- **THEN** 题单出现在公开列表且排序优先

#### Scenario: 普通用户访问后台端点被拒
- **WHEN** 普通用户 GET `/api/v1/admin/trainings`
- **THEN** 系统返回 403

### Requirement: 前端题单页面

系统 SHALL 提供以下前端页面与入口：

- `/trainings` — 公开题单列表页
- `/trainings/mine` — 我的题单页，可新建/删除
- `/trainings/[id]` — 题单详情页，按序展示题目与 AC 进度；创建者可见管理题目控件
- `/admin/trainings` — 后台题单管理页
- 用户主页展示“我的题单”区块：本人看全部，他人只看 public
- 题目详情页提供“加入题单”入口：仅操作当前用户自己创建的题单

前台展示他人题单时 MUST 保持只读，即使当前用户是管理员也不显示可编辑标识。

#### Scenario: 公开题单列表展示
- **WHEN** 用户访问 `/trainings`
- **THEN** 页面展示 public 题单，置顶优先

#### Scenario: 详情页只读展示他人题单
- **WHEN** 非创建者（含管理员）访问他人题单详情
- **THEN** 页面只读展示题目与进度，不显示管理控件

#### Scenario: 题目页加入自己的题单
- **WHEN** 登录用户打开题目详情并选择自己的题单加入
- **THEN** 该题目被加入所选题单，重复加入被拒绝并提示
