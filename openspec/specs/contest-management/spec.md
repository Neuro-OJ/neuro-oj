## Purpose

定义竞赛管理功能规范，覆盖竞赛数据模型、管理端 CRUD API、公开列表与详情 API、竞赛题目访问控制等。

## Requirements

### Requirement: 竞赛数据模型

系统 SHALL 提供 `contests`、`contest_problems`、`contest_participants`、`contest_clarifications` 四张表存储竞赛相关数据。

`contests` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| id | TEXT | PRIMARY KEY, UUID |
| title | TEXT | NOT NULL |
| description | TEXT | NOT NULL, DEFAULT '' |
| start_time | TEXT | NOT NULL, ISO 8601 |
| end_time | TEXT | NOT NULL, ISO 8601 |
| type | TEXT | NOT NULL, CHECK IN ('kaggle') |
| config | JSONB | NOT NULL, DEFAULT '{}' |
| is_public | BOOLEAN | NOT NULL, DEFAULT true |
| password | TEXT | NULLable |
| affect_global_ranking | BOOLEAN | NOT NULL, DEFAULT false |
| created_by | TEXT | NULLable, REFERENCES users(id) ON DELETE SET NULL |
| announcement | TEXT | NOT NULL, DEFAULT '' |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

`config` 字段 SHALL 支持类 Kaggle 赛制配置：

```json
{
  "submission_limits": { "<problem_id>": 15 }
}
```

`submission_limits` 为可选字段，表示每道题在比赛内最多允许的提交次数；未配置的题目不限制。

`contest_problems` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| contest_id | TEXT | NOT NULL, REFERENCES contests(id) ON DELETE CASCADE |
| problem_id | TEXT | NOT NULL, REFERENCES problems(id) ON DELETE CASCADE |
| sort_order | INTEGER | NOT NULL, DEFAULT 0 |
| label | TEXT | NOT NULL |
| score | INTEGER | NOT NULL, 每题满分 ×100 |
| PRIMARY KEY (contest_id, problem_id) | | |
| UNIQUE (contest_id, label) | | |
| UNIQUE (contest_id, sort_order) | | |

`contest_participants` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| contest_id | TEXT | NOT NULL, REFERENCES contests(id) ON DELETE CASCADE |
| user_id | TEXT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| registered_at | TEXT | NOT NULL, ISO 8601 |
| PRIMARY KEY (contest_id, user_id) | | |

`contest_clarifications` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| id | TEXT | PRIMARY KEY, UUID |
| contest_id | TEXT | NOT NULL, REFERENCES contests(id) ON DELETE CASCADE |
| problem_id | TEXT | REFERENCES problems(id) ON DELETE SET NULL |
| sender_id | TEXT | NOT NULL, REFERENCES users(id) |
| content | TEXT | NOT NULL |
| reply_to_id | TEXT | REFERENCES contest_clarifications(id) |
| is_public | BOOLEAN | NOT NULL, DEFAULT false |
| created_at | TEXT | NOT NULL, ISO 8601 |

#### Scenario: 创建类 Kaggle 竞赛并绑定题目
- **WHEN** 管理员创建一个 `type='kaggle'` 竞赛，同时绑定 3 道题（label 分别为 A、B、C），每题设置 score
- **THEN** `contests` 表新增一行，`contest_problems` 表新增三行，label 和 sort_order 均不冲突

#### Scenario: 配置每道题提交次数限制
- **WHEN** 管理员创建竞赛时设置 `config.submission_limits = { "<problem-id>": 15 }`
- **THEN** 系统保存该配置，比赛期间该题最多接受 15 次提交

#### Scenario: 用户注册参赛
- **WHEN** 用户对公开竞赛调用注册接口
- **THEN** `contest_participants` 表新增一行，`registered_at` 为当前时间

#### Scenario: 删除竞赛时级联清理
- **WHEN** 管理员删除一个竞赛
- **THEN** `contest_problems` 和 `contest_participants` 中关联该竞赛的行被级联删除，关联的 submissions.contest_id 被 SET NULL

### Requirement: 竞赛 CRUD API（管理端）

系统 SHALL 在 `/api/v1/admin` 下提供竞赛管理端点，所有端点 MUST 经过认证和管理员授权。

- `GET /api/v1/admin/contests` — 竞赛列表（含非公开），支持分页
- `POST /api/v1/admin/contests` — 创建竞赛，同时传入题目绑定列表
- `PUT /api/v1/admin/contests/:id` — 编辑竞赛，题目绑定采用 DELETE+INSERT 策略
- `DELETE /api/v1/admin/contests/:id` — 删除竞赛
- `GET /api/v1/admin/contests/:id/participants` — 参与者列表
- `POST /api/v1/admin/contests/:id/participants` — 批量添加参与者（管理员邀请）
- `DELETE /api/v1/admin/contests/:id/participants/:userId` — 移除参与者

创建竞赛时 `problems` 数组 MUST 至少包含一道题。`type` MUST 为 `kaggle`。`end_time` MUST 晚于 `start_time`。

#### Scenario: 管理员创建类 Kaggle 竞赛
- **WHEN** 管理员 POST `/api/v1/admin/contests` 并提供完整信息（含 3 道题目，type='kaggle'）
- **THEN** 系统返回 201，竞赛被创建，题目被绑定

#### Scenario: 管理员创建竞赛参数校验失败
- **WHEN** 管理员 POST `/api/v1/admin/contests` 但 `problems` 数组为空
- **THEN** 系统返回 400

#### Scenario: 使用旧赛制类型被拒
- **WHEN** 管理员 POST `/api/v1/admin/contests` 且 `type='icpc'`
- **THEN** 系统返回 400，提示仅允许 `kaggle`

#### Scenario: 非管理员创建竞赛被拒
- **WHEN** 普通用户 POST `/api/v1/admin/contests`
- **THEN** 系统返回 403

### Requirement: 竞赛列表与详情 API（公开）

系统 SHALL 提供竞赛的公开访问端点。

- `GET /api/v1/contests` — 公开竞赛列表（仅返回 is_public=true），支持按 type 筛选，分页
- `GET /api/v1/contests/:id` — 竞赛详情，包含 `status` 字段（动态计算）、题目数量、参与者数量。若用户已登录，额外包含 `is_registered` 字段

`status` 字段 SHALL 根据当前时间与 `start_time`/`end_time` 动态计算：`Date.now() < start_time → pending`；`Date.now() < end_time → running`；否则 `ended`。

#### Scenario: 查看进行中的公开竞赛
- **WHEN** 任意访问者 GET `/api/v1/contests/<running-contest-id>`
- **THEN** 系统返回 200，`status` 为 `running`

#### Scenario: 已登录用户查看已注册的竞赛
- **WHEN** 已注册用户 UserA GET `/api/v1/contests/<contest-id>`
- **THEN** 系统返回 200，`is_registered` 为 `true`

#### Scenario: 查看非公开竞赛
- **WHEN** 非管理员 GET `/api/v1/contests/<private-contest-id>`
- **THEN** 系统返回 404

### Requirement: 竞赛题目访问控制

竞赛题目 SHALL 遵循三级访问控制：
- 竞赛开始前（pending）：任何用户（含参赛者）不可见
- 竞赛进行中（running）：仅参赛者可查看
- 竞赛结束后（ended）：任意已登录用户可查看题目列表和详情

- `GET /api/v1/contests/:id/problems` — 竞赛题目列表（需登录）
- `GET /api/v1/contests/:id/problems/:label` — 单题详情（需登录）

#### Scenario: 竞赛开始前参赛者查看题目
- **WHEN** 已注册用户在竞赛 pending 期间 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回 403

#### Scenario: 竞赛期间参赛者查看题目
- **WHEN** 已注册用户在竞赛 running 期间 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回题目列表，每题包含 label、sort_order、user_status（solved/attempted/untouched）

#### Scenario: 未注册用户查看竞赛题目
- **WHEN** 未注册用户 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回 403

#### Scenario: 非参赛者查看已结束竞赛题目
- **WHEN** 已登录但未参赛的用户请求已结束竞赛的题目列表或单题详情
- **THEN** 系统返回对应的竞赛题目数据

#### Scenario: 非参赛者查看进行中竞赛题目
- **WHEN** 已登录但未参赛的用户请求进行中竞赛的题目列表或单题详情
- **THEN** 系统返回 403

### Requirement: 管理端竞赛保存反馈与列表刷新

管理端竞赛创建或编辑操作成功后，系统 SHALL 在当前页面立即显示对应的成功反馈并刷新当前竞赛列表；保存请求在完成前 MUST 禁止再次提交同一表单。列表刷新失败时，系统 SHALL 保留当前已有列表数据，并明确提示刷新失败，不得将已经成功写入的竞赛操作报告为创建失败。

#### Scenario: 管理员成功创建竞赛

- **WHEN** 管理员在管理后台提交合法竞赛信息且服务端返回成功
- **THEN** 页面显示“竞赛已创建”成功反馈、关闭编辑弹窗，并在当前页面列表中显示新竞赛

#### Scenario: 管理员成功编辑竞赛

- **WHEN** 管理员在管理后台提交合法竞赛修改且服务端返回成功
- **THEN** 页面显示“竞赛已更新”成功反馈、关闭编辑弹窗，并刷新当前页面列表

#### Scenario: 保存期间重复点击

- **WHEN** 管理员在创建请求尚未完成时再次点击保存
- **THEN** 页面只发起一次保存请求，保存按钮保持禁用并显示进行中状态

#### Scenario: 保存成功但列表刷新失败

- **WHEN** 竞赛保存请求已成功完成但随后列表刷新请求失败
- **THEN** 页面保留原有列表数据，显示竞赛保存成功反馈，并额外提示列表刷新失败，不得再次发起创建请求
