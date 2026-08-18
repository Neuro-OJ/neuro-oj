## ADDED Requirements

### Requirement: 自测表（self_tests）

系统 SHALL 提供 `self_tests` 表存储用户自测记录，与正式 `submissions` / `evaluationResults` 完全隔离。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 格式 `st_<uuid>` |
| user_id | TEXT | NOT NULL, FK → users.id | 发起自测的用户 |
| problem_id | TEXT | NOT NULL, FK → problems.id | 自测题目 |
| language | TEXT | NOT NULL | 编程语言标识 |
| code | TEXT | NOT NULL | 源代码 |
| file_name | TEXT | NULL | 用户文件名 |
| status | TEXT | NOT NULL, DEFAULT 'pending' | pending / judging / finished / error |
| result_status | TEXT | NULL | 评测结果状态（如 Accepted / WrongAnswer），未完成时为 NULL |
| score | INTEGER | NOT NULL, DEFAULT 0 | 得分 ×100 |
| output | TEXT | NOT NULL, DEFAULT '' | 评测输出 |
| details | TEXT | NOT NULL, DEFAULT '{}' | JSON 详情 |
| time_ms | INTEGER | NULL | 耗时（毫秒） |
| memory_kb | INTEGER | NULL | 内存（KB） |
| judge_started_at | TEXT | NULL | 开始评测时间 |
| judge_finished_at | TEXT | NULL | 完成评测时间 |
| created_at | TEXT | NOT NULL | ISO 8601 |

系统 SHOULD 长期保留 `self_tests` 数据，不参与正式统计/榜单计算。

#### Scenario: 创建自测记录

- **WHEN** 用户发起自测
- **THEN** `self_tests` 表新增一行，`id` 以 `st_` 开头，`status` 为 `pending`，`score` 为 0

#### Scenario: 自测结果写回

- **WHEN** 自测评测完成
- **THEN** `self_tests` 行更新为 `finished`/`error`，并写入分数、输出、详情与完成时间

#### Scenario: 自测不影响正式表

- **WHEN** 自测记录写入或更新
- **THEN** `submissions` 与 `evaluationResults` 表不发生任何变化
