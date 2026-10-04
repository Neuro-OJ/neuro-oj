# Agent Note: 赛时社区静默补齐评论与编辑写路径

Status: implemented

## Problem

2026-09-28 审计 N-01（Critical）的修复「赛时社区全局静默」只在 `createPost`
中拦截了讨论帖与动态的**新建**。以下三条写路径仍不受限，赛中（含 pending
筹备期）任何登录用户都可向全场广播完整解法：

- `createComment`：在任意可见帖（含普通题题解、赛前旧帖）下发表评论，默认上限
  10000 字，并进入全局搜索索引；
- `updateComment`：把赛前评论改写为解法；
- `updatePost`：把赛前发布的讨论帖/动态改写为解法。

## Decision

- 在 `community-post-common.ts` 新增 `assertNotContestSilenced(moderator)`
  作为赛时静默的单一入口，复用 contest 域 SSOT `hasUnendedPublicContest()`，
  不手写时间窗口；
- `createPost`（讨论/动态）、`updatePost`（讨论/动态）、`createComment`、
  `updateComment` 统一调用该入口；审核员免静默；
- 题解的新建与编辑仍不在静默范围内，与原决策 1 口径一致；赛期题目的题解由既有
  `getPost` 读门控与 `isProblemInUnendedPublicContest` 写门控覆盖；
- 新增 `community-contest-silence.test.ts`（4 个用例：评论、pending
  期评论、编辑评论、编辑动态与题解对照），并做反向验证（去掉检查后 4 例全部失败）。

## Alternatives considered

- 只拦截 problem 关联帖下的评论：无法覆盖动态与无题目讨论帖下的评论，广播面依旧存在；
- 在路由层逐个加检查：与服务层门控分散两处，未来新增写路径易漏，故收敛到服务层单一入口。

## Consequences

- 公开赛未结束期间，普通用户无法评论或编辑讨论/动态，前端会收到 403
  `CONTEST_SILENCE`（提示文案改为"讨论、动态与评论"）；
- 遗留风险：赛中普通用户仍可为**非赛题**新建题解，正文可夹带赛题解法。是否把题解也纳入静默属产品决策，本次未改。
