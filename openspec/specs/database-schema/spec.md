## Purpose

定义 Neuro OJ 核心数据模型，支撑用户管理、题目管理、提交评测等业务功能。基于
PostgreSQL + Drizzle ORM 实现持久化和迁移。
## Requirements
### Requirement: 用户表（users）

系统 SHALL 提供 `users` 表存储用户信息，包含以下字段：

| 字段          | 类型 | 约束                     |
| ------------- | ---- | ------------------------ |
| id            | TEXT | PRIMARY KEY, UUID v4     |
| username      | TEXT | NOT NULL, UNIQUE         |
| email         | TEXT | NOT NULL, UNIQUE         |
| password_hash | TEXT | NOT NULL                 |
| must_change_password | BOOLEAN | NOT NULL, DEFAULT false |
| bio           | TEXT | DEFAULT ''               |
| avatar_url    | TEXT | NULL（`noj-storage://` URL） |
| created_at    | TEXT | NOT NULL, ISO 8601       |
| updated_at    | TEXT | NOT NULL, ISO 8601       |

> `bio` 字段存储用户个人简介（Markdown 格式），默认为空字符串。
>
> `avatar_url` 字段存储用户头像的 `noj-storage://` URL（local 或 s3 模式），未设置时为 NULL（issue #229）。

#### Scenario: 插入新用户

- **WHEN** 向 `users` 表插入一条包含 username、email、password_hash 的记录
- **THEN** 系统自动生成 UUID 主键，bio 默认为 ''，created_at 和 updated_at
  自动填充当前 ISO 8601 时间戳

#### Scenario: 用户名唯一约束

- **WHEN** 尝试插入与已存在记录相同 username 的行
- **THEN** 数据库返回 UNIQUE 约束冲突错误

#### Scenario: 用户设置 bio

- **WHEN** 更新用户的 bio 字段为 `"## 关于我\n\n热爱算法竞赛"`
- **THEN** 数据库中该用户的 bio 字段存储对应的 Markdown 文本

#### Scenario: bio 可为空

- **WHEN** 查询未设置 bio 的用户
- **THEN** 返回的 bio 字段为空字符串 `""`

### Requirement: users.must_change_password 列

`users` 表 MUST 包含 `must_change_password BOOLEAN NOT NULL DEFAULT false` 列，用于标记用户首次登录后是否必须修改密码。

约束：

- `NOT NULL` — 不允许空值
- `DEFAULT false` — 存量用户默认 `false`，向前兼容
- 仅在以下场景被置为 `true`：种子脚本的 `ensureBootstrapAdmin()` 创建临时管理员时
- 仅在以下场景被置为 `false`：种子脚本的普通用户注册时（默认）、`changePassword()` 成功后

#### Scenario: 字段存在且默认 false

- **WHEN** 数据库执行 migration 后查询 `users` 表结构
- **THEN** 表中存在 `must_change_password boolean NOT NULL DEFAULT false` 列

#### Scenario: 存量用户默认值

- **WHEN** migration 在含已有用户的数据库上执行
- **THEN** 所有存量用户的 `must_change_password` 为 `false`，不影响其登录流程

#### Scenario: 引导管理员创建时置位

- **WHEN** `ensureBootstrapAdmin()` 插入临时管理员记录
- **THEN** 该用户记录的 `must_change_password=true`

#### Scenario: changePassword 成功后清字段

- **WHEN** 用户成功调用 `POST /api/v1/auth/change-password`
- **THEN** 该用户记录的 `must_change_password=false`

### Requirement: 题目表（problems）

系统 SHALL 提供 `problems` 表存储题目信息。编程题（U/P 型）支持自定义评测环境配置；客观题套卷（客观题）无评测环境（`runtime_config` 可空）：

| 字段                 | 类型    | 约束                                 | 说明                           |
| -------------------- | ------- | ------------------------------------ | ------------------------------ |
| id                   | TEXT    | PRIMARY KEY, UUID v4                 |                                |
| title                | TEXT    | NOT NULL                             | 题目标题 / 套卷标题            |
| description          | TEXT    | NOT NULL                             | 题目描述（Markdown）           |
| difficulty           | TEXT    | NOT NULL, DEFAULT 'medium'           | easy / medium / hard           |
| runtime_config       | JSONB   | 可空（U/P 型必填）                    | 双容器评测配置；客观题为 NULL    |
| support_package_storage_url | TEXT | 可空                               | 支持包存储 URL（仅 U/P 型使用）|
| number               | INTEGER | NOT NULL, UNIQUE(type, number)       | 题号（同一 type 内独立自增）   |
| owner_id             | TEXT    | NOT NULL, DEFAULT '0', FK → users.id | 题目所有者 ID，默认 root       |
| type                 | TEXT    | NOT NULL, DEFAULT 'U', CHECK('U','P') | 题目类型：U=用户题, P=管理题 |
| is_objective         | BOOLEAN | NOT NULL, DEFAULT false              | 客观题套卷标记（无评测容器，服务端即时判定） |
| created_at           | TEXT    | NOT NULL, ISO 8601                   |                                |
| updated_at           | TEXT    | NOT NULL, ISO 8601                   |                                |

> **注意：** 不包含 `test_cases` 列。测试用例由支持包 zip 内的评测脚本管理。

#### Scenario: 创建 LMCC 题目

- **WHEN** 插入一道题目，指定 judge_image 为 `python:3.12-slim`，judge_command
  为 `python3 /workspace/evaluate.py`
- **THEN** 题目记录包含完整的评测环境配置，support_package_path
  可为空（待后续上传），值应为相对 CWD 的路径

#### Scenario: 题目默认资源限制

- **WHEN** 创建题目未指定 time_limit_ms 和 memory_limit_mb
- **THEN** 系统默认设置 time_limit_ms=5000, memory_limit_mb=512

#### Scenario: 插入 U 型题目

- **WHEN** 向 problems 表插入一条 type='U' 的记录
- **THEN** owner_id 默认为 '0'（root），number 须在 U 型范围内唯一

#### Scenario: 插入 P 型题目

- **WHEN** 向 problems 表插入一条 type='P' 的记录
- **THEN** 允许与 U 型题目有相同的 number 值（不同 type 独立编号）

#### Scenario: 插入 客观题套卷

- **WHEN** 向 problems 表插入一条 type='U'（或 'P'）、is_objective=true、runtime_config=NULL 的记录
- **THEN** 允许插入，number 在所属 type 范围内独立自增

#### Scenario: type + number 组合唯一约束

- **WHEN** 尝试插入 type='U', number=1 且已存在同 type+number 的记录
- **THEN** 数据库返回 UNIQUE 约束冲突错误

#### Scenario: 非法 type 被拒

- **WHEN** 尝试插入 type='X' 的记录
- **THEN** 数据库 CHECK 约束拒绝插入

### Requirement: 提交表（submissions）

系统 SHALL 提供 `submissions` 表存储用户代码提交：

| 字段       | 类型 | 约束                        | 说明                         |
| ---------- | ---- | --------------------------- | ---------------------------- |
| id         | TEXT | PRIMARY KEY, UUID v4        |                              |
| user_id    | TEXT | NOT NULL, FK → users.id     |                              |
| problem_id | TEXT | NOT NULL, FK → problems.id  |                              |
| language   | TEXT | NOT NULL                    | 编程语言标识                 |
| code       | TEXT | NOT NULL                    | 源代码                       |
| file_name  | TEXT |                             | 用户文件名，挂载到容器时使用 |
| status     | TEXT | NOT NULL, DEFAULT 'pending' | pending / judging / finished |
| created_at | TEXT | NOT NULL, ISO 8601          |                              |

#### Scenario: 创建提交

- **WHEN** 用户提交代码（user_id、problem_id、language、code）
- **THEN** 系统生成 UUID 主键，status 初始为 'pending'，created_at 自动填充

#### Scenario: 提交状态流转

- **WHEN** 评测 Worker 开始处理提交
- **THEN** status 从 'pending' 更新为 'judging'
- **WHEN** 评测 Worker 完成评测
- **THEN** status 从 'judging' 更新为 'finished'

### Requirement: 评测结果表（evaluation_results）

系统 SHALL 提供 `evaluation_results` 表存储评测结果：

| 字段          | 类型    | 约束                                  | 说明             |
| ------------- | ------- | ------------------------------------- | ---------------- |
| id            | TEXT    | PRIMARY KEY, UUID v4                  |                  |
| submission_id | TEXT    | NOT NULL, FK → submissions.id, UNIQUE | 1:1              |
| status        | TEXT    | NOT NULL                              | 评测状态         |
| score         | INTEGER | NOT NULL, DEFAULT 0                   | 得分 ×100        |
| output        | TEXT    | NOT NULL, DEFAULT ''                  | 评测命令原始输出 |
| details       | TEXT    | NOT NULL, DEFAULT '{}'                | JSON 详情        |
| time_ms       | INTEGER |                                       | 耗时（毫秒）     |
| memory_kb     | INTEGER |                                       | 内存（KB）       |
| created_at    | TEXT    | NOT NULL, ISO 8601                    |                  |

#### Scenario: 存储评测结果

- **WHEN** 评测返回 status='Accepted', score=100（存储值 10000）
- **THEN** 系统将完整结果存入 evaluation_results，submission_id 唯一

#### Scenario: 分数精度

- **WHEN** 评测返回 score=99.5
- **THEN** 系统将 99.5 × 100 = 9950 存储为 INTEGER，API 读取时除以 100 还原

### Requirement: 密码重置令牌表（password_reset_tokens）

系统 SHALL 提供 `password_reset_tokens` 表存储密码重置令牌，包含以下字段：

| 字段       | 类型 | 约束                                              | 说明                              |
| ---------- | ---- | ------------------------------------------------- | --------------------------------- |
| id         | TEXT | PRIMARY KEY, UUID v4                              | 令牌记录主键                      |
| user_id    | TEXT | NOT NULL, FK → users.id ON DELETE CASCADE         | 关联用户                          |
| token_hash | TEXT | NOT NULL, UNIQUE                                  | 令牌 SHA-256 hex 哈希（不存明文） |
| expires_at | TEXT | NOT NULL, ISO 8601                                | 过期时间，now + 15 分钟            |
| used_at    | TEXT | NULL, ISO 8601                                    | 使用时间（NULL = 未使用）         |
| created_at | TEXT | NOT NULL, ISO 8601                                | 创建时间                          |

#### Scenario: 创建令牌记录

- **WHEN** 用户请求密码重置且邮箱已注册
- **THEN** 系统在 `password_reset_tokens` 表插入一行，含 user_id、token_hash、expires_at = now + 15min、used_at = NULL

#### Scenario: 令牌唯一性

- **WHEN** 尝试插入与已存在 token_hash 重复的记录
- **THEN** 数据库返回 UNIQUE 约束冲突错误

#### Scenario: 用户删除级联清理令牌

- **WHEN** 删除 users 表中某用户
- **THEN** 数据库自动级联删除其所有 password_reset_tokens 记录（FK CASCADE）

### Requirement: 密码重置令牌索引

系统 SHALL 在 `password_reset_tokens` 表创建以下索引以优化查询：

- `password_reset_tokens_token_hash_unique`：UNIQUE 索引，列 token_hash（防重复 + 加速查表）
- `password_reset_tokens_user_id_idx`：BTREE 索引，列 user_id（按用户查历史）
- `password_reset_tokens_expires_at_idx`：BTREE 索引，列 expires_at（后续 lazy cleanup 用）

#### Scenario: 通过 token_hash 查表

- **WHEN** 重置密码接口用 token_hash 查表
- **THEN** 数据库走 UNIQUE 索引，O(log n) 定位单行

### Requirement: 签到记录表（check_ins）

系统 SHALL 提供 `check_ins` 表记录用户每日签到状态及连续签到天数。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY, UUID v4 | 记录主键 |
| user_id | TEXT | NOT NULL, FK→users.id | 签到用户 |
| checkin_date | TEXT | NOT NULL | 签到日期，格式 YYYY-MM-DD（UTC） |
| streak | INTEGER | NOT NULL, DEFAULT 1 | 连续签到天数 |
| created_at | TEXT | NOT NULL, ISO 8601 | 记录创建时间 |

唯一约束：`UNIQUE (user_id, checkin_date)`，防止同日重复签到。

#### Scenario: 用户首次签到

- **WHEN** 用户首次调用签到接口
- **THEN** 数据库插入一条新记录，streak = 1

#### Scenario: 连续签到累计 streak

- **WHEN** 用户昨日已签到（昨日 streak = 3）且今日签到
- **THEN** 新记录 streak = 4

#### Scenario: 断签后重新签到

- **WHEN** 用户昨日未签到但今日签到
- **THEN** 新记录 streak = 1（重置，不累加）

#### Scenario: 同日重复签到

- **WHEN** 用户尝试在同一天第二次签到
- **THEN** 数据库 UNIQUE 约束拒绝，服务层返回 400 BAD_REQUEST

### Requirement: 数据库迁移自动执行

系统 SHALL 在启动时自动执行数据库迁移，确保 schema 与代码一致。迁移按顺序编号执行（0000-0007），目前包含 8 个迁移文件。

#### Scenario: 首次启动

- **WHEN** noj-core 启动且成功连接到 PostgreSQL（通过 `DATABASE_URL` 环境变量）
- **THEN** 系统在数据库中自动执行所有待执行的 migration，按顺序创建 4 张表

#### Scenario: 已有数据库启动

- **WHEN** noj-core 启动且数据库中所有 migration 已执行
- **THEN** 系统跳过迁移，正常启动

#### Scenario: 首次执行 0004（U/P 题库拆分迁移）

- **WHEN** noj-core 启动且 migration 0004 未执行
- **THEN** 系统执行 ALTER TABLE 添加 owner_id、type、number，创建 CHECK 和 UNIQUE 约束，迁移已有数据

### Requirement: 健康检查包含数据库状态

系统 SHALL 在 `/health` 端点返回数据库连接状态。

#### Scenario: 数据库正常

- **WHEN** GET `/health` 且数据库连接正常
- **THEN** 响应 JSON 包含 `"database": "ok"`

#### Scenario: 数据库异常

- **WHEN** GET `/health` 且数据库连接异常
- **THEN** 响应 JSON 包含 `"database": "error"` 及错误信息

### Requirement: PG 错误码兼容

系统 SHALL 在检查 PostgreSQL 约束冲突错误码（`23505`）时，同时兼容两种错误对象结构：

- postgres.js 驱动：`err.code === '23505'`
- PGlite WASM 驱动：`err.cause.code === '23505'`

`problems.ts` 中创建题目并发冲突重试逻辑的错误码检查 MUST 兼容两种结构。

#### Scenario: postgres.js 模式下捕获 UNIQUE 冲突

- **WHEN** `DATABASE_URL` 已设置，插入题目触发 `(type, number)` UNIQUE 约束冲突
- **THEN** `err.code === '23505'` 为 true，重试逻辑正常触发

#### Scenario: PGlite 模式下捕获 UNIQUE 冲突

- **WHEN** `DATABASE_URL` 未设置（PGlite 模式），插入题目触发 `(type, number)` UNIQUE 约束冲突
- **THEN** `err.cause.code === '23505'` 为 true，重试逻辑正常触发

### Requirement: search_vector 列（issue #100）

`problems` 和 `users` 表 MUST 各包含一个 `search_vector tsvector` 列，由
PostgreSQL `GENERATED ALWAYS AS ... STORED` 表达式自动维护，应用层只读：

| 表        | 字段构成                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `problems`| `setweight(to_tsvector('simple', title), 'A')` + `setweight(to_tsvector('simple', type \|\| ' ' \|\| number::text), 'B')` |
| `users`   | `setweight(to_tsvector('simple', username), 'A')` + `setweight(to_tsvector('simple', email), 'B')`           |

权重 A=1.0、B=0.4，由 `ts_rank` 自动按权重排序。

系统 MUST 同时创建双 GIN 索引以支持中英文混合搜索：

- `idx_<table>_search_vector`：GIN(tsvector)，英文/数字分词精确匹配（`@@
  websearch_to_tsquery`）
- `idx_<table>_<col>_trgm`：GIN(pg_trgm)（`title` / `username`），中文 trigram
  模糊匹配（`ILIKE` + ILIKE 索引路径）

`pg_trgm` 扩展由迁移启用（`CREATE EXTENSION IF NOT EXISTS pg_trgm`）。

ORM 映射：Drizzle ORM 0.45.x 不导出原生 `tsvector` 列类型，使用
`customType<{ data: string }>({ dataType: () => "tsvector" })` 注册（Drizzle
文档 *Custom Types*），`searchVector` 字段只用于 `SELECT`，**禁止写入**。

#### Scenario: 写入题目后 search_vector 自动更新

- **WHEN** `INSERT INTO problems (title, ...) VALUES ('动态规划入门', ...)`
- **THEN** PG 自动计算 `search_vector`，包含 `'动态':1 '规划':2 '入门':3
  '动':4 ...` 等 token

#### Scenario: 更新题目标题后自动重算

- **WHEN** `UPDATE problems SET title = '新标题' WHERE id = ?`
- **THEN** 该行的 `search_vector` 自动重算为新分词，旧 token 不残留

#### Scenario: 应用层禁止写入 search_vector

- **WHEN** 应用层尝试 `UPDATE problems SET search_vector = '...'`
- **THEN** PG 拒绝写入（GENERATED ALWAYS 列不可 UPDATE）

#### Scenario: 英文+数字分词精确命中

- **WHEN** 搜索 `q = "P1001"`
- **THEN** `tsvector @@ websearch_to_tsquery('simple', 'P1001')` 走
  `idx_problems_search_vector` GIN 索引直接命中

#### Scenario: 中文走 trigram 索引

- **WHEN** 搜索 `q = "动态规划"`
- **THEN** `title ILIKE '%动态规划%'` 走 `idx_problems_title_trgm` GIN
  trigram 索引（`tsvector` 对中文按字分词召回率不足时由 ILIKE 兜底）

### Requirement: 角色表（roles）

系统 SHALL 提供 `roles` 表存储角色定义，包含以下字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() |
| name | TEXT | NOT NULL, UNIQUE |
| description | TEXT | |
| is_system | BOOLEAN | NOT NULL, DEFAULT false |
| is_default | BOOLEAN | NOT NULL, DEFAULT false |
| parent_id | UUID | REFERENCES roles(id) ON DELETE SET NULL |
| created_at | TEXT | NOT NULL, ISO 8601 |
| updated_at | TEXT | NOT NULL, ISO 8601 |

系统 SHALL 预置两个角色：`admin`（is_system=true）和 `user`（is_default=true, is_system=true）。

#### Scenario: 插入新角色
- **WHEN** 向 `roles` 表插入一条记录
- **THEN** 系统自动生成 UUID，is_system/is_default 默认 false，created_at 和 updated_at 自动填充

#### Scenario: 角色名唯一约束
- **WHEN** 尝试插入与已存在记录相同 name 的角色
- **THEN** 数据库返回 UNIQUE 约束冲突

### Requirement: 权限表（permissions）

系统 SHALL 提供 `permissions` 表存储权限定义，包含以下字段：

| 字段 | 类型 | 约束 |
|------|------|------|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() |
| resource | TEXT | NOT NULL |
| action | TEXT | NOT NULL |
| description | TEXT | |
| UNIQUE (resource, action) | | |

权限名称为 `resource:action` 格式，由应用层拼接。

系统 SHALL 预置 42 个权限定义，覆盖 admin、problem、submission、user、tag、contest、community、system 资源域。

#### Scenario: 插入权限定义
- **WHEN** seed 脚本插入 `resource='problem'`, `action='create'`, `description='创建题目'`
- **THEN** 系统在 permissions 表中创建对应记录

#### Scenario: 资源+操作唯一约束
- **WHEN** 尝试插入与已存在记录相同的 (resource, action) 组合
- **THEN** 数据库返回 UNIQUE 约束冲突

### Requirement: 角色权限关联表（role_permissions）

系统 SHALL 提供 `role_permissions` 表：

| 字段 | 类型 | 约束 |
|------|------|------|
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| permission_id | UUID | REFERENCES permissions(id) ON DELETE CASCADE |
| PRIMARY KEY (role_id, permission_id) | | |

#### Scenario: 级联删除角色时清理关联
- **WHEN** 删除一个角色
- **THEN** `role_permissions` 中该角色的所有权限关联被级联删除

### Requirement: 用户角色关联表（user_roles）

系统 SHALL 提供 `user_roles` 表：

| 字段 | 类型 | 约束 |
|------|------|------|
| user_id | UUID | REFERENCES users(id) ON DELETE CASCADE |
| role_id | UUID | REFERENCES roles(id) ON DELETE CASCADE |
| PRIMARY KEY (user_id, role_id) | | |

#### Scenario: 级联删除用户时清理关联
- **WHEN** 删除一个用户
- **THEN** `user_roles` 中该用户的所有角色关联被级联删除

#### Scenario: 级联删除角色时清理用户关联
- **WHEN** 删除一个非系统角色
- **THEN** `user_roles` 中所有关联该角色的行被级联删除

### Requirement: submissions.contest_id 列

`submissions` 表 SHALL 新增 `contest_id TEXT REFERENCES contests(id) ON DELETE SET NULL` 列。

- NULL = 非竞赛提交（默认值，向前兼容）
- 非 NULL = 竞赛内提交，指向对应竞赛
- 竞赛删除时 SHALL SET NULL（保留提交记录）

#### Scenario: 竞赛提交写入 contest_id
- **WHEN** 用户通过 `POST /api/v1/contests/:id/submit` 创建竞赛提交
- **THEN** `submissions` 表中该记录的 `contest_id` 被设置为对应竞赛 ID

#### Scenario: 普通提交 contest_id 为 NULL
- **WHEN** 用户通过 `POST /api/v1/submissions` 创建普通提交
- **THEN** `submissions` 表中该记录的 `contest_id` 为 NULL

#### Scenario: 删除竞赛不删除提交
- **WHEN** 管理员删除一个竞赛，该竞赛有 100 条关联提交
- **THEN** 这 100 条 submissions 的 `contest_id` 被 SET NULL，提交记录自身保留

### Requirement: 竞赛相关索引

系统 SHALL 为竞赛查询性能创建以下索引：

- `idx_submissions_contest_id` — 单列索引，优化按竞赛筛选提交
- `idx_submissions_contest_problem_user` — 复合索引 `(contest_id, problem_id, user_id, created_at)`，优化竞赛排名查询
- `idx_contests_created_by` — 优化管理员查询自己创建的竞赛
- `idx_contests_start_time` / `idx_contests_end_time` — 优化按时间筛选竞赛列表
- `idx_contest_participants_user` — 优化查询用户参与的所有竞赛

#### Scenario: 竞赛排名查询使用复合索引
- **WHEN** 系统执行 ICPC 排名 SQL（按 contest_id 筛选 + problem_id/user_id 分组 + created_at 排序）
- **THEN** PostgreSQL 查询计划使用 `idx_submissions_contest_problem_user` 索引

### Requirement: 社区数据表和约束

数据库 SHALL 增加板块、板块角色授权、帖子、评论、点赞、收藏、关注、活动、举报、审核、处罚和通知表，并为所有外键和常用列表过滤建立索引。

#### Scenario: 插入无题目的题解

- **WHEN** 数据库写入 `type=solution` 且 `problem_id=NULL` 的帖子
- **THEN** CHECK 约束拒绝该记录

#### Scenario: 查询待审核内容

- **WHEN** 审核队列按 `status=pending` 与时间查询
- **THEN** PostgreSQL 可使用待审核内容部分索引

### Requirement: 用户社区偏好

用户数据 SHALL 保存系统活动可见性，默认值为 `following`，允许值为 `hidden|following|everyone`。

#### Scenario: 新用户默认偏好

- **WHEN** 创建新用户且未指定社区偏好
- **THEN** 活动可见性默认为 `following`

### Requirement: 客观题小题表（objective_questions）

系统 SHALL 提供 `objective_questions` 表存储客观题小题，每道小题 SHALL 通过外键绑定所属套卷（problems.id，is_objective=true）：

| 字段       | 类型    | 约束                                   | 说明                               |
| ---------- | ------- | -------------------------------------- | ---------------------------------- |
| id         | TEXT    | PRIMARY KEY, UUID v4                   |                                    |
| paper_id   | TEXT    | NOT NULL, FK → problems.id, CASCADE    | 所属套卷，删除套卷级联删除         |
| sort_order | INTEGER | NOT NULL                               | 卷内排序，UNIQUE(paper_id, sort_order) |
| type       | TEXT    | NOT NULL, CHECK('single','multiple','judge') | 单选 / 多选 / 判断           |
| prompt     | TEXT    | NOT NULL                               | 题干（Markdown）                   |
| options    | JSONB   | NOT NULL, DEFAULT '[]'                 | 选项数组 `[{key, text}]`，judge 型为空 |
| answer     | JSONB   | NOT NULL                               | 标准答案：`["A"]` / `["A","C"]` / `[true]` |
| explanation| TEXT    | NOT NULL, DEFAULT ''                   | 答案解析（判卷后展示）             |
| created_at | TEXT    | NOT NULL, ISO 8601                     |                                    |
| updated_at | TEXT    | NOT NULL, ISO 8601                     |                                    |

#### Scenario: 创建单选小题

- **WHEN** 向 objective_questions 插入一条 type='single'、answer=['A'] 的记录
- **THEN** 记录绑定 paper_id 指向的套卷，sort_order 在该卷内唯一

#### Scenario: 多选答案集合

- **WHEN** 插入 type='multiple'、answer=['A','C'] 的记录
- **THEN** answer 保存为 JSON 数组，判分时要求完全匹配

#### Scenario: 判断题型

- **WHEN** 插入 type='judge'、answer=[true] 的记录
- **THEN** options 可为空数组，标准答案为布尔值

#### Scenario: 删除套卷级联删除小题

- **WHEN** 删除套卷（problems 行）
- **THEN** 该卷下全部 objective_questions 记录级联删除

### Requirement: 客观题提交表（objective_submissions）

系统 SHALL 提供 `objective_submissions` 表存储客观题提交记录（服务端即时判定，无评测队列参与）：

| 字段            | 类型    | 约束                                    | 说明                               |
| --------------- | ------- | --------------------------------------- | ---------------------------------- |
| id              | TEXT    | PRIMARY KEY, UUID v4                    |                                    |
| paper_id        | TEXT    | NOT NULL, FK → problems.id, CASCADE     | 套卷                               |
| user_id         | TEXT    | NOT NULL, FK → users.id                 | 提交者                             |
| contest_id      | TEXT    | 可空, FK → contests.id, SET NULL        | 竞赛提交时非空                     |
| submission_type | TEXT    | NOT NULL, CHECK('practice','contest')   | 练习 / 竞赛模式                    |
| answers         | JSONB   | NOT NULL                                | 用户答案 `{question_id: [选项...]}` |
| status          | TEXT    | NOT NULL, DEFAULT 'finished'            | 即时判定完成                       |
| score           | INTEGER | NOT NULL, DEFAULT 0                     | 卷面分 ×100（0-10000）             |
| details         | JSONB   | NOT NULL, DEFAULT '{}'                  | 逐题判定 `{question_id: {correct, expected, given}}` |
| created_at      | TEXT    | NOT NULL, ISO 8601                      |                                    |

#### Scenario: 记录竞赛一次性提交

- **WHEN** 参赛者在竞赛中提交套卷答案
- **THEN** 记录 contest_id 与 submission_type='contest'，且 (paper_id, user_id, contest_id) 组合唯一（重复提交冲突）

#### Scenario: 练习模式多次提交

- **WHEN** 用户在练习模式下多次提交同一套卷
- **THEN** 每次提交均生成独立记录，submission_type='practice'，contest_id 为 NULL

#### Scenario: 删除套卷级联删除提交

- **WHEN** 删除套卷（problems 行）
- **THEN** 该卷下全部 objective_submissions 记录级联删除

### Requirement: users.role 与 roles.is_admin 列移除

数据库 Schema SHALL 移除 `users.role` 与 `roles.is_admin` 两列，由 Drizzle 迁移执行 `ALTER TABLE` 删列；相关读写点已在代码层全部清理（见 rbac-core / admin-authorization delta）。

#### Scenario: 迁移删列成功

- **WHEN** `deno task db:migrate` 执行删列迁移
- **THEN** `users` 表与 `roles` 表不再包含 `role` / `is_admin` 列，`roles.parent_id`（角色继承）与其余 RBAC 列保持不变

#### Scenario: 删列后系统功能不受影响

- **WHEN** 删列迁移执行后运行 `init:system` / `bootstrap:admin` / 登录 / 权限检查
- **THEN** 系统正常运行，无任何代码引用已删除列

### Requirement: 公告表（announcements）

系统 SHALL 提供 `announcements` 表：

- `id` TEXT PRIMARY KEY（uuid）
- `title` TEXT NOT NULL
- `content` TEXT NOT NULL（Markdown）
- `is_pinned` BOOLEAN NOT NULL DEFAULT FALSE
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- `created_by` TEXT NOT NULL REFERENCES `users(id)`
- `created_at` TEXT NOT NULL、`updated_at` TEXT NOT NULL（ISO 8601）

系统 SHALL 为该表创建索引 `idx_announcements_active_pinned_created` ON `(is_active, is_pinned, created_at)`。表与索引通过 Drizzle 迁移（0035）创建，迁移由 `deno task db:generate` 生成，不可手改 `_journal.json`。

#### Scenario: 迁移建表

- **WHEN** 执行 0035 迁移
- **THEN** `announcements` 表与索引创建成功

#### Scenario: 级联行为

- **WHEN** 引用 `users.id` 的 `created_by` 用户被删除
- **THEN** 按既有约束行为处理（`users` 表无级联删除，公告保留，字段为历史记录）

### Requirement: 标签表（tags）

系统 SHALL 提供 `tags` 表：`id`(TEXT, PK)、`name`(TEXT, NOT NULL, UNIQUE)、`kind`(TEXT, NOT NULL, CHECK in ('problem','algorithm'))、`created_at`(TEXT, NOT NULL)、`updated_at`(TEXT, NOT NULL)。

#### Scenario: 创建 tags 表
- **WHEN** 执行新增迁移
- **THEN** `tags` 表、name 唯一约束与 kind CHECK 约束被创建

### Requirement: 题目-标签关联表（problem_tags）

系统 SHALL 提供 `problem_tags` 表：`problem_id`(TEXT, NOT NULL, FK→problems ON DELETE CASCADE)、`tag_id`(TEXT, NOT NULL, FK→tags ON DELETE CASCADE)，复合主键 (problem_id, tag_id)。

#### Scenario: 创建 problem_tags 表
- **WHEN** 执行新增迁移
- **THEN** `problem_tags` 表、复合主键与两个级联外键被创建
- **THEN** 同一 (problem_id, tag_id) 重复插入被拒绝

### Requirement: 移除分类表

系统 SHALL 在新增迁移中删除 `categories` 与 `problems_categories` 表，并清理 `permissions`/`role_permissions` 中 `resource='category'` 的行。

#### Scenario: 分类表被移除
- **WHEN** 执行新增迁移
- **THEN** `categories`、`problems_categories` 表不存在
- **THEN** `permissions` 表中不存在 `resource='category'` 的记录

