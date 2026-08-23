import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError, ForbiddenError } from "../lib/errors.ts";
import { parsePagination } from "../lib/pagination.ts";
import { Channels, onEvent } from "../lib/event-bus.ts";
import { createSseStream } from "../lib/sse-stream.ts";
import {
  deleteMessage,
  findOrCreateConversation,
  getUnreadCount,
  getUnreadCountByConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
} from "../services/messages.ts";
import { getCommunityConfig } from "../services/community/community.ts";
import { enforceMessageSendRateLimit } from "../lib/hardening-rate-limit.ts";

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10_000;

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

// 所有私信端点需要认证
router.use("*", authMiddleware);
router.use("*", async (c, next) => {
  // SSE 端点例外：私信关闭时发送 feature:disabled 事件后关闭，而不是直接 403
  if (c.req.path.endsWith("/events")) return next();
  if (!getCommunityConfig().private_messaging_enabled) {
    throw new ForbiddenError("站内私信功能已关闭", "FEATURE_DISABLED");
  }
  await next();
});

/**
 * GET /api/v1/conversations
 * 会话列表（分页）。
 */
router.get("/", async (c) => {
  const userId = c.get("userId");
  const { page, perPage } = parsePagination(c);

  const result = await listConversations(userId, page, perPage);
  return c.json(result);
});

/**
 * POST /api/v1/conversations
 * 创建或查找会话。
 * Body: { other_user_id: string }
 */
router.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await parseJsonBody<{ other_user_id?: string }>(c);

  if (!body.other_user_id) {
    throw new BadRequestError("缺少对方用户 ID");
  }

  const { conversation, created } = await findOrCreateConversation(
    userId,
    body.other_user_id,
  );

  return c.json({ data: conversation }, created ? 201 : 200);
});

/**
 * GET /api/v1/conversations/unread-count
 * 用户所有会话的未读消息总数。
 */
router.get("/unread-count", async (c) => {
  const userId = c.get("userId");
  const count = await getUnreadCount(userId);
  return c.json({ unread_count: count });
});

/**
 * GET /api/v1/conversations/:id/messages
 * 会话消息列表（分页，page=1 为最新）。
 */
router.get("/:id/messages", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const { page, perPage } = parsePagination(c, { defaultPerPage: 50 });

  const result = await listMessages(userId, conversationId, page, perPage);
  return c.json(result);
});

/**
 * POST /api/v1/conversations/:id/messages
 * 发送消息。
 * Body: { content: string }
 */
router.post("/:id/messages", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const body = await parseJsonBody<{ content?: string }>(c);

  if (!body.content || body.content.trim().length === 0) {
    throw new BadRequestError("消息内容不能为空");
  }
  if (body.content.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(`消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
  }

  // NOJ-096：私信发送按用户维度限流。
  await enforceMessageSendRateLimit(userId);

  const message = await sendMessage(userId, conversationId, body.content);
  return c.json({ data: message }, 201);
});

/**
 * POST /api/v1/conversations/:id/read
 * 标记会话已读至指定消息。
 * Body: { last_read_message_id: string }
 */
router.post("/:id/read", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const body = await parseJsonBody<{ last_read_message_id?: string }>(c);

  if (!body.last_read_message_id) {
    throw new BadRequestError("缺少 last_read_message_id");
  }

  await markConversationRead(userId, conversationId, body.last_read_message_id);
  return c.body(null, 204);
});

/**
 * GET /api/v1/conversations/:id/unread-count
 * 单个会话的未读消息数。
 */
router.get("/:id/unread-count", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const count = await getUnreadCountByConversation(userId, conversationId);
  return c.json({ unread_count: count });
});

/**
 * DELETE /api/v1/conversations/:id/messages/:messageId
 * 删除消息（仅当前用户视角）。
 */
router.delete("/:id/messages/:messageId", async (c) => {
  const userId = c.get("userId");
  const messageId = c.req.param("messageId");
  await deleteMessage(userId, messageId);
  return c.body(null, 204);
});

/**
 * GET /api/v1/conversations/events
 * 私信通知 SSE 端点。
 *
 * 收到 message:new 事件后前端应拉取会话列表和未读计数。
 * SSE 事件仅作触发器，不包含消息内容。
 */
router.get("/events", (c) => {
  const userId = c.get("userId") as string;
  // 私信功能关闭：发送一次性 feature:disabled 事件后关闭连接，避免客户端反复轮询报错
  if (!getCommunityConfig().private_messaging_enabled) {
    return createSseStream(
      c,
      async ({ stream, close }) => {
        await stream.writeSSE({
          event: "feature:disabled",
          data: JSON.stringify({ message: "站内私信功能已关闭" }),
        });
        close();
      },
      { safetyTimeoutMs: 0 },
    );
  }
  // 私信端点不启用兜底超时：消息订阅为常驻连接（与原实现一致）
  return createSseStream(
    c,
    async ({ stream, closed, close, onUnsubscribe }) => {
      onUnsubscribe(
        onEvent(
          Channels.user(userId),
          (_channel, message) => {
            if (closed) return;
            stream.writeSSE({
              event: "message:new",
              data: message,
            }).catch(() => {
              close();
            });
          },
        ),
      );

      // 发送初始化事件，触发代理 flush 响应头
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ status: "connected" }),
      });
    },
    { safetyTimeoutMs: 0 },
  );
});

export default router;
