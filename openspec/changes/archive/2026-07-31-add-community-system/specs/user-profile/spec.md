## ADDED Requirements

### Requirement: 用户主页包含社区摘要
`GET /api/v1/users/:id/profile` SHALL 增加关注数、粉丝数、已发布题解和已发布动态摘要，且 MUST NOT 返回隐藏系统活动。

#### Scenario: 查看用户社区摘要
- **WHEN** 访问存在用户的公开主页
- **THEN** 响应包含 `community_stats`、`solutions` 和 `moments`，并仅统计可见内容

### Requirement: 用户可设置活动可见性
登录用户 SHALL 能将自己的系统活动可见性设置为 `hidden|following|everyone`。

#### Scenario: 设置非法可见性
- **WHEN** 用户提交不在允许集合内的值
- **THEN** 系统返回 400 且保留原设置
