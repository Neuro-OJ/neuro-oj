# Agent Note: 修复中心化搜索整体评审 Critical 与 Important 问题

Status: implemented

## Problem

中心化搜索域合并前评审发现：旧前端页面仍消费旧搜索响应字段；E2E 断言停留在
`limit/include_total/total/items[].id`；消费者会为未知实体类型抛错重试；消息
按用户删除后仍出现在搜索结果；搜索事件发布仍阻塞主流程；竞赛索引缺少关联题目
名；`reindexAll` 先清空全表导致中断后索引为空。

## Decision

- 三个旧前端页面改为映射新 `SearchItem`（`entity_id` + `metadata`）。
- E2E 测试改为断言 `entity_id`、`metadata`、`has_more`、`per_page`。
- 消费者显式校验八种已知实体类型，未知类型仅告警并跳过。
- `search_entries` 新增 `deleted_by_user_ids`，`buildMessageEntry` 读取
  `message_deletions`，搜索权限过滤排除已删除该消息的用户。
- `publishSearchIndexEvent` 改为非阻塞发布，测试辅助轮询等待。
- `buildContestEntry` 关联查询 `contest_problems + problems` 并写入题目名。
- `reindexAll` 改为按实体增量 upsert 后仅删除 stale，避免整体清空。

## Alternatives considered

- 保留旧响应字段兼容：否决。会让新旧契约长期并存，增加维护成本。
- 消费者未知类型继续抛错重试：否决。未知类型不应污染队列或反复重试。
- `reindexAll` 保留先清空：否决。中断会留下空索引，破坏搜索可用性。

## Consequences

- 新搜索契约在旧页面与 E2E 中统一生效。
- 消息按用户删除可见性最终一致地反映到搜索索引。
- 事件发布不再等待 Redis，主流程延迟降低；测试辅助通过轮询保证断言稳定。
- 全量重建中断时旧索引仍可用。
