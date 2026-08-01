## ADDED Requirements

### Requirement: 新用户内容预审
系统 SHALL 根据配置的账号年龄窗口将新用户内容置为 `pending`，并允许作者和审核员读取。

#### Scenario: 预审内容发布
- **WHEN** 审核员批准待审核内容
- **THEN** 内容状态变为 `published`，作者收到审核通知

### Requirement: 用户举报内容
登录用户 SHALL 能举报帖子或评论，举报记录 MUST 保存目标内容快照并拒绝同一用户对同一目标的重复待处理举报。

#### Scenario: 举报已删除内容
- **WHEN** 用户举报已删除或不存在的目标
- **THEN** 系统返回 404 且不创建举报

### Requirement: 审核处置
具备审核权限的用户 SHALL 能批准、隐藏、恢复、锁定、置顶内容并处理举报，所有操作 MUST 写入审计日志。

#### Scenario: 隐藏被举报帖子
- **WHEN** 审核员隐藏帖子并填写原因
- **THEN** 普通用户不可见该帖子，相关举报标记为已处理

### Requirement: 社区处罚
审核员 SHALL 能对用户施加有期限或永久的社区禁言，禁言仅阻止社区写操作，不影响登录、做题和提交。

#### Scenario: 禁言用户发布内容
- **WHEN** 处于有效社区禁言的用户尝试发帖、评论或互动
- **THEN** 系统返回 `COMMUNITY_SANCTIONED` 403，并包含原因与截止时间

### Requirement: 社区通知
系统 SHALL 持久化回复、点赞、关注和审核结果通知，提供未读计数和标记已读接口，并通过 SSE 发布 `notification:new`。

#### Scenario: 回复触发通知
- **WHEN** 用户回复另一用户的帖子或评论
- **THEN** 被回复用户收到通知记录和实时事件，回复自己不产生通知
