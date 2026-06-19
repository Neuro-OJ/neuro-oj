## ADDED Requirements

### Requirement: 用户表（users）

系统 SHALL 提供 `users` 表存储用户信息，包含以下字段：

| 字段          | 类型 | 约束                     |
| ------------- | ---- | ------------------------ |
| id            | TEXT | PRIMARY KEY, UUID v4     |
| username      | TEXT | NOT NULL, UNIQUE         |
| email         | TEXT | NOT NULL, UNIQUE         |
| password_hash | TEXT | NOT NULL                 |
| role          | TEXT | NOT NULL, DEFAULT 'user' |
| created_at    | TEXT | NOT NULL, ISO 8601 格式  |
| updated_at    | TEXT | NOT NULL, ISO 8601 格式  |

#### Scenario: 插入新用户

- **WHEN** 向 `users` 表插入一条包含 username、email、password_hash 的记录
- **THEN** 系统自动生成 UUID 主键，role 默认为 'user'，created_at 和 updated_at
  自动填充当前 ISO 8601 时间戳

#### Scenario: 用户名唯一约束

- **WHEN** 尝试插入与已存在记录相同 username 的行
- **THEN** 数据库返回 UNIQUE 约束冲突错误

### Requirement: 题目表（problems）

系统 SHALL 提供 `problems` 表存储 LMCC 题目信息，支持自定义评测环境配置：

| 字段                 | 类型    | 约束                       | 说明                      |
| -------------------- | ------- | -------------------------- | ------------------------- |
| id                   | TEXT    | PRIMARY KEY, UUID v4       |                           |
| title                | TEXT    | NOT NULL                   | 题目标题                  |
| description          | TEXT    | NOT NULL                   | 题目描述（Markdown）      |
| difficulty           | TEXT    | NOT NULL, DEFAULT 'medium' | easy / medium / hard      |
| judge_image          | TEXT    | NOT NULL                   | Docker 镜像名             |
| judge_command        | TEXT    | NOT NULL                   | 容器内评测命令            |
| support_package_path | TEXT    |                            | 支持包 zip 路径，相对 CWD |
| time_limit_ms        | INTEGER | NOT NULL, DEFAULT 5000     | 时间限制                  |
| memory_limit_mb      | INTEGER | NOT NULL, DEFAULT 512      | 内存限制                  |
| created_at           | TEXT    | NOT NULL, ISO 8601         |                           |
| updated_at           | TEXT    | NOT NULL, ISO 8601         |                           |

> **注意**：不包含 `test_cases` 列。测试用例由支持包 zip 内的评测脚本管理。

#### Scenario: 创建 LMCC 题目

- **WHEN** 插入一道题目，指定 judge_image 为 `python:3.12-slim`，judge_command
  为 `python3 /workspace/evaluate.py`
- **THEN** 题目记录包含完整的评测环境配置，support_package_path
  可为空（待后续上传），值应为相对 CWD 的路径

#### Scenario: 题目默认资源限制

- **WHEN** 创建题目未指定 time_limit_ms 和 memory_limit_mb
- **THEN** 系统默认设置 time_limit_ms=5000, memory_limit_mb=512

### Requirement: 提交表（submissions）

系统 SHALL 提供 `submissions` 表存储用户代码提交：

| 字段       | 类型 | 约束                        | 说明                         |
| ---------- | ---- | --------------------------- | ---------------------------- |
| id         | TEXT | PRIMARY KEY, UUID v4        |                              |
| user_id    | TEXT | NOT NULL, FK → users.id     |                              |
| problem_id | TEXT | NOT NULL, FK → problems.id  |                              |
| language   | TEXT | NOT NULL                    | 编程语言标识                 |
| code       | TEXT | NOT NULL                    | 源代码                       |
| file_name  | TEXT |                             | 文件名                       |
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

| 字段          | 类型    | 约束                          | 说明                    |
| ------------- | ------- | ----------------------------- | ----------------------- |
| id            | TEXT    | PRIMARY KEY, UUID v4          |                         |
| submission_id | TEXT    | NOT NULL, FK → submissions.id | 1:1（通过唯一索引保证） |
| status        | TEXT    | NOT NULL                      | 评测状态                |
| score         | INTEGER | NOT NULL, DEFAULT 0           | 得分 ×100               |
| output        | TEXT    | NOT NULL, DEFAULT ''          | 评测命令原始输出        |
| details       | TEXT    | NOT NULL, DEFAULT '{}'        | JSON 详情               |
| time_ms       | INTEGER |                               | 耗时(ms)                |
| memory_kb     | INTEGER |                               | 内存(KB)                |
| created_at    | TEXT    | NOT NULL, ISO 8601            |                         |

#### Scenario: 存储评测结果

- **WHEN** 评测返回 status='Accepted', score=100（存储值 10000）
- **THEN** 系统将完整结果存入 evaluation_results，submission_id 唯一

#### Scenario: 分数精度

- **WHEN** 评测返回 score=99.5
- **THEN** 系统将 99.5 × 100 = 9950 存储为 INTEGER，API 读取时除以 100 还原

### Requirement: 数据库迁移自动执行

系统 SHALL 在启动时自动执行数据库迁移，确保 schema 与代码一致。

#### Scenario: 首次启动

- **WHEN** noj-core 启动且成功连接到 PostgreSQL（通过 `DATABASE_URL` 环境变量）
- **THEN** 系统在数据库中自动执行所有待执行的 migration，按顺序创建 4 张表

#### Scenario: 已有数据库启动

- **WHEN** noj-core 启动且数据库中所有 migration 已执行
- **THEN** 系统跳过迁移，正常启动

### Requirement: 健康检查包含数据库状态

系统 SHALL 在 `/health` 端点返回数据库连接状态。

#### Scenario: 数据库正常

- **WHEN** GET `/health` 且数据库连接正常
- **THEN** 响应 JSON 包含 `"database": "ok"`

#### Scenario: 数据库异常

- **WHEN** GET `/health` 且数据库连接异常
- **THEN** 响应 JSON 包含 `"database": "error"` 及错误信息
