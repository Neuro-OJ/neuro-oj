# Agent Note: 域首页补充推荐题目、近期比赛与公开题单卡片

Status: implemented

## Problem

域首页（`/d/[slug]`）主体原先仅包含「最新评测」「公告」与「教学与学习待办」三个区块。在无评测记录、无公告或访客/非教学班成员视角下，右侧公告与待办会因 `empty:hidden` 隐藏，左侧仅剩空状态评测列表，导致首页整体显得空旷。

## Decision

在保留现有域首页双栏结构与终端风格设计 token 的前提下，新增三个紧凑首页卡片组件并接入 `noj-ui/pages/d/[slug]/index.vue`，同时将三个卡片的首屏数据收口到 Nitro 首页 BFF（`/api/bff/v1/domains/:slug/home`）：

1. `HomeRecommendedProblemsCard.vue`：置于左栏「最新评测」上方，展示当前域前 3 道公开题目（题号、标题、类型、难度与通过率）及「全部题目 →」入口。
2. `HomeContestsCard.vue`：置于右栏公告下方，优先展示进行中/未开始的最近 3 场比赛（状态指示、赛制、开始时间、题数）及「全部比赛 →」入口；`GET /api/v1/domains/:slug/contests` 新增 `sort=upcoming` 参数，在分页截断前按「进行中 → 最近未开始 → 已结束倒序兜底」排序。
3. `HomeTrainingsCard.vue`：置于右栏比赛卡片下方，展示最近 3 份公开题单（标题、来源域标识、简介）及「全部题单 →」入口。

## Alternatives considered

1. 三个卡片各自在组件内以 `useAsyncData` 独立请求：会违背域首页 SPA 导航单 BFF 请求的约束，且仅靠前端对 `start_time DESC` 的首页结果过滤会在多场未来比赛时挤掉进行中或临近比赛，故改为后端 `sort=upcoming` 并在首页 BFF 中聚合。
2. 在 Hero 中增加题号直接跳转输入框：已实现后按产品反馈移除，保持命令头简洁。

## Consequences

- 访客与新环境进入域首页即可看到可点击的题目、比赛与题单内容，左右两栏视觉密度更均衡。
- 三个卡片的首屏与 SPA 跨空间导航复用单次 `/api/bff/v1/domains/:slug/home` 聚合请求，失败重试仍走对应细粒度接口；默认比赛列表排序保持 `start_time DESC` 不变。
