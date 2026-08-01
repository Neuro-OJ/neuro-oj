## ADDED Requirements

### Requirement: 统一创建社区内容
系统 SHALL 允许具备对应权限的登录用户创建题解、讨论和短动态，并按内容类型校验上下文与长度。

#### Scenario: 创建题解
- **WHEN** 用户创建 `solution` 且提供有效 `problem_id`、标题和 Markdown 内容
- **THEN** 系统创建题解；启用通过门槛时还 MUST 验证作者已 Accepted 或具备管理权限

#### Scenario: 创建讨论
- **WHEN** 用户在可发帖板块创建 `discussion`
- **THEN** 系统创建带标题的讨论主题

#### Scenario: 创建短动态
- **WHEN** 用户创建不含标题的 `moment`
- **THEN** 系统创建短动态且 MUST NOT 要求板块或题目

### Requirement: 社区内容列表和详情
系统 SHALL 提供按类型、板块、关联题目、作者、标题或正文关键词和状态筛选的游标分页列表，以及单条内容详情。

#### Scenario: 游客读取已发布内容
- **WHEN** 游客在允许游客阅读且对应模块开启时请求列表或详情
- **THEN** 系统仅返回 `published` 内容

#### Scenario: 登录用户查看帖子详情
- **WHEN** 登录用户请求一篇已发布帖子的详情
- **THEN** 响应包含该用户对此帖的 `bookmarked` 状态

#### Scenario: 按标题或正文筛选帖子
- **WHEN** 用户提供标题或正文关键词请求帖子列表
- **THEN** 系统仅返回标题或正文包含该关键词的可见帖子

### Requirement: 评论与一级回复
系统 SHALL 允许登录用户评论已发布且未锁定的内容，并仅支持回复根评论。

#### Scenario: 回复二级评论
- **WHEN** 用户尝试以已有回复作为 `parent_id`
- **THEN** 系统返回 400，且不创建三级回复

### Requirement: 点赞与收藏幂等
系统 SHALL 对帖子点赞、评论点赞和帖子收藏提供幂等切换接口，并保证同一用户与目标仅有一条关系。

#### Scenario: 重复点赞
- **WHEN** 用户重复请求点赞同一帖子
- **THEN** 系统返回当前已点赞状态且数据库不存在重复记录

### Requirement: 个人收藏列表
系统 SHALL 允许已登录用户按收藏时间倒序、以游标分页读取自己的收藏帖子。列表 MUST 仅返回仍处于 `published` 状态的内容。

#### Scenario: 收藏内容被隐藏或删除
- **WHEN** 用户已收藏的帖子被隐藏或软删除
- **THEN** 该帖子不再出现在用户的个人收藏列表中，且其他用户的收藏记录不得返回

### Requirement: 内容编辑和软删除
作者 SHALL 能编辑或软删除自己的内容；审核员 SHALL 能管理任意内容。已删除内容不得出现在普通列表和搜索中。

#### Scenario: 作者删除帖子
- **WHEN** 作者删除自己的帖子
- **THEN** 状态更新为 `deleted`，原始记录及审核证据保留
