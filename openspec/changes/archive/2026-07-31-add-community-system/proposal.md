## Why

Neuro OJ 已具备题目、竞赛、用户主页、私信、SSE、RBAC 与审计能力，但缺少围绕学习内容的公开交流和知识沉淀。社区功能需要同时服务公开 OJ 与学校、企业等私域部署，因此必须以可关闭、可限权、可审核为前提提供题解、讨论和用户动态。

## What Changes

- 增加统一社区内容模型，支持题解、讨论主题、用户短动态、Markdown、一级回复、点赞、收藏和软删除。
- 增加板块、关注关系、系统活动流和按时间排序的“关注 / 最新”动态流。
- 增加通知、举报、审核操作和独立于全站封禁的社区处罚流程。
- 增加社区 RBAC 权限和管理员后台配置，支持公开社区、私域社区、只读知识库预设。
- 在题目页、用户主页、全局搜索和导航中接入社区入口。
- 外链图片仅允许 HTTPS，并支持管理员动态关闭；首版不提供图片或附件上传。

## Capabilities

### New Capabilities

- `community-content`: 题解、讨论、短动态、板块、评论、点赞、收藏及内容状态。
- `community-social-feed`: 用户关注、系统活动、关注流与最新动态流。
- `community-moderation`: 举报、审核队列、内容处置、社区处罚与通知。
- `community-configuration`: 社区功能开关、访问策略、发布策略、预审规则和配置预设。
- `community-ui`: 社区首页、内容详情与编辑、通知中心、题目题解和管理后台界面。

### Modified Capabilities

- `database-schema`: 增加社区内容、互动、治理、通知及用户社区偏好相关表与索引。
- `user-profile`: 用户主页增加关注统计、题解、动态和系统活动可见性。
- `global-search`: 搜索结果增加已发布的题解和讨论主题，动态不进入搜索。
- `private-messaging`: 私信功能增加管理员动态开关，并保持原有会话数据不变。

## Impact

- `noj-core` 新增 Drizzle 表、迁移、社区服务、Hono 路由、RBAC 权限、设置项、SSE 事件和审计动作。
- `noj-ui` 新增社区页面、可复用内容组件、管理页面，并修改题目页、用户主页、导航、搜索和 Markdown 渲染。
- `noj-tests` 与 `noj-core/tests` 增加内容权限、配置、治理、动态流和安全测试。
- 不新增运行时依赖，不改变 JudgeTask、评测队列或 noj-judge。
