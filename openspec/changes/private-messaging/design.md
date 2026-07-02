## Context

Neuro OJ 目前缺少用户间私信功能。项目已有 SSE 事件总线（Redis Pub/Sub + Hono SSE 端点 + `useEventSource` composable）、PostgreSQL + Drizzle ORM、JWT 认证中间件，这些基础设施可直接复用。

用户需求为简单的 1v1 文本私信，不需要群聊、文件传输、端到端加密等专业 IM 功能。

## Goals / Non-Goals

**Goals:**
- 用户间 1v1 文本私信（发送、接收、列表）
- 会话自动创建（每对用户一个会话）
- 实时消息推送（SSE 优先，轮询降级）
- 未读计数与已读追踪
- 单用户可删除消息（仅自己视角消失）
- 导航栏未读徽标

**Non-Goals:**
- 群聊/频道
- 文件/图片发送
- 消息编辑
- 端到端加密
- 消息撤回
- 在线状态
- 联邦/跨站通信

## Decisions

| 决策 | 选择 | 替代方案 | 理由 |
|------|------|---------|------|
| 通信协议 | REST + SSE（自有协议） | Matrix/XMPP | 零额外基础设施，SSE 已就绪 |
| 会话模型 | 隐式会话：首次发消息自动创建 | 显式邀请 | 简化 UX |
| 会话去重 | UNIQUE(user1_id, user2_id) + CHECK(user1_id < user2_id) | 应用层去重 | DB 级约束最可靠 |
| 实时推送达 | 事件通知（仅推 conversation_id，不推消息内容） | 推送完整消息 | 与现有 SSE 模式一致，避免数据不一致 |
| 已读追踪 | conversation_reads 表（last_read_message_id） | 在 messages 表加 seen_at | 独立表减少 messages 表写压力 |
| 消息删除 | message_deletions 表（软删除，仅删除一方视角） | 物理删除 / 双方都删 | 尊重隐私，不覆盖对方意愿 |
| 分页方向 | created_at DESC（page=1=最新），前端反转 | 游标分页 | 与项目现有分页模式一致 |
| 消息长度限制 | 1-10000 字符 | — | 防止滥用，足够私信用途 |
| 并发会话创建 | PG UNIQUE 约束 + 冲突重查 | 分布式锁 | 简单可靠，无需额外依赖 |
| 导航栏未读数 | 定时轮询（30 秒间隔） | SSE 长连接 | SSE 生命周期随页面切换断开重建，为维持跨页持久连接需提升至 app.vue 层，复杂度高；未读数仅一个 50B 的小响应，轮询开销远小于 SSE 长连接 |

## Risks / Trade-offs

- **[Risk] Redis Pub/Sub 消息丢失**：SSE 客户端断开期间发布的消息不会重放 → **Mitigation**: 前端 polling fallback 兜底，丢失事件通过定时拉取补齐
- **[Risk] SSE 连接数增长**：每打开聊天页面的用户维持一个 SSE 长连接 → **Mitigation**: SSE 仅限聊天页面建立，导航栏未读数使用 30 秒轮询，大幅减少长连接数量。MVP 阶段可接受
- **[Trade-off] 无消息编辑/撤回**：用户发错不能回收 → 设计决策，保持简单
- **[Trade-off] 已读追踪精确性**：last_read_message_id 记录最后阅读位置，但不追踪"每条消息是否阅读" → 够用且简单
