## MODIFIED Requirements

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
    "bio": "## 关于我\n\n热爱算法竞赛",
    "avatar_url": "noj-storage://local/<hash>.png?checksum_sha256=<hex>",
    "created_at": "2026-01-01T00:00:00Z"
  },
  "stats": {
    "total_submissions": 42,
    "accepted": 30,
    "acceptance_rate": 0.714,
    "solved_count": 15
  }
}
```

- `user.avatar_url`：用户头像存储 URL（`noj-storage://` 格式），未设置时为 `null`（新增字段）
