## ADDED Requirements

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
| type | TEXT | NOT NULL, CHECK IN ('icpc', 'ioi', 'oi') |
| config | JSONB | NOT NULL, DEFAULT '{}' |
| is_public | BOOLEAN | NOT NULL, DEFAULT true |
| password | TEXT | NULLable |
| affect_global_ranking | BOOLEAN | NOT NULL, DEFAULT false |
| created_by | TEXT | NOT NULL, REFERENCES users(id) ON DELETE SET NULL |
| announcement | TEXT | NOT NULL, DEFAULT '' |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

`config` 字段按赛制类型存储不同结构（应用层校验）：

ICPC:
```json
{
  "penalty_minutes": 20,
  "freeze_time": "2026-08-01T10:00:00Z",
  "unfreeze_after_end": true
}
```

IOI:
```json
{
  "show_ranking_live": true
}
```

OI:
```json
{
  "show_ranking_live": false
}
```

`contest_problems` 表字段：
| 字段 | 类型 | 约束 |
|------|------|------|
| contest_id | TEXT | NOT NULL, REFERENCES contests(id) ON DELETE CASCADE |
| problem_id | TEXT | NOT NULL, REFERENCES problems(id) ON DELETE CASCADE |
| sort_order | INTEGER | NOT NULL, DEFAULT 0 |
| label | TEXT | NOT NULL |
| score | INTEGER | NULLable (IOI/OI 每题满分 ×100，ICPC NULL) |
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

#### Scenario: 创建竞赛并绑定题目

- **WHEN** 管理员创建一个 ICPC 竞赛，同时绑定 3 道题（label 分别为 A、B、C）
- **THEN** `contests` 表新增一行，`contest_problems` 表新增三行，label 和 sort_order 均不冲突

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

创建竞赛时 `problems` 数组 MUST 至少包含一道题。`type` MUST 为 `icpc`、`ioi` 或 `oi` 之一。`end_time` MUST 晚于 `start_time`。

#### Scenario: 管理员创建竞赛

- **WHEN** 管理员 POST `/api/v1/admin/contests` 并提供完整信息（含 3 道题目）
- **THEN** 系统返回 201，竞赛被创建，题目被绑定

#### Scenario: 管理员创建竞赛参数校验失败

- **WHEN** 管理员 POST `/api/v1/admin/contests` 但 `problems` 数组为空
- **THEN** 系统返回 400

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

竞赛题目 SHALL 在竞赛开始前对参赛者不可见，竞赛期间仅参赛者可查看，竞赛结束后公开可见。

- `GET /api/v1/contests/:id/problems` — 竞赛题目列表（需登录 + 参赛 + 竞赛非 pending）
- `GET /api/v1/contests/:id/problems/:label` — 单题详情（同上权限）

#### Scenario: 竞赛开始前参赛者查看题目

- **WHEN** 已注册用户在竞赛 pending 期间 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回 403

#### Scenario: 竞赛期间参赛者查看题目

- **WHEN** 已注册用户在竞赛 running 期间 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回题目列表，每题包含 label、sort_order、user_status（solved/attempted/untouched）

#### Scenario: 未注册用户查看竞赛题目

- **WHEN** 未注册用户 GET `/api/v1/contests/:id/problems`
- **THEN** 系统返回 403
