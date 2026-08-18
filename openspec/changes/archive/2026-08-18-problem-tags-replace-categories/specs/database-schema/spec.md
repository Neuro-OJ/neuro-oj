## MODIFIED Requirements

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

系统 SHALL 预置 22 个权限定义，覆盖 problem、submission、user、tag、system 五个资源域。

#### Scenario: 插入权限定义
- **WHEN** seed 脚本插入 `resource='problem'`, `action='create'`, `description='创建题目'`
- **THEN** 系统在 permissions 表中创建对应记录

#### Scenario: 资源+操作唯一约束
- **WHEN** 尝试插入与已存在记录相同的 (resource, action) 组合
- **THEN** 数据库返回 UNIQUE 约束冲突

## ADDED Requirements

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
