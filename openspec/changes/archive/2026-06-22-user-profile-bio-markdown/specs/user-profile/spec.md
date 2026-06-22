## MODIFIED Requirements

### Requirement: 用户可查看任意用户主页

系统 SHALL 提供 `GET /api/v1/users/:id/profile` 端点，返回指定用户的公开主页信息。

此端点 SHALL 无需认证，公开可访问。

响应格式：

```json
{
  "user": {
    "id": "uuid",
    "username": "hachimi",
    "bio": "## 关于我\n\n热爱算法竞赛",
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

#### Scenario: 查看存在的用户主页（含 bio）

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，其中 `:id` 为存在的用户 ID，该用户已设置 bio
- **THEN** 系统返回 200，`user` 对象包含 `bio` 字段，值为用户设置的 Markdown 文本

#### Scenario: 查看未设置 bio 的用户主页

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户未设置 bio
- **THEN** 系统返回 200，`user.bio` 字段为空字符串 `""`

#### Scenario: 查看不存在的用户

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，其中 `:id` 为不存在的用户 ID
- **THEN** 系统返回 404，错误消息为 "用户不存在"

#### Scenario: 用户无任何提交

- **WHEN** 客户端 GET `/api/v1/users/:id/profile`，该用户无任何提交记录
- **THEN** 系统返回 200，`stats.total_submissions` 为 0，`stats.accepted` 为 0，`stats.acceptance_rate` 为 0，`solved_problems` 为空数组，`recent_submissions` 为空数组
