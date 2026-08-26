## ADDED Requirements

### Requirement: contests.public_id 列

系统 SHALL 在 `contests` 表新增 `public_id` 文本列，唯一且非空，用于存储竞赛公开标识（`ct-` 前缀短码）。

#### Scenario: 创建竞赛生成 public_id

- **WHEN** 创建竞赛
- **THEN** 系统生成 `ct-` 前缀 8 位随机短码并写入 `contests.public_id`

#### Scenario: public_id 唯一

- **WHEN** 尝试插入重复 `contests.public_id`
- **THEN** 数据库唯一索引拒绝该插入

### Requirement: trainings.public_id 列

系统 SHALL 在 `trainings` 表新增不可变 `public_id` 唯一非空列（`tr-` 前缀短码）。

#### Scenario: 创建训练生成 public_id

- **WHEN** 创建训练
- **THEN** 系统生成 `tr-` 前缀 8 位短码并写入 `trainings.public_id`

### Requirement: submissions.public_id 列

系统 SHALL 在 `submissions` 表新增不可变 `public_id` 唯一非空列（`sub-` 前缀短码）。

#### Scenario: 创建提交生成 public_id

- **WHEN** 创建提交
- **THEN** 系统生成 `sub-` 前缀 8 位短码并写入 `submissions.public_id`

### Requirement: community_posts.public_id 列

系统 SHALL 在 `community_posts` 表新增不可变 `public_id` 唯一非空列（`post-` 前缀短码）。

#### Scenario: 创建帖子生成 public_id

- **WHEN** 创建社区帖子
- **THEN** 系统生成 `post-` 前缀 8 位短码并写入 `community_posts.public_id`

### Requirement: announcements.public_id 列

系统 SHALL 在 `announcements` 表新增不可变 `public_id` 唯一非空列（`ann-` 前缀短码）。

#### Scenario: 创建公告生成 public_id

- **WHEN** 创建公告
- **THEN** 系统生成 `ann-` 前缀 8 位短码并写入 `announcements.public_id`
