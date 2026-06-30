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
| role          | TEXT | NOT NULL, DEFAULT 'user' |
| must_change_password | BOOLEAN | NOT NULL, DEFAULT false |
| bio           | TEXT | DEFAULT ''               |
| created_at    | TEXT | NOT NULL, ISO 8601       |
| updated_at    | TEXT | NOT NULL, ISO 8601       |

> `bio` 字段存储用户个人简介（Markdown 格式），默认为空字符串。

#### Scenario: 插入新用户

- **WHEN** 向 `users` 表插入一条包含 username、email、password_hash 的记录
- **THEN** 系统自动生成 UUID 主键，role 默认为 'user'，bio 默认为 ''，created_at 和 updated_at
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

系统 SHALL 提供 `problems` 表存储 LMCC 题目信息，支持自定义评测环境配置：

| 字段                 | 类型    | 约束                                 | 说明                           |
| -------------------- | ------- | ------------------------------------ | ------------------------------ |
| id                   | TEXT    | PRIMARY KEY, UUID v4                 |                                |
| title                | TEXT    | NOT NULL                             | 题目标题                       |
| description          | TEXT    | NOT NULL                             | 题目描述（Markdown）           |
| difficulty           | TEXT    | NOT NULL, DEFAULT 'medium'           | easy / medium / hard           |
| judge_image          | TEXT    | NOT NULL                             | Docker 镜像名                  |
| judge_command        | TEXT    | NOT NULL                             | 容器内评测命令                 |
| support_package_path | TEXT    |                                      | 支持包 zip 路径，相对 CWD      |
| time_limit_ms        | INTEGER | NOT NULL, DEFAULT 5000               | 时间限制（毫秒）               |
| memory_limit_mb      | INTEGER | NOT NULL, DEFAULT 512                | 内存限制（MB）                 |
| number               | INTEGER | NOT NULL, UNIQUE(type, number)       | 题号（同一 type 内独立自增）   |
| owner_id             | TEXT    | NOT NULL, DEFAULT '0', FK → users.id | 题目所有者 ID，默认 root       |
| type                 | TEXT    | NOT NULL, DEFAULT 'U', CHECK('U','P')| 题目类型：U=用户题, P=管理题   |
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

#### Scenario: type + number 组合唯一约束

- **WHEN** 尝试插入 type='U', number=1 且已存在同 type+number 的记录
- **THEN** 数据库返回 UNIQUE 约束冲突错误

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
- **THEN** 数据库 UNIQUE 约束拒绝，服务层返回 409 CONFLICT_ERROR

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
