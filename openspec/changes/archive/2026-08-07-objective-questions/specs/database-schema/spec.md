## MODIFIED Requirements

### Requirement: 题目表（problems）

系统 SHALL 提供 `problems` 表存储题目信息。编程题（U/P 型）支持自定义评测环境配置；客观题套卷（O 型）无评测环境（`runtime_config` 可空）：

| 字段                 | 类型    | 约束                                 | 说明                           |
| -------------------- | ------- | ------------------------------------ | ------------------------------ |
| id                   | TEXT    | PRIMARY KEY, UUID v4                 |                                |
| title                | TEXT    | NOT NULL                             | 题目标题 / 套卷标题            |
| description          | TEXT    | NOT NULL                             | 题目描述（Markdown）           |
| difficulty           | TEXT    | NOT NULL, DEFAULT 'medium'           | easy / medium / hard           |
| runtime_config       | JSONB   | 可空（U/P 型必填）                    | 双容器评测配置；O 型为 NULL    |
| support_package_storage_url | TEXT | 可空                               | 支持包存储 URL（仅 U/P 型使用）|
| number               | INTEGER | NOT NULL, UNIQUE(type, number)       | 题号（同一 type 内独立自增）   |
| owner_id             | TEXT    | NOT NULL, DEFAULT '0', FK → users.id | 题目所有者 ID，默认 root       |
| type                 | TEXT    | NOT NULL, DEFAULT 'U', CHECK('U','P','O') | 题目类型：U=用户题, P=管理题, O=客观题套卷 |
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

#### Scenario: 插入 O 型套卷

- **WHEN** 向 problems 表插入一条 type='O'、runtime_config=NULL 的记录
- **THEN** 允许插入，number 在 O 型范围内独立自增

#### Scenario: type + number 组合唯一约束

- **WHEN** 尝试插入 type='U', number=1 且已存在同 type+number 的记录
- **THEN** 数据库返回 UNIQUE 约束冲突错误

#### Scenario: 非法 type 被拒

- **WHEN** 尝试插入 type='X' 的记录
- **THEN** 数据库 CHECK 约束拒绝插入

## ADDED Requirements

### Requirement: 客观题小题表（objective_questions）

系统 SHALL 提供 `objective_questions` 表存储客观题小题，每道小题 SHALL 通过外键绑定所属套卷（problems.id，type='O'）：

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
