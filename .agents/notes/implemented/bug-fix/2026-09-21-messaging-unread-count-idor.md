# Agent Note: 私信单会话未读数缺少参与者校验（IDOR）

Status: implemented

## Problem

`GET /api/v1/conversations/:id/unread-count` 只挂 `authMiddleware`，服务层
`getUnreadCountByConversation(userId, conversationId)`（`noj-core/src/domains/messaging/services/messages.ts`）
**没有**调用参与者校验。

当请求者不是会话参与者时，`conversation_reads` 中不存在该用户的行，
`readState` 为空，函数条件退化为

```sql
conversation_id = $1 AND sender_id <> $2
```

即统计「该会话中所有非本人发送的消息数」。任意登录用户只要拿到会话 UUID，
就能读到他/她**无权访问**的私信会话的消息总量，构成跨用户私信元数据泄露
（可枚举会话活跃度、消息规模）。

触发条件：

```
GET /api/v1/conversations/<他人会话 UUID>/unread-count
```

同文件其余读取入口（`listMessages` / `sendMessage` / `markConversationRead` /
`getMessageImageBytes` / `deleteMessage`）都使用 `assertParticipant`，本函数是
遗漏而非设计。会话 UUID 本身并非秘密（前端 URL、举报、管理接口均会暴露）。

## Decision

在 `getUnreadCountByConversation` 入口处复用共享内核
`assertParticipant(userId, conversationId)`（`services/messages-shared.ts`）。
非参与者抛 `NotFoundError("会话不存在")`，与同文件其他入口一致：既不泄露
会话是否存在，也不改变参与者路径的任何行为。

同时新增回归用例 `messages: 非参与者查询他人会话未读数被拒绝（IDOR）`，
断言第三方用户被拒、参与者计数不受影响。

## Alternatives considered

1. **在路由层做参与者校验**：拒绝。服务层才是访问控制的既有归属地
   （同文件所有其他入口都在服务层校验），放路由层会形成两套口径，且服务层
   再被其他调用方复用时仍会漏。
2. **非参与者返回 0 而不是报错**：拒绝。返回 0 会掩盖越权事实、难以审计，
   并与 `listMessages` 等入口「非参与者一律 404」的既有契约不一致。
3. **仅返回布尔未读状态（`> 0`）**：不解决越权读取本身，且改变了 API 契约。

## Consequences

- 非参与者查询他人会话未读数从「返回该会话消息总数」变为 `404`，
  属**收紧授权**的安全修复，对合法参与者无行为变化。
- 与 messaging 域其余入口的访问控制口径恢复一致，回归用例防止再次漂移。
