## MODIFIED Requirements

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
