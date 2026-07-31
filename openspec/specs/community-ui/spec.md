## Purpose

定义社区前端（noj-ui）的交互规范，包括社区导航与首页、帖子筛选、内容查看与编辑、个人收藏页面、题目页题解入口、社区管理后台，以及 Markdown 外链图片的安全渲染。

## Requirements

### Requirement: 社区导航和首页

前端 SHALL 根据能力矩阵显示社区导航，并在 `/community` 提供讨论、动态和题解标签。

#### Scenario: 动态模块关闭

- **WHEN** 配置返回动态模块关闭
- **THEN** 社区首页不显示动态标签，直接访问动态视图显示功能已关闭

### Requirement: 社区帖子筛选

前端 SHALL 在社区首页提供关联题目 ID 与标题或正文关键词筛选，并提供清除筛选操作。

#### Scenario: 搜索帖子

- **WHEN** 用户提交关键词或关联题目 ID
- **THEN** 页面更新为仅展示匹配当前内容类型的帖子

### Requirement: 社区内容查看和编辑

前端 SHALL 提供社区内容列表、详情、Markdown 编辑、评论、点赞、收藏、关注和举报操作，并明确展示 pending、锁定和隐藏状态。

#### Scenario: 新用户内容待审核

- **WHEN** 创建接口返回 `pending`
- **THEN** 前端提示"内容已提交审核"，并在作者视图显示审核中状态

#### Scenario: 已收藏帖子详情

- **WHEN** 用户打开自己已收藏的帖子详情
- **THEN** 收藏按钮显示"已收藏"状态，并可再次点击取消收藏

### Requirement: 个人收藏页面

前端 SHALL 为已登录用户提供 `/community/bookmarks` 页面与社区首页入口，以展示自己的可见收藏内容、作者、收藏时间和互动摘要。

#### Scenario: 没有可见收藏

- **WHEN** 用户尚未收藏内容，或其收藏内容均已隐藏或删除
- **THEN** 页面显示空状态，并提供返回社区的入口

### Requirement: 题目页题解入口

题目详情页 SHALL 展示题解列表和发布入口，发布入口 MUST 服从题解模块和当前用户权限。

#### Scenario: 未通过用户受门槛限制

- **WHEN** 配置要求 Accepted 且当前用户没有发布权限
- **THEN** 前端禁用发布入口并说明原因

### Requirement: 社区管理后台

管理后台 SHALL 提供配置预设、独立开关、板块、待审内容、举报和处罚管理页面。

#### Scenario: 审核帖子

- **WHEN** 管理员在审核队列批准内容
- **THEN** 列表即时更新并显示操作成功

### Requirement: 安全渲染外链图片

Markdown 渲染 SHALL 仅允许 HTTPS 图片；启用外链图片时添加懒加载与 no-referrer，关闭时显示为链接。

#### Scenario: 危险图片协议

- **WHEN** Markdown 图片使用非 HTTPS 或脚本协议
- **THEN** 渲染结果不包含可加载的图片节点
