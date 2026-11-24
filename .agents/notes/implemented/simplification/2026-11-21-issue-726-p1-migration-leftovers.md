# Agent Note: #726 P1 第二批：迁移残留与旧 URL 重定向收口

Status: implemented

## Problem

#726 P1 第一批（#727–#732）合入后，0.11 迁移期还留下几类残留：

- 启动时有一个致命步骤「教学 outbox 迁移」，把 `education_outbox` 中的待处理行
  映射成 `background_tasks`。`education_outbox` 是 0.11 的 0116 迁移新建的表，
  v0.10.6 升级走「逻辑迁移到全新空库」，0.11 的生产者又始终同事务双写，
  所以这一步已经没有可迁移的数据；
- `access/workspace/index.ts` 里有 19 个 `@deprecated` 的字符串 actor 包装，
  生产代码只有 `scripts/noj.ts` 一处在用，其余全部是测试夹具；
- `workspace/services/instance.ts`、`platform/services/resource-policy.ts` 两个
  纯转发 shim，`startResultConsumerWithRetry`，以及 `RootDb` / `Tx` 类型别名；
- 前端旧 URL 重定向有三套机制：全局中间件规则表、各页面自带的 `navigateTo`
  （`search.vue`、`queue.vue`、`contests/[...slug].vue`、`my/submissions/index.vue`、
  `problems/new/*`），以及三个只渲染「正在前往」提示的 `[...slug]` 兜底页。
  规则表里的 `/ranking → /d/main/rankings` 还导致全站排行榜（含签到榜）
  `pages/ranking.vue` 自 2026-10 起无法访问。

## Decision

- 删除启动期 outbox 迁移、`migrateEducationOutboxTx` /
  `markEducationOutboxMigratedTx` 及其测试；outbox → 通用任务的映射函数
  `enqueueEducationOutboxTaskTx` 移入唯一调用方 `education/contracts/facts.ts`，
  保留的两个真实 PG 用例改名为 `education-tasks.pg.test.ts`。
- 字符串 actor 包装整体移到 `noj-core/tests/helpers/workspace-actors.ts`，生产
  门面只暴露显式 Actor 合同；`scripts/noj.ts` 直接调用
  `ensureDefaultWorkspace(createSystemActor("bootstrap"))`。
- 删除两个转发 shim、`startResultConsumerWithRetry`、`RootDb` / `Tx`，调用方改为
  直接导入 `platform/contracts/resource-policy.ts` 与 `DbRoot`。
- 旧 URL 只保留一套机制：`utils/default-workspace.ts` 是唯一规则表，全局中间件在
  页面 setup 前执行；新增唯一兜底页 `pages/[...legacy].vue`，只为旧路径提供
  可匹配路由，走到 setup 的一律 404。规则表补上 `/queue` 与
  `/problems/new/bundle`（→ `?import=1`）；静态路径段不区分大小写，与原 Vue
  Router 页面一致，ID 与查询参数保持原样。
- 全站排行榜（含签到榜）迁到新地址 `/leaderboard`：v0.11.0 曾把 `/ranking` 301
  到域排行榜，浏览器会缓存，只删规则不足以恢复访问。未缓存的 `/ranking`
  转到新地址，个人主页与域排行榜页都链接到它。
- `CLIENT_ONLY_ROUTES` 去掉已不存在的旧页面路径，使这些旧链接在服务端直接 301。

## Alternatives considered

- **这一批就删除 `education_outbox` 表、统一到 `background_tasks`**：
  `notifications.event_id` 外键指向它，租约、分页游标与 `assignment.refresh`
  去重也依赖这张表，需要先设计任务 payload 与通知幂等键，不属于「直接删除」。
- **在 30 多个测试文件里把包装逐个改写成显式 Actor 调用**：改动面大、收益只在
  测试侧；移到测试 helper 后生产门面已经干净。
- **保留 `/ranking` 重定向，把签到榜搬进域排行榜**：签到是实例级功能，与域无关；
  `/users/:id` 的「全站排名」链接也指向 `/ranking`。

## Consequences

- 从 0.11.0 之前的 rc 实例直接跳到本版本时，如果库里还有未处理且未登记任务的
  outbox 行，这些行不会再被处理。正式支持的升级路径（v0.10.6 逻辑迁移、0.11.0
  起的原地升级）都不受影响。
- `education_outbox` 双写已由后续变更统一到 `background_tasks`，见
  [`2026-11-22-issue-726-education-outbox-unification.md`](2026-11-22-issue-726-education-outbox-unification.md)。
- 管理后台无域竞赛（`http/admin/routes/contest.ts`）和无域题目管理接口仍待迁移，
  见 #726 进展评论。
