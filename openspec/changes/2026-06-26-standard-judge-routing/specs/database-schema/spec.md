## Purpose

数据库 schema 增量更新：problems 表新增 `judge_type` 字段及 CHECK 约束，
支持区分标准题（stdout diff）与 SPJ 题（自定义 evaluate.py）。

## MODIFIED Requirements

### Requirement: 题目表（problems）

系统 SHALL 在 problems 表中增加 `judge_type` 字段：

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| judge_type | TEXT | NOT NULL, DEFAULT 'special', CHECK IN('standard','special') | 评测类型 |

#### Scenario: 创建题目时默认 judge_type

- **WHEN** 插入 problems 记录且未指定 `judge_type`
- **THEN** 数据库使用默认值 `'special'`（保持现有 SPJ 路径行为）

#### Scenario: 创建标准题

- **WHEN** 插入 problems 记录并指定 `judge_type='standard'`
- **THEN** 数据库接受该值，noj-judge 走 Rust 原生执行器

#### Scenario: judge_type 约束检查

- **WHEN** 尝试插入 `judge_type='invalid'`
- **THEN** 数据库返回 CHECK 约束违反错误

#### Scenario: 已有样例题 1003 标记为 standard

- **WHEN** 执行迁移 0006
- **THEN** `UPDATE problems SET judge_type='standard' WHERE id='1003'` 自动执行

### Requirement: 数据库迁移自动执行

系统 SHALL 在启动时自动执行 migration 0006，添加 `judge_type` 列、CHECK 约束、并将 problem 1003 标记为 standard。

#### Scenario: 首次执行 0006

- **WHEN** noj-core 启动且 migration 0006 未执行
- **THEN** 系统按顺序：
  1. `ALTER TABLE problems ADD COLUMN judge_type text NOT NULL DEFAULT 'special'`
  2. `ALTER TABLE problems ADD CONSTRAINT problems_judge_type_check CHECK (judge_type IN ('standard','special'))`
  3. `UPDATE problems SET judge_type='standard' WHERE id='1003'`