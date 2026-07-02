import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError } from "../lib/errors.ts";
import { Channels, onEvent } from "../lib/event-bus.ts";
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

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10_000;

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

// 所有私信端点需要认证
router.use("*", authMiddleware);

/**
 * GET /api/v1/conversations
 * 会话列表（分页）。
 */
router.get("/", async (c) => {
  const userId = c.get("userId");
  let page = parseInt(c.req.query("page") ?? "", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

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

  let page = parseInt(c.req.query("page") ?? "", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 50;
  if (perPage > 100) perPage = 100;

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
  return streamSSE(c, async (stream) => {
    let streamClosed = false;
    let resolveAbort: (() => void) | null = null;

    function closeStream() {
      if (streamClosed) return;
      streamClosed = true;
      clearInterval(keepAlive);
      unsub();
      if (resolveAbort) resolveAbort();
    }

    const unsub = onEvent(
      Channels.user(userId),
      (_channel, message) => {
        if (streamClosed) return;
        stream.writeSSE({
          event: "message:new",
          data: message,
        }).catch(() => {
          closeStream();
        });
      },
    );

    // 30s 心跳保持连接
    const keepAlive = setInterval(() => {
      if (streamClosed) return;
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        closeStream();
      });
    }, 30_000);

    // 发送初始化事件，触发代理 flush 响应头
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ status: "connected" }),
    });

    await new Promise<void>((resolve) => {
      resolveAbort = resolve;
      stream.onAbort(() => {
        closeStream();
      });
    });
  });
});

export default router;
