# Agent Note: 修复通知软删除目标与 LLM 配置模板漂移

Status: implemented

## Problem

LLM 配额 fallback 已由 noj-llm-gateway 消费，但 noj-core 仍在环境模板中声明，导致配置职责漂移；社区帖子和评论采用软删除，数据库外键的 `ON DELETE SET NULL` 不会触发，历史通知仍可能跳转到已删除内容并返回 404。

## Decision

从 noj-core `.env.example` 移除 LLM 配额 fallback 声明，并在帖子/评论软删除时显式清空通知的 `post_id` 与 `comment_id`，使前端能够回退到通知详情页。新增服务层回归测试覆盖两种评论删除路径与帖子删除路径。

## Alternatives considered

- 仅在前端请求目标内容后判断 404：需要额外请求，且列表页无法在跳转前可靠识别删除状态。
- 仅清空 `comment_id`：通知工具仍会依据 `post_id` 跳转帖子页，无法覆盖已删除帖子或评论的场景。
- 把 gateway 配额继续留在 core 模板：会让运维误以为修改 core 配置即可影响 gateway。

## Consequences

软删除后已有通知保留正文与时间等历史信息，但不再携带不可访问的内容目标；LLM 配额配置的唯一声明位置为 noj-llm-gateway。
