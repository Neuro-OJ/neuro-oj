# Agent Note: 通知点击回退到社区首页与通知详情页

Status: implemented

## Problem

`/community/notifications` 的通知卡片点击后落在错误位置：`notificationHref()` 的选择链
以 `return "/community"` 收尾，于是**任何没有可跳转关联内容**的通知都会把用户丢回社区首页。
这类通知不是边缘情况，而是稳定存在的：

- `ban`（封禁通知）由 `createNotification(targetUserId, adminId, "ban", null, null, {...})`
  写入，`post_id`/`comment_id` 恒为 `null`，也没有 `report_id`/`contest_id` ——
  **每一条封禁通知都必然命中该兜底**；
- `reply`/`like`/`moderation` 的帖子或评论被删除后，`community_notifications.post_id`
  的外键是 `onDelete: "set null"`，通知随即变成「无目标」；
- `follow` 的触发者注销后 `actor_id` 被置空（`onDelete: "set null"`），同样无目标。

结果是：用户点了通知，既没看到通知内容，也没看到相关内容，只是回到了社区首页——
通知页本身不展示封禁范围/理由/期限等完整信息，这些信息在首页无处可寻。

实现该功能时还暴露出一个**由本改动引入**的路由缺陷（已在同一次改动中修复）：
新增的 `GET /api/v1/community/notifications/:id` 会抢先匹配同前缀的字面量路径。
`app.ts` 中 `communityRouter` 挂载在 `communitySse` **之前**（`:193` vs `:206`），
因此 `/notifications/events`（通知 SSE）与 `/notifications/unread-count` 双双退化为 404
——实时通知与未读角标静默失效。浏览器实测该端点由 200 变 404，才暴露出来；
仅测通知详情端点本身无法发现。

前端另有一处结构性缺陷：列表页 `pages/community/notifications.vue` 与新详情页
`pages/community/notifications/[id].vue` 构成 Nuxt 的「同名文件 + 同名目录」冲突。
Nuxt 会把 `notifications.vue` 当作 `[id].vue` 的父路由，而它没有 `<NuxtPage/>`，
于是访问详情 URL 时渲染的仍是列表页（实测 URL 已是 `/community/notifications/<id>`，
页面内容却是列表）。这与 `pages/problems.vue` 的情形相同，后者靠
`<NuxtPage v-if="route.path !== '/problems'" />` 兜住。

## Decision

**1. 后端新增单条通知读取。** `services/community/community-feed.ts` 增加
`getNotification(userId, notificationId)`，复用 `listNotifications` 的投影
（`leftJoin users` 取 actor），按 `recipient_id` 限定归属，查不到抛
`NotFoundError("通知不存在")`（与 `markNotificationRead` 既有语义一致：
不泄露他人通知是否存在）。路由 `GET /notifications/:id` 需登录，返回
`{ data: { notification, actor } }`。

**2. `:id` 限定为 UUID 形状。**
路由声明为 `/notifications/:id{<uuid 正则>}`，而不是依赖注册顺序。
理由：字面量路由分散在两个文件里（`unread-count` 在本文件、`events` 在 `sse.ts`），
靠顺序规避既脆弱又跨文件；UUID 约束让 `:id` 永不匹配字面量段，与挂载顺序解耦。

**3. 前端抽出共享规则。** `utils/communityNotifications.ts` 承载
`notificationTarget(item): string | null`（`null` = 无关联内容）、
`notificationDetailUrl()`、`NOTIFICATION_TYPE_LABEL`/`NOTIFICATION_TYPE_ICON`
与 `notificationTypeLabel`/`notificationTypeIcon`（未知类型回退原始值/通用图标）。
类型定义 `CommunityNotificationType` 同时被 `composables/useCommunity.ts` 的
`NotificationRow` 引用，避免两处类型漂移。该 util 只声明用到的最小字段
（`NotificationTargetSource`），从而不反向依赖 composables。

**4. 点击行为。** 列表页 `notificationHref()` = `notificationTarget(item) ?? notificationDetailUrl(id)`：
有关联内容仍直达（帖子/用户主页/竞赛答疑/举报详情），无关联内容进入详情页。
按评审选择，保留「有目标就直达」的快速路径，不统一改为先进详情页。

**5. 详情页与路由结构。** 新增 `pages/community/notifications/[id].vue`，
并把列表页从 `pages/community/notifications.vue` **移动**为
`pages/community/notifications/index.vue`，使两者成为同级路由，从根上消除
「父路由不渲染子路由」的冲突（URL 不变）。未采用 `problems.vue` 的
`<NuxtPage>` 方案：那会让列表组件在详情 URL 上也被挂载并重复请求列表接口。
详情页按类型展示 message/reason/resolution、封禁范围与起止时间、审核状态、
提问公开性与关联题号，进入即标记已读并刷新未读角标；有关联内容时给
「查看相关内容」入口（深链打开时同样可用）。标题在加载/未找到状态下也渲染。

## Alternatives considered

- **只在详情页做弹窗（UModal），不加后端端点。** 零后端改动，但刷新即丢、链接不可分享，
  且与既有 `/community/reports/[id]` 的「通知 → 详情页」模式不一致。已否决。
- **保留 `return "/community"` 兜底但在首页高亮通知。** 首页是社区信息流，
  放封禁理由/审核结果既无合适位置也造成信息泄露面扩大。通知详情应属于通知模块自身。
- **靠注册顺序修复路由遮蔽（把 `:id` 挪到 `sse.ts` 之后注册）。** 需要跨文件保证
  `app.ts` 的挂载顺序，任何一次挂载顺序调整都会静默重新引入 404。选择 UUID 约束。
- **`pages/problems.vue` 式的 `<NuxtPage v-if>` 方案。** 与仓库既有写法一致，但父组件
  在子路由上仍会挂载并执行 `onMounted` 里的列表加载——访问详情页会白白多打一次列表接口。
  移动为 `index.vue` 更干净，且是 Nuxt 的标准写法。
- **统一「点击一律进详情页」。** 评审时明确否决：会牺牲 `reply`/`like` 一步直达帖子的
  体验。保留快速路径，仅无目标时进详情。
- **`getNotification` 返回 403 而非 404 表示非本人。** 会让攻击者据此区分「通知存在但
  不属于你」和「不存在」。与 `markNotificationRead` 保持一致用 404。
- **在详情页内联渲染关联帖子/评论正文。** 本次不做（YAGNI）：需再引入帖子投影与
  可见性判定（私密板块、已删除内容、社区开关），收益有限；详情页给跳转入口即可。

## Consequences

- 封禁通知（以及内容被删、触发者注销的通知）点击后进入
  `/community/notifications/<id>`，可看到完整封禁范围/理由/时间/期限，刷新与分享深链均可用；
  有关联内容的通知行为不变。
- 通知 SSE（`/notifications/events`）与未读计数（`/notifications/unread-count`）
  不再被 `:id` 吞掉；该失效与 `app.ts` 的挂载顺序解耦。
- 新增端点仅本人可读，非本人与不存在同为 404。
- 回归防护：
  - `noj-core` 路由测试（`tests/routes/community.test.ts`）：本人 200、他人 404、
    不存在 404、`unread-count` 仍为计数、`/notifications/events` 仍为 200 且
    `content-type: text/event-stream`。移除 `:id` 的 UUID 约束后该用例失败。
  - `noj-ui` 单测（`tests/utils/communityNotifications.spec.ts`，13 例）：各类型目标解析、
    `ban`/已删除帖子/已注销触发者 → `null`、并断言**任何情况下都不再返回 `/community`**。
  - 浏览器 E2E（`noj-tests/e2e/browser/21_notifications.test.ts`，2 例）：真实封禁
    （管理员封禁→立即解封，构造无目标通知）后点击卡片必须落在详情页且展示封禁理由，
    同时断言页面无 404 请求；以及详情深链可达、未知 id 显示「通知不存在」。
    把列表页兜底改回 `/community` 时第一例失败（实测报错
    `实际为 http://localhost:3000/community`）。
- 未做（记录备查）：
  - 通知列表无分页游标，仅靠 `limit` 递增（上限 100），本次未改；
  - 详情页不做关联帖子/评论内容的内联预览（见 Alternatives）；
  - `noj-tests/e2e/browser/21_notifications.test.ts` 的 `ensureUser` 在本地 dev core 上
    走「注册+直接登录」回退（dev 不返回邮箱验证令牌，仅 E2E 环境返回），会打印一条
    warning；E2E 栈上仍走严格验证路径；
  - 本地 dev 库中被本次验证创建的 `e2e_admin`（浏览器 E2E 所需的种子管理员）与
    临时 `notif_*`/`notifprobe*` 用户属本地环境产物，未纳入版本控制。
