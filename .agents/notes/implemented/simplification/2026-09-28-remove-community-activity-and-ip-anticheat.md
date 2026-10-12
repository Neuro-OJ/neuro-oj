# Agent Note: 下线社区自动动态与 IP 反作弊（功能移除）

Status: implemented

## Problem

2026-09-28 安全审计中有两项的裁定是**整体移除功能**而非修补（VULN-06、VULN-08）。

**VULN-08（High，社区自动动态）**：`community_activity_events` 承载三类自动动态（`first_accepted` 首次通过、`solution_published` 发布题解、`contest_joined` 参加竞赛），与平台原生的讨论功能高度重叠却缺乏实质内容，并直接破坏竞赛机制：

- `submissions-result.ts` 写入 `first_accepted` 时完全脱离竞赛上下文，比赛中（**含封榜期**）任何人刷新动态流即可看到"某选手首次通过题目 X"，封榜因此失去意义；
- 事件 `metadata` 直接暴露内部 `submission_id`（与 VULN-10 的监听链形成组合面）；
- `contest_joined` 会把用户报名的**私密邀请赛标题**广播出去；
- 用户侧的 `users.community_activity_visibility`（hidden/following/everyone）是为该信息流设计的可见性开关，随功能一并成为死配置。

**VULN-06（Low，IP 反作弊）**：竞赛提交路由把 `clientIp` 硬编码传成 `undefined`（`submissions.client_ip` 全为 NULL、反作弊查询恒为 0），而通用提交路由仍在采集该字段。审计裁定**直接移除**该机制：学校机房/实验室/集训队/线下赛场普遍数十至数百人共用一个出口 NAT IP，"多账号同 IP"是常态而非异常，误报率极高；远程比赛中手机热点/VPN 即可改写 IP，对真正的攻击者近乎无效；且该字段是为机制专门采集的个人数据。

## Decision

**VULN-08：全栈移除社区自动动态。**

- 后端：删除 `createActivity` 与三处调用点（`submissions-result.ts` 的 `first_accepted`、`community-post-crud.ts` 的 `solution_published`、`contest/routes/contests.ts` 的 `contest_joined`）；`community-feed.ts` 的 `listFeed` 重写为只返回短动态（moment），删除活动事件查询、`activity` 混排与排序、以及针对 `solution_published` 的赛期过滤（该过滤本身也已无对象）。
- 配置：删除 `community_activities_enabled` 设置项与其 `CommunityConfig.activities_enabled` 字段、`.env.example` 中的 `COMMUNITY_ACTIVITIES_ENABLED`；社区预设（public/private/knowledge）同步去掉该项。
- 数据：删除 `community_activity_events` 表与 `users.community_activity_visibility` 列（含 CHECK 约束），移除 `/api/v1/community/me/activity-visibility` 端点与 `updateActivityVisibility` 服务；`schema-ddl.ts`（PGlite 测试用 DDL 镜像）同步，`schema.ts` 与 `schema-ddl.ts` 的 parity 门禁保持绿色。
- 迁移 `0095_steady_korg.sql`：`DROP TABLE community_activity_events CASCADE`、`DROP CONSTRAINT users_community_activity_visibility_check`、`DROP COLUMN users.community_activity_visibility`。
- 前端：`FollowingFeed.vue` 只渲染帖子条目，`useCommunity.ts` 删除 `FeedActivity` 与 `activities_enabled`，管理端社区设置去掉「系统活动」开关。

**VULN-06：全栈移除 IP 反作弊。**

- `contest-anti-cheat.ts` 收缩为只保留 `assertContestExists`（`contest-similarity.ts` 复用），删除 IP 分组聚合、IP 时间线、清理任务与保留设置；`contest-anti-cheat.ts` 的模块注释记录移除理由。
- 删除 `/contests/:id/anti-cheat/ip-groups` 与 `/anti-cheat/timeline` 两个管理端端点（**保留** `similar-submissions` 相似度查重端点）；`main.ts` 不再启动 IP 保留任务。
- 停止采集：`createSubmission` / `createArtifactSubmission` 去掉 `clientIp` 参数与写入，提交路由不再解析客户端 IP；迁移删除 `submissions.client_ip` 列与 `idx_submissions_contest_client_ip` 索引（`schema-ddl.ts` 同步）。
- 配置：删除 `anti_cheat_ip_retention_days` 设置项与 `.env.example` 的 `ANTI_CHEAT_IP_RETENTION_DAYS`。
- 前端：`useContests.ts` 与 `/admin/contests` 风控面板删除 IP 关联分栏/多账号组/时间线，保留相似度查重；IP 封禁（`ip_bans`、封禁横幅）作为独立功能完整保留。
- 文档：`noj-docs/docs/system/anti-cheat.md` 改写为"IP 机制已下线 + 原因"，并登记相似度查重的已知局限（VULN-12 语言别名分桶，本轮只立项不热修）；`legal-compliance.md` / `admin-guide.md` / `data-dictionary.md` 同步删除相关行与表。

## Alternatives considered

- **保留动态功能但补竞赛门控**（把 `first_accepted` 也纳入赛期过滤、从 metadata 去掉 `submission_id`）：能缓解封榜击穿，但功能本身与讨论重叠、无实质内容，且每加一类事件都要重新评估泄密面——审计裁定为下线，避免长期维护一个持续产生侧信道的模块。拒绝。
- **保留 `community_activity_events` 表只停写**：会留下无写者的死表与死配置，且 `users.community_activity_visibility` 继续作为"看起来可用"的隐私开关误导用户。拒绝。
- **IP 反作弊只降阈值 / 只对竞赛启用**：误报根源是 NAT 共享与可规避性，不是阈值；审计明确"直接移除"。拒绝。
- **保留 `submissions.client_ip` 采集但下线查询**：等于继续采集不再有用途的个人数据，违反数据最小化；且刚移除的保留任务正是清理它的唯一机制。拒绝（连列一起删）。
- **相似度查重分桶顺手做语言别名归一化（VULN-12）**：审计裁定本轮不做局部热修复，需在分词、Token 化、跨语言比对与分桶策略上整体重构，故只登记局限并立项。拒绝热修。

## Consequences

- 社区动态流从此只包含用户短动态，不再存在"某选手通过某题"的实时广播侧信道；封榜与保密不再被动态流击穿，内部 `submission_id` 与私密邀请赛标题也不再外泄。
- 平台**不再采集提交来源 IP**：`submissions.client_ip`、`ANTI_CHEAT_IP_RETENTION_DAYS`、`anti_cheat_ip_retention_days`、同 IP 多账号/时间线视图全部消失。反作弊线索收敛为代码相似度（+ 人工复核），与审计"聚焦强相关特征"的取向一致。
- **不可逆的数据影响**：迁移会**删除** `community_activity_events` 全表数据与 `users.community_activity_visibility`、`submissions.client_ip` 两列数据。升级前如需留档，请先自行导出（动态为可丢弃的信息流，IP 为按最小化原则不应继续保留的数据）。
- 前后端契约变化：`GET /api/v1/community/feed` 只返回 `kind: "moment"` 条目；`PUT /api/v1/community/me/activity-visibility` 与两个 anti-cheat IP 端点被移除（调用方会得到 404）；管理端社区/竞赛风控面板相应减少分栏。`.env` 中残留的 `COMMUNITY_ACTIVITIES_ENABLED` / `ANTI_CHEAT_IP_RETENTION_DAYS` 不再被读取（`deno task check:env` 会提示未登记键）。
- 测试与门禁：社区域测试改为断言"动态流只含短动态"；`schema.ts ↔ schema-ddl.ts` parity 与迁移安全检查（禁止一步式 `ADD COLUMN NOT NULL`）均通过；`contest-anti-cheat.test.ts` 随机制删除（其覆盖的 IP 聚合逻辑已不存在），相似度查重测试保留。
