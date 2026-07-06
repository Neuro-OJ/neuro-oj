## Added Requirements

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
