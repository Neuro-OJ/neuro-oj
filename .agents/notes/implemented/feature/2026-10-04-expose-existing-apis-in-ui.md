# Agent Note: 补齐已实现接口的界面入口（提交日期筛选、签到活跃榜、赛期本人榜单提示）

Status: implemented

## Problem

2026-09-24 文档可读性审计遗留了三处"服务端已实现、界面不可达或未说明"的问题：

1. **#581**：`GET /api/v1/submissions` 支持 `from` / `to`，但提交记录页没有日期控件；
2. **#580**：`GET /api/v1/rankings/checkin`（签到活跃榜）在 noj-ui 中零调用点；
3. **#583**：竞赛进行中非管理员只拿到本人一行，封榜期已有提示，但未封榜的 `live` 视图没有任何说明，用户易误读为数据缺失。

## Decision

1. **提交日期筛选**：新增 `utils/submissionDateRange.ts`，把本地日期换算为「本地当天 00:00:00.000 ~ 23:59:59.999」对应的 UTC ISO 字符串再发请求。
   原因：`submissions.created_at` 是 UTC ISO **文本列**，后端用字符串 `gte/lte` 比较；直接透传 `YYYY-MM-DD` 会让 `to` 当天的记录全部被排除，且忽略用户时区。起止颠倒时自动交换。筛选栏改为响应式网格以容纳 6 个字段。
2. **签到活跃榜**：`/ranking` 页新增 `UTabs` 切换（`?board=checkin`），签到榜拆为独立组件 `CheckinLeaderboard.vue`，仅在激活时挂载并请求；月份以 URL `?month=YYYY-MM`（UTC）驱动，禁止翻到未来月份。名次徽章抽为 `RankBadge.vue` 供两个榜单复用。
3. **赛期本人榜单提示**：`utils/contestRanking.ts` 新增 `isLiveSelfOnly(view, adminLive, status)`，`running` + `live` + 非管理员时在榜单页显示提示；封榜期继续由 `isFrozenSelfOnly` 负责，避免重复提示。文档按 VULN-09 后的真实行为说明：与 `ranking_visibility` 无关，赛期（含封榜）及待结算期普通用户都只见本人一行。

## Alternatives considered

- **日期筛选直接传 `YYYY-MM-DD` 并改后端补全时间**：需改动 core 接口语义且仍无法感知用户时区，放弃。
- **签到榜做成独立页面**：会新增导航入口，与"榜单"概念重复；放在同页 Tab 更易发现。
- **#583 只改文档不改 UI**：用户在页面上仍会困惑，issue 首选方案即 UI 明示，故两者都做。

## Consequences

- 三项能力的文档（`users/submit.md`、`features/ranking.md`、`features/contests.md`）改回正向描述。
- 解题榜在签到 Tab 下仍会由页面级 `useFetch` 请求一次（公开、带物化视图缓存的轻量查询），换取解题榜 SSR 逻辑不变。
- 签到榜按 UTC 自然月统计，与签到判定口径一致；北京时间 0–8 点的签到计入前一 UTC 日，页面已标注"按 UTC 自然月统计"。
