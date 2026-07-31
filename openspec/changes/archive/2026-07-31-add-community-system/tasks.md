## 1. 数据与配置基础

- [x] 1.1 定义社区表、用户活动可见性字段、约束和索引
- [x] 1.2 通过 Drizzle Kit 生成并检查追加迁移
- [x] 1.3 增加社区设置项、能力矩阵和三个配置预设
- [x] 1.4 增加社区 RBAC 权限、默认角色授权和默认板块种子

## 2. 社区内容后端

- [x] 2.1 定义社区 API 类型、输入校验和功能开关守卫
- [x] 2.2 实现板块、帖子列表详情、创建编辑和软删除服务
- [x] 2.3 实现评论、一级回复、点赞和收藏服务
- [x] 2.4 实现社区 Hono 路由并注册到应用
- [x] 2.5 在题目详情 API 接入题解权限和发布门槛

## 3. 社交动态与通知

- [x] 3.1 实现关注关系、关注统计和用户活动可见性设置
- [x] 3.2 实现系统活动去重生成与最新/关注动态流
- [x] 3.3 实现社区通知、未读计数、已读接口与 SSE 事件
- [x] 3.4 扩展用户主页和全局搜索社区结果

## 4. 治理与私域控制

- [x] 4.1 实现新用户预审、举报和审核处置服务
- [x] 4.2 实现社区处罚守卫和处罚管理接口
- [x] 4.3 为治理操作接入审计日志
- [x] 4.4 为私信增加动态功能开关
- [x] 4.5 实现管理端板块、审核、举报、处罚与预设 API

## 5. 用户界面

- [x] 5.1 创建社区 composable、共享类型和能力矩阵加载
- [x] 5.2 创建社区首页、帖子卡片、详情、编辑与互动界面
  - [x] 统一独立按钮圆角、焦点与禁用状态，防止社区操作重复提交
  - [x] 增加个人收藏页面、社区首页入口和可见收藏展示
  - [x] 在帖子详情展示当前用户的收藏状态并支持取消收藏
  - [x] 增加社区首页题目 ID、标题和正文筛选，以及全局搜索帖子结果展示
- [x] 5.3 在题目页和用户主页接入题解、动态与关注
- [x] 5.4 创建通知中心并接入导航未读状态
- [x] 5.5 创建社区管理后台并接入管理员导航
- [x] 5.6 加固 Markdown HTTPS 外链图片渲染

## 6. 验证

- [x] 6.1 增加 schema、设置、内容、互动、动态流和治理单元测试
  - [x] 覆盖预设、题解通过门槛、预审通知、处罚、举报处置与动态隐私
  - [x] 覆盖个人收藏归属、已隐藏或删除内容过滤和路由鉴权
  - [x] 覆盖帖子详情返回当前用户收藏状态
  - [x] 覆盖社区帖子按关联题目、标题和正文筛选
- [x] 6.2 增加社区路由权限、模块关闭和安全测试
  - [x] 覆盖写入鉴权、普通用户权限边界及通知已读接口
- [x] 6.3 增加跨模块社区主流程 E2E 测试
  - [x] 覆盖关注、互动通知、举报处置和软删除可见性
  - [x] 覆盖收藏创建、个人收藏展示和软删除后的收藏过滤
  - [x] 覆盖社区和全局帖子搜索主流程
- [x] 6.4 运行 core 与 UI 的 fmt、lint、类型检查和相关测试
  - [x] 运行社区服务与路由测试、core lint/类型检查和实际社区 E2E
  - [x] 运行 UI fmt、lint 与生产构建，验证按钮样式和交互修复

## 7. UI/UX 全面修复（spec 补齐 + 体验改进）

- [x] 7.1 新增后端能力端点
  - [x] 通知单条已读 `POST /notifications/:id/read` 与 `markNotificationRead`
  - [x] 通知 SSE `GET /notifications/events`（复用 per-user 通道，仅透传 notification:new）
  - [x] 帖子类型计数 `GET /posts/counts` 与 `countPostsByType`
  - [x] 评论编辑/软删除 `PATCH/DELETE /comments/:commentId` 与 `updateComment`/`deleteComment`
  - [x] 单用户处罚历史 `GET /admin/users/:userId/sanctions` 与 `listUserSanctions`
  - [x] 上述端点路由测试（已读归属/404/401、计数、评论治理、处罚历史、SSE 守卫）
  - [x] 修复社区 service/route 测试在真实 PG 下因 resetDbForTest 截断 roles 的 FK 失败（setup 补 ensureRbacSeeds）
- [x] 7.2 社区首页重构
  - [x] 默认 Tab 兜底（模块关闭时回退首个启用类型）
  - [x] Tab 内容计数（counts 端点 + 标签徽标）
  - [x] type/q/problem_id URL 双向同步与游标「加载更多」
  - [x] 筛选空状态区分 + 卡片类型/锁定/审核中/隐藏徽标 + 纯文本预览（stripMarkdown）
  - [x] 发布编辑器 Markdown 预览 + 题解题目搜索选择器 + 长度提示
- [x] 7.3 帖子详情重构
  - [x] 一级回复（根评论嵌套、回复输入、仅一层）
  - [x] 评论 textarea + 时间戳 + pending/hidden 徽标
  - [x] 帖子与评论编辑/删除（作者/审核员，dialog 确认）
  - [x] 状态徽标（审核中/已隐藏/已锁定）与共享类型替换 any
- [x] 7.4 收藏页：取消收藏、类型徽标、游标分页
- [x] 7.5 通知页：点击单条已读、follow 跳转作者主页、类型图标、加载更多；导航栏接入通知 SSE + 轮询兜底刷新未读数
- [x] 7.6 管理后台重构：独立开关 + 数字设置、待审内容批准/驳回、处罚管理 + 单用户处罚历史、板块新建/归档、举报保留
- [x] 7.7 全局搜索 moment 标签确认：后端全局搜索排除短动态（type IN solution/discussion），无需改动

## 8. 关注动态流与正确性修复（评审反馈）

- [x] 8.1 首页「关注动态」card（参考洛谷，不放在社区页）
  - [x] 新增 `components/feature/FollowingFeed.vue`，在 `/` 首页卡片网格中展示 `GET /community/feed?view=following`（合并已关注用户的短动态与系统活动：first_accepted / solution_published / contest_joined），每条跳转对应目标
  - [x] 社区页 `/community` 保持纯类型 Tab（讨论/题解/动态），不含关注流；已登录且关注/动态或活动模块开启时首页展示卡片，未登录/无关注给出空状态
  - [x] `listFeed` 不再强制要求 moments 模块，动态/活动任一开启即可；moment 分支受模块开关控制
- [x] 8.2 社区服务正确性修复
  - [x] `updatePost` 编辑同样校验长度限制（moment/post 分别对应 moment_max_length / post_max_length），防止绕过 createPost 校验
  - [x] 题目引用解析 `resolveProblemId`：支持 UUID / display_id（P1001）/ 纯数字，筛选与发布题解共用；题目不存在返回 ValidationError 而非 FK 500
  - [x] `createComment` 仅允许回复已发布评论，阻止回复 pending/hidden/deleted 的孤儿评论
  - [x] 评论审核：新增 `changeCommentStatus` + `POST /admin/comments/:commentId/:status` + `listPendingComments` + `GET /admin/comments/pending`，批准待审评论时补发回复通知
  - [x] `listPosts` 游标分页时排除置顶帖，避免置顶内容在每页顶部重复
  - [x] 无 type 的 `/posts` 与 `countPostsByType` 仅返回启用模块的内容，审核员查询不受限制
  - [x] `toggleCommentLike` 校验评论存在并通知被赞者（携带所属帖子用于跳转）
  - [x] `createReport` 限制举报原因长度（≤500）
  - [x] 作者自删与审核员处置在审计 detail 中区分（`self_delete`）
- [x] 8.3 前端体验修复
  - [x] 帖子详情返回 `liked` 并展示点赞激活态，与收藏态一致
  - [x] 题解详情显示关联题目链接（跳转题目页）
  - [x] 管理后台新增「待审评论」审核队列，待审内容上限提升到 100
  - [x] 管理后台数字设置清空后不再误写 0
- [x] 8.4 测试：更新「未通过题目」用例（题目存在性 + display_id 解析），新增编辑长度、回复待审评论、评论点赞通知、待审评论审核队列测试
- [x] 8.5 补充集成与 E2E 测试
  - [x] 路由测试：`GET /feed?view=following`（关注流仅含已关注用户内容 + 游客 401）、`GET /admin/comments/pending`（普通用户 403）、`POST /admin/comments/:id/:status`（批准待审评论后作者收到回复通知）
  - [x] E2E：关注动态流主流程（关注后短动态进入 `view=following`）、新用户评论预审全流程（发帖→开启预审→评论 pending→管理员队列→批准→作者通知）
  - [x] 全部通过：core 测试 667 项、社区路由测试 13 项、社区 E2E 4 项（含新增 2 项）
- [x] 9. 二轮评审修复（规范符合性 + 标准符合性）
  - [x] 9.1 正确性修复
    - [x] 题解通过门槛豁免管理员/审核员（`createPost` 仅普通用户校验 Accepted）
    - [x] 模块关闭时帖子详情与评论列表返回 `FEATURE_DISABLED` 403（`getPost` 按内容类型断言模块开关）
    - [x] 评论列表允许作者查看自己的 pending/hidden 评论（非 deleted）
    - [x] 全局搜索命中题解关联题目的 display_id（`type || number` ILIKE 匹配）
    - [x] 动态流改用 `(created_at, id)` 复合游标，兼容旧纯时间戳游标
    - [x] `toggleCommentLike` 仅允许点赞已发布评论（pending/hidden/deleted 返回 404）
    - [x] `togglePostFlag` 审计 detail 的 `status` 改为语义值（locked/pinned）
    - [x] 批准待审评论时向评论作者补发 moderation 审核通知（保留被回复者 reply 通知）
  - [x] 9.2 标准符合性修复
    - [x] `applyCommunityPreset` 事务化写入（`updateSetting` 支持事务模式 + 提交后统一刷新缓存）
    - [x] 社区设置 envFallback 全部补充到 `noj-core/.env.example` 与 `scripts/dev/env.example`
    - [x] `schema-ddl.ts` roles 表定义去重（移至数组顶部依赖预置）
    - [x] 管理后台移除 `any` 类型（新增共享 `ReportRow` 类型）
    - [x] AGENTS.md 迁移文件数更新（26 → 32）
  - [x] 9.3 发布频率设置（community-configuration spec 补齐）
    - [x] 新增 `community_post_interval_seconds` 设置项与 `COMMUNITY_POST_INTERVAL_SECONDS` envFallback
    - [x] `createPost` 按配置间隔限流（超频返回 `POST_RATE_LIMITED` 403）
    - [x] 管理后台数字设置新增「发布频率限制」项
  - [x] 9.4 题目页题解列表与发布入口（community-ui spec 补齐）
    - [x] 新增 `GET /community/solutions/eligibility?problem_id=`（返回模块开关、门槛、Accepted 状态与能否发布）
    - [x] 题目详情页展示题解列表（前 5 条 + 查看全部）
    - [x] 发布入口服从题解模块与权限：未登录引导登录、无权限/未通过/只读禁用并说明原因
  - [x] 9.5 moderation 权限体系（community-moderation spec 补齐）
    - [x] `/admin/*` 从 `requireAdmin()` 改为 `community_moderation:review` 权限守卫（管理员 fast path 保留）
    - [x] 细分：预设 `system:settings`、板块 `community_board:manage`、锁定/置顶 `community_moderation:lock`、处罚 `community_moderation:sanction`
    - [x] seed-rbac 为 admin 角色显式授予治理权限（`ensureAdminRolePermissions`）
    - [x] 前端 `community-moderation` middleware：非管理员审核员可进入社区管理页
