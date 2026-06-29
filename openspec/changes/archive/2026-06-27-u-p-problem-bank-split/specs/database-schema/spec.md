## Purpose

数据库 schema 增量更新：problems 表新增 owner_id、type、number 字段及组合唯一约束。

## MODIFIED Requirements

### Requirement: 题目表（problems）

系统 SHALL 在 problems 表中增加以下字段：

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| owner_id | TEXT | NOT NULL, DEFAULT '0', FK → users.id | 题目所有者 ID |
| type | TEXT | NOT NULL, DEFAULT 'U', CHECK IN('U','P') | 题目类型：U=用户题, P=管理题 |
| number | INTEGER | NOT NULL, UNIQUE(type, number) | 类型内独立题号 |

#### Scenario: 插入 U 型题目
- **WHEN** 向 problems 表插入一条 type='U' 的记录
- **THEN** owner_id 默认为 '0'（root），number 须在 U 型范围内唯一

#### Scenario: 插入 P 型题目
- **WHEN** 向 problems 表插入一条 type='P' 的记录
- **THEN** 允许与 U 型题目有相同的 number 值（不同 type 独立编号）

#### Scenario: type + number 组合唯一约束
- **WHEN** 尝试插入 type='U', number=1 且已存在同 type+number 的记录
- **THEN** 数据库返回 UNIQUE 约束冲突错误

### Requirement: 数据库迁移自动执行

系统 SHALL 在启动时自动执行 migration 0004，按顺序添加字段和约束。

#### Scenario: 首次执行 0004
- **WHEN** noj-core 启动且 migration 0004 未执行
- **THEN** 系统执行 ALTER TABLE 添加 owner_id、type、number，创建 CHECK 和 UNIQUE 约束，迁移已有数据
