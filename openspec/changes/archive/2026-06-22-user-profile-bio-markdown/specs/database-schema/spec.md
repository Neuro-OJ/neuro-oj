## MODIFIED Requirements

### Requirement: 用户表（users）

系统 SHALL 提供 `users` 表存储用户信息，包含以下字段：

| 字段          | 类型 | 约束                     |
| ------------- | ---- | ------------------------ |
| id            | TEXT | PRIMARY KEY, UUID v4     |
| username      | TEXT | NOT NULL, UNIQUE         |
| email         | TEXT | NOT NULL, UNIQUE         |
| password_hash | TEXT | NOT NULL                 |
| role          | TEXT | NOT NULL, DEFAULT 'user' |
| bio           | TEXT | DEFAULT ''               |
| created_at    | TEXT | NOT NULL, ISO 8601       |
| updated_at    | TEXT | NOT NULL, ISO 8601       |

> `bio` 字段存储用户个人简介（Markdown 格式），默认为空字符串。

#### Scenario: 插入新用户

- **WHEN** 向 `users` 表插入一条包含 username、email、password_hash 的记录
- **THEN** 系统自动生成 UUID 主键，role 默认为 'user'，bio 默认为 ''，created_at 和 updated_at 自动填充当前 ISO 8601 时间戳

#### Scenario: 用户设置 bio

- **WHEN** 更新用户的 bio 字段为 `"## 关于我\n\n热爱算法竞赛"` 
- **THEN** 数据库中该用户的 bio 字段存储对应的 Markdown 文本

#### Scenario: bio 可为空

- **WHEN** 查询未设置 bio 的用户
- **THEN** 返回的 bio 字段为空字符串 `""`
