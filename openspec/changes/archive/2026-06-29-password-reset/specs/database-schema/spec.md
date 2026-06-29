## Purpose

数据库 schema 增量更新：新增 `password_reset_tokens` 表用于密码重置流程的令牌管理。
所有时间戳使用 ISO 8601 文本格式存储（与项目其他表一致）。

## ADDED Requirements

### Requirement: 密码重置令牌表（password_reset_tokens）

系统 SHALL 提供 `password_reset_tokens` 表存储密码重置令牌，包含以下字段：

| 字段          | 类型     | 约束                                              | 说明                                |
| ------------- | -------- | ------------------------------------------------- | ----------------------------------- |
| id            | TEXT     | PRIMARY KEY, UUID v4                              | 令牌记录主键                        |
| user_id       | TEXT     | NOT NULL, FK → users.id ON DELETE CASCADE         | 关联用户                            |
| token_hash    | TEXT     | NOT NULL, UNIQUE                                  | 令牌 SHA-256 hex 哈希（不存明文）   |
| expires_at    | TEXT     | NOT NULL, ISO 8601                                | 过期时间，now + 15 分钟              |
| used_at       | TEXT     | NULL, ISO 8601                                    | 使用时间（NULL = 未使用）           |
| created_at    | TEXT     | NOT NULL, ISO 8601                                | 创建时间                            |

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
