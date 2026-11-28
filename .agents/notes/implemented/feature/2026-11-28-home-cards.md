# Agent Note: 域首页补充推荐题目、近期比赛与公开题单卡片

Status: implemented

## Problem

域首页（`/d/[slug]`）主体原先仅包含「最新评测」「公告」与「教学与学习待办」三个区块。在无评测记录、无公告或访客/非教学班成员视角下，右侧公告与待办会因 `empty:hidden` 隐藏，左侧仅剩空状态评测列表，导致首页整体显得空旷。

## Decision

在保留现有域首页双栏结构与终端风格设计 token 的前提下，新增三个紧凑首页卡片组件并接入 `noj-ui/pages/d/[slug]/index.vue`：

1. `HomeRecommendedProblemsCard.vue`：置于左栏「最新评测」上方，展示当前域前 3 道公开题目（题号、标题、类型、难度与通过率）及「全部题目 →」入口。
2. `HomeContestsCard.vue`：置于右栏公告下方，优先展示进行中/未开始的最近 3 场比赛（状态指示、赛制、开始时间、题数）及「全部比赛 →」入口。
3. `HomeTrainingsCard.vue`：置于右栏比赛卡片下方，展示最近 3 份公开题单（标题、来源域标识、简介）及「全部题单 →」入口。

## Alternatives considered

1. 将三个列表一并并入 Nitro 首页 BFF（`/api/bff/v1/domains/:slug/home`）：可进一步减少首屏请求数，但需要同步修改 BFF 契约与对应服务端测试；本次先以组件内 `useAsyncData` 独立加载并保留 `AsyncContent` 错误重试，后续可平滑收口到 BFF。
2. 在 Hero 中增加题号直接跳转输入框：已实现后按产品反馈移除，保持命令头简洁。

## Consequences

- 访客与新环境进入域首页即可看到可点击的题目、比赛与题单内容，左右两栏视觉密度更均衡。
- 三个卡片各自通过 `useAsyncData` 请求现有列表接口，未改动后端 API 与 BFF 协议。
