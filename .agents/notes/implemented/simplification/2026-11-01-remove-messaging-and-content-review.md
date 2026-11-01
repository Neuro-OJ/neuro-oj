# Agent Note: 下线站内私信与第三方内容审核

Status: implemented

## Problem

站内私信（会话、消息、反应、已读、软删除、图片）与第三方内容审核（阿里云 /
腾讯云 Provider、8 个 `CONTENT_REVIEW_*` 配置、Redis `noj:review:dm`
异步队列、统一人工审查 队列）合计约 1 万行代码与测试。#698
审查时只读查询生产库：私信共 3 个会话、1 条消息， `content_review_queue` 为 0
行，生产未配置任何审核项。竞赛期间私信还存在作弊沟通风险。 内容审核消费者也是
Core 内部最后一个 Redis 列表队列。

## Decision

- core：删除 `communication/messaging` 与 `communication/review`
  两个子模块、私信与审核
  schema、管理端统一审查队列与私信举报图片端点、用户联系人搜索
  `/users/search`、私信
  发送限流、社区发帖/评论的同步审核钩子；举报只保留帖子与评论两种目标；全局搜索删除
  `message` 实体与 `search_entries.deleted_by_user_ids` 列。
- 迁移 `0130` 先清理私信举报、`message` 搜索条目、待处理的 `message` 索引任务和
  9 个配置 项，再删除 7 张表与相关列、约束。
- UI：删除私信页、聊天侧栏、用户菜单消息入口与未读轮询、用户主页“发送私信”、管理端
  内容审查页、举报页私信筛选与聊天记录。
- CI：删除 core `messaging` / `content-review` 与 E2E `messaging` 域任务。
- `community_moderation_actions` 中 `target_type='message'` 的历史记录与
  `review.*` 审计动作保留，便于查看历史。

## Alternatives considered

- 只删私信、保留内容审核：审核的另一半（社区帖子/评论同步审核）在生产同样未启用，
  保留它仍需维护 Provider、配置与审查队列。
- 默认关闭、保留代码：与几乎为零的使用量不相称，且竞赛作弊风险仍需治理。

## Consequences

- 已上传的私信图片失去引用，`storage:audit` 仍按 `message-images/`
  前缀分类，盘点时计为 孤儿，人工复核后清理。
- Redis 中残留的 `noj:review:dm*` 键可直接删除。
- 违规内容处置只剩用户举报 + 人工审核一条路径。
