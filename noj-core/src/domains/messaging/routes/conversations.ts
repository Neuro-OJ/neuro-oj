import { Hono } from "hono";
import { authMiddleware } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  ForbiddenError,
} from "./../../../shared/base/errors.ts";
import { resolveUserId } from "../../identity/index.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import { Channels, onEvent } from "./../../../shared/sse/event-bus.ts";
import { createSseStream } from "./../../../shared/sse/sse-stream.ts";
import {
  addReaction,
  clearConversationMessages,
  deleteMessage,
  editMessage,
  findOrCreateConversation,
  getMessageImageBytes,
  getUnreadCount,
  getUnreadCountByConversation,
  listConversations,
  listMessages,
  markConversationRead,
  recallMessage,
  removeReaction,
  sendMessage,
  setConversationMuted,
  updateConversationRemark,
  uploadMessageImage,
} from "../services/messages.ts";
import { getCommunityConfig } from "../../community/index.ts";
import { enforceMessageSendRateLimit } from "../../system/index.ts";

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10_000;

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 全局认证中间件：所有私信端点都需要登录认证。
 * 对所有路径生效，注入 userId / userRole 到上下文。
 */
router.use("*", authMiddleware);
/**
 * 全局私信功能开关中间件。
 * 私信功能关闭时，除 SSE 端点（/events）外一律返回 403 FEATURE_DISABLED；
 * SSE 端点例外：发送 feature:disabled 事件后关闭连接，而非直接 403。
 */
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
    // 对方可能传 username，解析为 UUID（与用户主页私信入口一致）
    await resolveUserId(body.other_user_id),
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
 * Body: { content: string, type?: "text"|"image", image_url?: string,
 *         reply_to_message_id?: string, forwarded_from_message_id?: string }
 */
router.post("/:id/messages", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const body = await parseJsonBody<{
    content?: string;
    type?: "text" | "image";
    image_url?: string;
    reply_to_message_id?: string;
    forwarded_from_message_id?: string;
  }>(c);

  const type = body.type ?? "text";
  // 转发消息时内容/图片由 service 从原消息快照复制，跳过请求体校验
  if (!body.forwarded_from_message_id) {
    if (type === "text") {
      if (!body.content || body.content.trim().length === 0) {
        throw new BadRequestError("消息内容不能为空");
      }
      if (body.content.length > MAX_MESSAGE_LENGTH) {
        throw new BadRequestError(
          `消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`,
        );
      }
    } else if (type === "image") {
      if (!body.image_url) {
        throw new BadRequestError("图片消息缺少 image_url");
      }
    } else {
      throw new BadRequestError("不支持的消息类型");
    }
  }

  // NOJ-096：私信发送按用户维度限流。
  await enforceMessageSendRateLimit(userId);

  const message = await sendMessage(
    userId,
    conversationId,
    body.content ?? "",
    {
      type,
      image_url: body.image_url,
      reply_to_message_id: body.reply_to_message_id,
      forwarded_from_message_id: body.forwarded_from_message_id,
    },
  );
  return c.json({ data: message }, 201);
});

/**
 * POST /api/v1/conversations/:id/messages/images
 * 上传私信图片（multipart `file` 字段），返回存储 URL。
 * 校验 png/jpeg/webp、≤5MB、magic bytes。
 */
router.post("/:id/messages/images", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  // NOJ-096：图片上传同样按用户维度限流，防止无限上传耗尽存储
  await enforceMessageSendRateLimit(userId);
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的图片文件");
  }
  const result = await uploadMessageImage(userId, conversationId, file);
  return c.json({ data: result }, 201);
});

/**
 * GET /api/v1/conversations/:id/messages/:messageId/image
 * 读取私信图片字节流（仅会话参与者可访问）。
 * 供前端 `<img>` 展示（noj-storage:// 无法直接作为 src）。
 */
router.get("/:id/messages/:messageId/image", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const { bytes, contentType, etag } = await getMessageImageBytes(
    userId,
    conversationId,
    messageId,
  );
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=86400",
      "ETag": etag,
    },
  });
});

/**
 * POST /api/v1/conversations/:id/messages/:messageId/reactions
 * 添加/替换消息 Reaction。
 * Body: { emoji: string }（取自固定常用集合）
 */
router.post("/:id/messages/:messageId/reactions", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const body = await parseJsonBody<{ emoji?: string }>(c);
  if (!body.emoji) {
    throw new BadRequestError("缺少 emoji");
  }
  await addReaction(userId, conversationId, messageId, body.emoji);
  return c.body(null, 204);
});

/**
 * DELETE /api/v1/conversations/:id/messages/:messageId/reactions
 * 取消当前用户对消息指定 emoji 的 Reaction（幂等）。
 * Body: { emoji: string }
 */
router.delete("/:id/messages/:messageId/reactions", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const body = await parseJsonBody<{ emoji?: string }>(c);
  if (!body.emoji) {
    throw new BadRequestError("缺少 emoji");
  }
  await removeReaction(userId, conversationId, messageId, body.emoji);
  return c.body(null, 204);
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
 * PATCH /api/v1/conversations/:id/messages/:messageId
 * 编辑消息（仅发送者本人，发送后 5 分钟内，仅文本消息）。
 */
router.patch("/:id/messages/:messageId", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const body = await parseJsonBody<{ content?: string }>(c);
  if (!body.content || body.content.trim().length === 0) {
    throw new BadRequestError("消息内容不能为空");
  }
  if (body.content.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(`消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
  }
  await editMessage(userId, conversationId, messageId, body.content);
  return c.json({ data: { id: messageId, content: body.content } });
});

/**
 * POST /api/v1/conversations/:id/messages/:messageId/recall
 * 撤回消息（仅发送者本人，发送后 2 分钟内）。
 */
router.post("/:id/messages/:messageId/recall", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  await recallMessage(userId, conversationId, messageId);
  return c.json({ data: { id: messageId } });
});

/**
 * PUT /api/v1/conversations/:id/remark
 * 设置会话备注名（仅当前用户视角）。
 * Body: { remark_name: string }（空字符串清除备注）
 */
router.put("/:id/remark", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const body = await parseJsonBody<{ remark_name?: string }>(c);
  const data = await updateConversationRemark(
    userId,
    conversationId,
    body.remark_name ?? "",
  );
  return c.json({ data });
});

/**
 * PUT /api/v1/conversations/:id/mute
 * 设置会话消息免打扰（仅当前用户视角）。
 * Body: { is_muted: boolean }
 */
router.put("/:id/mute", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const body = await parseJsonBody<{ is_muted?: boolean }>(c);
  const data = await setConversationMuted(
    userId,
    conversationId,
    body.is_muted ?? false,
  );
  return c.json({ data });
});

/**
 * POST /api/v1/conversations/:id/clear
 * 清空聊天记录（仅对当前用户隐藏，不实际删除消息）。
 */
router.post("/:id/clear", async (c) => {
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const data = await clearConversationMessages(userId, conversationId);
  return c.json({ data });
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
            // 透传 payload 的 type 作为 SSE event 名（message:new / message:edited / message:recalled）
            let eventName = "message:new";
            try {
              const parsed = JSON.parse(message);
              if (typeof parsed?.type === "string") eventName = parsed.type;
            } catch {
              // 非 JSON 仍按默认事件名
            }
            stream.writeSSE({
              event: eventName,
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
