## ADDED Requirements

### Requirement: 社区数据表和约束
数据库 SHALL 增加板块、板块角色授权、帖子、评论、点赞、收藏、关注、活动、举报、审核、处罚和通知表，并为所有外键和常用列表过滤建立索引。

#### Scenario: 插入无题目的题解
- **WHEN** 数据库写入 `type=solution` 且 `problem_id=NULL` 的帖子
- **THEN** CHECK 约束拒绝该记录

#### Scenario: 查询待审核内容
- **WHEN** 审核队列按 `status=pending` 与时间查询
- **THEN** PostgreSQL 可使用待审核内容部分索引

### Requirement: 用户社区偏好
用户数据 SHALL 保存系统活动可见性，默认值为 `following`，允许值为 `hidden|following|everyone`。

#### Scenario: 新用户默认偏好
- **WHEN** 创建新用户且未指定社区偏好
- **THEN** 活动可见性默认为 `following`
