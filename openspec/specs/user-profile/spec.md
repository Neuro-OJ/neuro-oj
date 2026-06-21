## Purpose

定义 Neuro OJ 用户主页 API
规范，提供用户公开主页的聚合数据展示，包括统计信息、已通过题目列表和最近提交活动。API
路径前缀为 `/api/v1/users`，公开可访问，无需认证。

## Requirements

### Requirement: 用户可查看任意用户主页

系统 SHALL 提供 `GET /api/v1/users/:id/profile`
端点，返回指定用户的公开主页信息。

此端点 SHALL 无需认证，公开可访问。

响应格式：

```json
{
  "user": {
    "id": "uuid",
    "username": "hachimi",
    "created_at": "2026-01-01T00:00:00Z"
  },
  "stats": {
    "total_submissions": 42,
    "accepted": 30,
    "acceptance_rate": 0.714,
    "solved_count": 15
  },
  "solved_problems": [
    {
      "id": "1001",
      "title": "两数之和",
      "difficulty": "easy",
      "accepted_at": "2026-06-01T12:00:00Z"
    }
  ],
  "recent_submissions": [
    {
      "id": "uuid",
      "problem_id": "1001",
      "problem_title": "两数之和",
      "language": "python3",
      "status": "finished",
      "result_status": "Accepted",
      "score": 100,
      "created_at": "2026-06-20T10:00:00Z"
    }
  ]
}
```

#### Scenario: 查看存在的用户主页

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，其中 `:id` 为存在的用户 ID
- **THEN** 系统返回 200，包含
  `user`、`stats`、`solved_problems`、`recent_submissions` 四个字段

#### Scenario: 查看不存在的用户

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，其中 `:id` 为不存在的用户 ID
- **THEN** 系统返回 404，错误消息为 "用户不存在"

#### Scenario: 用户无任何提交

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户无任何提交记录
- **THEN** 系统返回 200，`stats.total_submissions` 为 0，`stats.accepted` 为
  0，`stats.acceptance_rate` 为 0，`solved_problems`
  为空数组，`recent_submissions` 为空数组

#### Scenario: 统计信息正确聚合

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户有 10 条提交，其中 5
  条评测结果为 Accepted（涉及 3 道不同题目）
- **THEN** 系统返回 200，`stats.total_submissions` 为 10，`stats.accepted` 为
  5，`stats.solved_count` 为 3，`stats.acceptance_rate` 为 0.5

#### Scenario: 已通过题目列表去重

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户对同一题目有多次
  Accepted 提交
- **THEN** 系统返回的 `solved_problems` 中该题目只出现一次，`accepted_at`
  为首次通过时间

#### Scenario: 最近提交不包含 code 字段

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`
- **THEN** 系统返回的 `recent_submissions` 中每条记录不包含 `code` 字段

#### Scenario: 最近提交按 created_at 降序排列

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户有超过 10 条提交
- **THEN** 系统返回的 `recent_submissions` 最多包含 10 条记录，按 `created_at`
  降序排列
