# Agent Note: 赛时社区静默补齐评论与编辑写路径

Status: implemented

## Problem

2026-09-28 审计 N-01（Critical）的修复「赛时社区全局静默」只在 `createPost`
中拦截了讨论帖与动态的**新建**。以下三条写路径仍不受限，赛中（含 pending
筹备期）任何登录用户都可向全场广播完整解法：

- `createComment`：在任意可见帖（含普通题题解、赛前旧帖）下发表评论，默认上限
  10000 字，并进入全局搜索索引；
- `updateComment`：把赛前评论改写为解法；
- `updatePost`：把赛前发布的讨论帖/动态/题解改写为解法；
- `createPost(type=solution)`：给任意**非赛题**发题解（门槛仅为通过该题），
  正文夹带赛题解法。原保密写门控按"题解挂靠的题目"判定，无法识别正文内容。

## Decision

- 在 `community-post-common.ts` 新增 `assertNotContestSilenced(moderator)`
  作为赛时静默的单一入口，复用 contest 域 SSOT `hasUnendedPublicContest()`，
  不手写时间窗口；
- `createPost`（全部类型，含题解）、`updatePost`（全部类型）、`createComment`、
  `updateComment` 统一调用该入口；审核员免静默。静默放在保密门控之后，
  赛题题解仍得到更具体的 `CONTEST_SECRECY`；
- 题解发布资格接口 `GET /api/v1/community/solutions/eligibility` 新增
  `blocked_reason: "contest_silence"`，前端据此禁用发布入口并提示"赛后恢复"，
  避免用户点击后才收到 403；
- 新增 `community-contest-silence.test.ts`（5 个用例：评论、pending 期评论、
  编辑评论、编辑动态与题解、新建非赛题题解），并做反向验证（去掉检查后用例全部失败）。

## Alternatives considered

- 只拦截 problem 关联帖下的评论：无法覆盖动态与无题目讨论帖下的评论，广播面依旧存在；
- 赛期题解进入待审核队列（方案 B）：保留内容但赛中审核负担大，已发布题解被编辑后
  需退回待审，状态机更复杂；赛后自动发布（方案 C）需定时发布机制。均留作后续演进；
- 在路由层逐个加检查：与服务层门控分散两处，未来新增写路径易漏，故收敛到服务层单一入口。

## Consequences

- 公开赛未结束期间，普通用户无法发表/编辑任何帖子与评论，服务端返回 403
  `CONTEST_SILENCE`；练习区题解在比赛期间暂停，赛后自动恢复；
- 评论框与编辑入口前端尚未按 `CONTEST_SILENCE` 预先禁用，用户提交后看到服务端提示。
