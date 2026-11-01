# Agent Note: 下线社区关注、点赞与收藏

Status: implemented

## Problem

社区在讨论区之外还有一层社交互动：关注、关注动态、帖子/评论点赞、收藏，以及对应的
4 张表、3 个开关配置、2 个 RBAC 权限和 8 组 IP + 用户限流。#698
审查时只读查询生产库： 关注 4 条、帖子点赞 9 条、评论点赞 0 条、收藏 1
条。这层功能对评测平台价值有限， 却要维护赛期门控、跨域授权与限流的大量分支。

## Decision

- core：删除点赞/收藏/关注服务与路由、收藏列表、动态流（只服务于关注动态）、帖子详情
  的 `liked`/`bookmarked` 与点赞计数、个人主页的关注/粉丝数、`community:react` /
  `community:follow` 权限、三个开关配置。迁移 `0131` 清理配置与权限后删除
  `community_follows`、`community_post_likes`、`community_comment_likes`、
  `community_bookmarks`。
- 限流合并：社区互动只剩举报，`enforceReportRateLimit`
  改为只按用户维度（60s/30）， 不再设 IP 维度，避免机房 NAT 下互相顶掉额度。
- UI：删除关注按钮、关注/粉丝统计、点赞与收藏按钮、「我的收藏」页、首页关注动态。
- 历史通知中的 `like` / `follow` 类型保留在类型与 CHECK 约束中，旧通知仍可显示。

## Alternatives considered

- 只保留点赞计数：仍需维护写入、限流与赛期门控，生产数据量不足以支撑。
- 默认关闭：代码、权限与限流分支依然存在，收益有限。

## Consequences

- 讨论区（帖子、评论、举报、处罚）不受影响。
- 被删除接口直接返回 404。
