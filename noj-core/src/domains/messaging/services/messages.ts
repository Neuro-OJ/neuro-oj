import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  conversationPreferences,
  conversationReads,
  conversations,
  messageDeletions,
  messageReactions,
  messages,
  userBans,
  users,
} from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
import { getStorageProvider } from "./../../system/index.ts";
import { isStorageUrl, parseStorageUrl } from "./../../system/index.ts";
import { validateImageFile } from "./../../../shared/security/image-validation.ts";
import { logger } from "./../../../shared/base/logging.ts";
import { enqueueDmMessageReview } from "../../content-review/index.ts";

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10_000;
/** 消息预览截断长度 */
const PREVIEW_LENGTH = 50;
/** 私信图片大小上限（5MB） */
export const MAX_MESSAGE_IMAGE_SIZE = 5 * 1024 * 1024;

/** 常用 Reaction emoji 集合（配置化常量，后期扩展只需改这里） */
export const REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🙏",
  "🎉",
  "🔥",
  "👏",
  "😍",
  "🤔",
  "😅",
  "💯",
  "👀",
  "😭",
  "🤯",
  "🥳",
  "😎",
  "🤝",
  "💪",
] as const;

/** 发送消息的扩展选项 */
export interface SendMessageOptions {
  /** 消息类型：text（默认）| image */
  type?: "text" | "image";
  /** 图片消息的存储 URL（type=image 时必填） */
  image_url?: string;
  /** 引用回复：被引用的消息 ID（须同会话） */
  reply_to_message_id?: string;
  /** 转发：原消息 ID（须为转发者参与会话内的消息） */
  forwarded_from_message_id?: string;
}

/** 统一 postgres.js（array-like）与 PGlite（{rows}）的 execute 返回形态。 */
function executeRows<T>(result: T[] | { rows: T[] }): T[] {
  return Array.isArray(result) ? result : result.rows;
}

/**
 * 查找或创建与另一用户的会话。
 *
 * 每个用户对仅存在一个会话，通过 UNIQUE(user1_id, user2_id) 约束保证。
 * 当并发创建时（两个用户同时请求），捕获 PG 23505 冲突后重新查询已有会话。
 *
 * @param userId 当前用户 ID
 * @param otherUserId 对方用户 ID
 * @returns 会话对象
 */
export async function findOrCreateConversation(
  userId: string,
  otherUserId: string,
): Promise<
  { conversation: typeof conversations.$inferSelect; created: boolean }
> {
  // 拒绝自聊
  if (userId === otherUserId) {
    throw new BadRequestError("无法与自己创建会话");
  }

  // 社交封禁用户不可私聊
  await assertNotSocialBanned(userId);

  // 校验对方用户存在
  const [otherUser] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, otherUserId))
    .limit(1);

  if (!otherUser) {
    throw new NotFoundError("用户不存在");
  }

  // 规范化排序：确保 user1_id < user2_id
  const [user1Id, user2Id] = [userId, otherUserId].sort();

  // 查询已有会话
  const [existing] = await getDb()
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.user1_id, user1Id),
        eq(conversations.user2_id, user2Id),
      ),
    )
    .limit(1);

  if (existing) return { conversation: existing, created: false };

  // 创建新会话
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    user1_id: user1Id,
    user2_id: user2Id,
    last_message_at: now,
    created_at: now,
  };

  try {
    await getDb().insert(conversations).values(conversation);
    return { conversation, created: true };
  } catch (err: unknown) {
    // 并发创建冲突（PG 23505），返回已有会话
    if (
      err && typeof err === "object" && "code" in err && err.code === "23505"
    ) {
      const [existingAfterConflict] = await getDb()
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.user1_id, user1Id),
            eq(conversations.user2_id, user2Id),
          ),
        )
        .limit(1);

      if (existingAfterConflict) {
        return { conversation: existingAfterConflict, created: false };
      }
    }
    throw err;
  }
}

/**
 * 校验用户是否为会话参与者。
 *
 * @returns 会话信息和对方用户 ID
 */
async function assertParticipant(
  userId: string,
  conversationId: string,
): Promise<
  { conversation: typeof conversations.$inferSelect; otherUserId: string }
> {
  const [conv] = await getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conv) throw new NotFoundError("会话不存在");

  if (conv.user1_id === userId) {
    return { conversation: conv, otherUserId: conv.user2_id };
  }
  if (conv.user2_id === userId) {
    return { conversation: conv, otherUserId: conv.user1_id };
  }
  throw new NotFoundError("会话不存在");
}

/**
 * 社交封禁校验：social 封禁用户不可私聊（发送/创建会话均拦截）。
 * 私信属于社交行为，与社区发布同属 social 限制范围。
 */
async function assertNotSocialBanned(userId: string): Promise<void> {
  const [ban] = await getDb()
    .select({
      reason: userBans.reason,
      scope: userBans.scope,
      banned_until: userBans.banned_until,
    })
    .from(userBans)
    .where(
      and(eq(userBans.user_id, userId), sql`${userBans.unbanned_at} IS NULL`),
    )
    .orderBy(desc(userBans.banned_at))
    .limit(1);
  if (
    ban && (!ban.banned_until || ban.banned_until > new Date().toISOString())
  ) {
    throw new BadRequestError(
      ban.scope === "social"
        ? "你已被限制社交功能，无法私聊"
        : "账号已被封禁，无法私聊",
      "USER_BANNED",
    );
  }
}

/**
 * 发送消息。
 *
 * 校验发送者是会话参与者后，写入消息并更新会话最后消息时间。
 * 通过 Redis Pub/Sub 推送通知给接收方。
 *
 * 支持扩展选项：
 * - type=image：图片消息（image_url 必填）
 * - reply_to_message_id：引用回复（须同会话内消息）
 * - forwarded_from_message_id：转发（原消息须为转发者参与会话内的消息，
 *   快照复制内容/图片，记录来源用户）
 *
 * @param userId 发送者 ID
 * @param conversationId 会话 ID
 * @param content 消息内容（1-10000 字符；图片消息可为空字符串）
 * @param options 扩展选项
 * @returns 创建的消息对象
 */
export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
  options: SendMessageOptions = {},
) {
  let type = options.type ?? "text";
  const imageUrl = options.image_url;
  const replyToMessageId = options.reply_to_message_id;
  const forwardedFromMessageId = options.forwarded_from_message_id;

  // 社交封禁用户不可私聊
  await assertNotSocialBanned(userId);

  const { otherUserId } = await assertParticipant(userId, conversationId);

  // 引用回复：被引用消息必须存在于同一会话
  if (replyToMessageId) {
    const [replyMsg] = await getDb()
      .select({
        conversation_id: messages.conversation_id,
        recalled_at: messages.recalled_at,
      })
      .from(messages)
      .where(eq(messages.id, replyToMessageId))
      .limit(1);
    if (!replyMsg || replyMsg.conversation_id !== conversationId) {
      throw new BadRequestError("引用的消息不存在或不属于该会话");
    }
    if (replyMsg.recalled_at) {
      throw new BadRequestError("已撤回的消息不可引用");
    }
  }

  // 转发：原消息必须存在且转发者是原会话参与者（可信性校验）
  let forwardedFromUserId: string | null = null;
  let forwardedContent = content;
  let forwardedImageUrl: string | null = imageUrl ?? null;
  if (forwardedFromMessageId) {
    const [srcMsg] = await getDb()
      .select({
        conversation_id: messages.conversation_id,
        sender_id: messages.sender_id,
        content: messages.content,
        type: messages.type,
        image_url: messages.image_url,
        forwarded_from_user_id: messages.forwarded_from_user_id,
        recalled_at: messages.recalled_at,
      })
      .from(messages)
      .where(eq(messages.id, forwardedFromMessageId))
      .limit(1);
    if (!srcMsg) {
      throw new BadRequestError("转发的消息不存在");
    }
    if (srcMsg.recalled_at) {
      throw new BadRequestError("已撤回的消息不可转发");
    }
    // 转发者必须是原消息所在会话的参与者
    await assertParticipant(userId, srcMsg.conversation_id);
    // 若原消息本身已是转发消息，保留其原始来源；否则记录原消息发送者
    forwardedFromUserId = srcMsg.forwarded_from_user_id ?? srcMsg.sender_id;
    // 快照复制原消息内容/图片/类型（转发图片消息时 type 必须同步为 image）
    forwardedContent = srcMsg.content;
    forwardedImageUrl = srcMsg.image_url;
    type = srcMsg.type as "text" | "image";
  }

  // 防御性校验 — 路由层已校验，service 层再加一道防止绕过
  if (type === "text") {
    if (!forwardedContent || forwardedContent.trim().length === 0) {
      throw new BadRequestError("消息内容不能为空");
    }
    if (forwardedContent.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestError(`消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
    }
  } else if (type === "image") {
    if (!forwardedImageUrl) {
      throw new BadRequestError("图片消息缺少 image_url");
    }
    // 仅接受平台存储 URL（provider + key 完整校验），拒绝外部链接/data:/伪造 provider 注入
    if (!isStorageUrl(forwardedImageUrl)) {
      throw new BadRequestError("图片消息 image_url 格式不合法");
    }
    const parsed = parseStorageUrl(forwardedImageUrl);
    if (parsed.provider !== "local" && parsed.provider !== "s3") {
      throw new BadRequestError("图片消息 image_url 格式不合法");
    }
    if (!parsed.key) {
      throw new BadRequestError("图片消息 image_url 格式不合法");
    }
  } else {
    throw new BadRequestError("不支持的消息类型");
  }

  const now = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    sender_id: userId,
    type,
    image_url: forwardedImageUrl ?? null,
    reply_to_message_id: replyToMessageId ?? null,
    forwarded_from_user_id: forwardedFromUserId,
    content: forwardedContent,
    created_at: now,
  };

  // 消息写入和会话更新时间放在同一事务，防止数据不一致
  await getDb().transaction(async (tx) => {
    await tx.insert(messages).values(message);
    await tx
      .update(conversations)
      .set({ last_message_at: now })
      .where(eq(conversations.id, conversationId));
  });
  // 写入 SSE 事件日志并发布 Redis 通知
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:new",
      conversation_id: conversationId,
      sender_id: userId,
    },
  );

  // 异步内容合规送审（issue #413）：仅文本消息送审；不阻塞发送路径
  if (type === "text") {
    await enqueueDmMessageReview({
      message_id: message.id,
      conversation_id: conversationId,
      sender_id: userId,
      content: forwardedContent,
      created_at: now,
    }).catch((err) => {
      // 入队内部已捕获异常；此处兜底避免任何意外阻断消息发送
      logger.warn("[content-review] 私信送审入队兜底失败", { err });
    });
  }

  return message;
}

/**
 * 上传私信图片并返回存储 URL。
 *
 * 校验 png/jpeg/webp、≤5MB、magic bytes（复用公共图片校验）。
 * 存储 key 带会话与随机后缀，避免内容寻址冲突。
 *
 * @param userId 上传者 ID（须为会话参与者）
 * @param conversationId 会话 ID
 * @param file 图片文件
 * @returns 存储 URL（noj-storage://）
 */
export async function uploadMessageImage(
  userId: string,
  conversationId: string,
  file: File,
): Promise<{ image_url: string }> {
  // 社交封禁用户不可上传私信图片（与发送消息一致）
  await assertNotSocialBanned(userId);
  await assertParticipant(userId, conversationId);
  const { bytes, type } = await validateImageFile(
    file,
    MAX_MESSAGE_IMAGE_SIZE,
    "5MB",
  );
  const provider = await getStorageProvider();
  const ext = type === "png" ? "png" : type === "webp" ? "webp" : "jpg";
  const imageUrl = await provider.put(
    `message-images/${conversationId}/${crypto.randomUUID()}.${ext}`,
    bytes,
    type === "png"
      ? "image/png"
      : type === "webp"
      ? "image/webp"
      : "image/jpeg",
  );
  return { image_url: imageUrl };
}

/**
 * 获取用户的会话列表（分页）。
 *
 * 每个会话项包含对方用户名、最后消息预览、未读数。
 * 如果对方用户已被删除，用户名显示为"已注销用户"。
 *
 * @param userId 当前用户 ID
 * @param page 页码（从 1 开始）
 * @param perPage 每页条数（默认 20，最大 100）
 */
export async function listConversations(
  userId: string,
  page: number,
  perPage: number,
) {
  const offset = (page - 1) * perPage;

  // 查询用户参与的所有会话
  const rows = await getDb()
    .select({
      id: conversations.id,
      user1_id: conversations.user1_id,
      user2_id: conversations.user2_id,
      last_message_at: conversations.last_message_at,
      created_at: conversations.created_at,
    })
    .from(conversations)
    .where(
      or(
        eq(conversations.user1_id, userId),
        eq(conversations.user2_id, userId),
      ),
    )
    .orderBy(desc(conversations.last_message_at))
    .limit(perPage)
    .offset(offset);

  if (rows.length === 0) {
    return {
      data: [],
      pagination: { page, per_page: perPage, total: 0, total_pages: 0 },
    };
  }

  // 收集所有参与方用户 ID（排除当前用户）
  const otherUserIds = rows.map((r) =>
    r.user1_id === userId ? r.user2_id : r.user1_id
  );

  // 批量查询对方用户信息
  const otherUsers = await getDb()
    .select({
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(or(...otherUserIds.map((id) => eq(users.id, id))));

  const userMap = new Map(otherUsers.map((u) => [u.id, u.username]));
  const userAvatarMap = new Map(
    otherUsers.map((u) => [u.id, u.avatar_url]),
  );

  // 查询每个会话的最后一条消息预览。
  // NOJ-082：使用 DISTINCT ON 一次取每会话最新消息，避免拉全量消息再 JS 去重。
  const convIds = rows.map((r) => r.id);
  const lastMessageResult = await getDb().execute<{
    conversation_id: string;
    content: string;
    type: string;
    recalled_at: string | null;
  }>(sql`
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      m.content,
      m.type,
      m.recalled_at
    FROM messages m
    LEFT JOIN message_deletions md
      ON md.message_id = m.id
     AND md.user_id = ${userId}
    WHERE m.conversation_id IN (${
    sql.join(convIds.map((id) => sql`${id}`), sql`, `)
  })
      AND md.user_id IS NULL
    ORDER BY m.conversation_id, m.created_at DESC
  `);
  const lastMsgMap = new Map<string, string>();
  for (const msg of executeRows(lastMessageResult)) {
    // 已撤回消息预览显示 [已撤回]（不泄露内容）
    const preview = msg.recalled_at
      ? "[已撤回]"
      : msg.type === "image"
      ? "[图片]"
      : msg.content.length > PREVIEW_LENGTH
      ? msg.content.slice(0, PREVIEW_LENGTH) + "..."
      : msg.content;
    lastMsgMap.set(msg.conversation_id, preview);
  }

  // NOJ-081：一次聚合查询计算所有会话未读数，消除 N+1。
  const unreadResult = await getDb().execute<{
    conversation_id: string;
    unread: string;
  }>(sql`
    SELECT m.conversation_id,
           count(*)::text AS unread
    FROM messages m
    LEFT JOIN conversation_reads cr
      ON cr.conversation_id = m.conversation_id
     AND cr.user_id = ${userId}
    LEFT JOIN messages lr
      ON lr.id = cr.last_read_message_id
    LEFT JOIN message_deletions md
      ON md.message_id = m.id
     AND md.user_id = ${userId}
    WHERE m.conversation_id IN (${
    sql.join(convIds.map((id) => sql`${id}`), sql`, `)
  })
      AND m.sender_id <> ${userId}
      AND md.user_id IS NULL
      AND (lr.id IS NULL OR m.created_at > lr.created_at)
    GROUP BY m.conversation_id
  `);
  const unreadMap = new Map<string, number>();
  for (const row of executeRows(unreadResult)) {
    unreadMap.set(row.conversation_id, Number(row.unread));
  }

  // 批量查询会话偏好（备注名/免打扰）
  const prefsResult = convIds.length > 0
    ? await getDb()
      .select({
        conversation_id: conversationPreferences.conversation_id,
        remark_name: conversationPreferences.remark_name,
        is_muted: conversationPreferences.is_muted,
      })
      .from(conversationPreferences)
      .where(
        and(
          eq(conversationPreferences.user_id, userId),
          inArray(conversationPreferences.conversation_id, convIds),
        ),
      )
    : [];
  const prefsMap = new Map<
    string,
    { remark_name: string | null; is_muted: boolean }
  >();
  for (const p of prefsResult) {
    prefsMap.set(p.conversation_id, {
      remark_name: p.remark_name,
      is_muted: p.is_muted,
    });
  }

  // 组装响应
  const data = rows.map((r) => {
    const otherUserId = r.user1_id === userId ? r.user2_id : r.user1_id;
    const pref = prefsMap.get(r.id);
    return {
      id: r.id,
      other_user_id: otherUserId,
      other_user_name: userMap.get(otherUserId) ?? "已注销用户",
      other_user_avatar_url: userAvatarMap.get(otherUserId) ?? null,
      last_message_preview: lastMsgMap.get(r.id) ?? "",
      last_message_at: r.last_message_at,
      unread_count: unreadMap.get(r.id) ?? 0,
      remark_name: pref?.remark_name ?? null,
      is_muted: pref?.is_muted ?? false,
      created_at: r.created_at,
    };
  });

  // 查询总数
  const [countRow] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(conversations)
    .where(
      or(
        eq(conversations.user1_id, userId),
        eq(conversations.user2_id, userId),
      ),
    );
  const total = Number(countRow?.total ?? 0);

  return {
    data,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.ceil(total / perPage),
    },
  };
}

/**
 * 获取会话的消息列表（分页）。
 *
 * 按 created_at DESC 排序（page=1 为最新页），前端反转显示。
 * 排除当前用户已删除的消息。
 *
 * 每条消息响应扩展：
 * - type / image_url：消息类型与图片 URL
 * - reply_to：被引用消息摘要（发送者 + 内容/图片标记）
 * - forwarded_from_user：转发来源用户（id + username）
 * - reactions：聚合的 emoji 计数 + 当前用户是否已点
 * - read：对方是否已读（由 conversation_reads 推导）
 *
 * @param userId 当前用户 ID
 * @param conversationId 会话 ID
 * @param page 页码（从 1 开始）
 * @param perPage 每页条数
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  page: number,
  perPage: number,
) {
  // 校验参与者
  const { otherUserId } = await assertParticipant(userId, conversationId);

  const offset = (page - 1) * perPage;

  // 查询总数（排除已删除）
  const [countRow] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(messages)
    .leftJoin(
      messageDeletions,
      and(
        eq(messageDeletions.message_id, messages.id),
        eq(messageDeletions.user_id, userId),
      ),
    )
    .where(
      and(
        eq(messages.conversation_id, conversationId),
        // 排除当前用户已删除的消息
        sql`${messageDeletions.user_id} IS NULL`,
      ),
    );
  const total = Number(countRow?.total ?? 0);

  if (total === 0) {
    return {
      data: [],
      pagination: { page, per_page: perPage, total, total_pages: 0 },
    };
  }

  // 查询消息
  const rows = await getDb()
    .select({
      id: messages.id,
      sender_id: messages.sender_id,
      type: messages.type,
      image_url: messages.image_url,
      reply_to_message_id: messages.reply_to_message_id,
      forwarded_from_user_id: messages.forwarded_from_user_id,
      content: messages.content,
      created_at: messages.created_at,
      edited_at: messages.edited_at,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .leftJoin(
      messageDeletions,
      and(
        eq(messageDeletions.message_id, messages.id),
        eq(messageDeletions.user_id, userId),
      ),
    )
    .where(
      and(
        eq(messages.conversation_id, conversationId),
        sql`${messageDeletions.user_id} IS NULL`,
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(perPage)
    .offset(offset);

  const msgIds = rows.map((r) => r.id);

  // ── 批量查询被引用消息摘要（reply_to）────────────────────────
  const replyIds = rows
    .map((r) => r.reply_to_message_id)
    .filter((id): id is string => !!id);
  const replyMap = new Map<
    string,
    { sender_id: string; sender_name: string; content: string; type: string }
  >();
  if (replyIds.length > 0) {
    const replyRows = await getDb()
      .select({
        id: messages.id,
        sender_id: messages.sender_id,
        content: messages.content,
        type: messages.type,
        recalled_at: messages.recalled_at,
      })
      .from(messages)
      .where(inArray(messages.id, replyIds));
    const replySenderIds = [...new Set(replyRows.map((r) => r.sender_id))];
    const replySenders = replySenderIds.length > 0
      ? await getDb()
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, replySenderIds))
      : [];
    const replySenderMap = new Map(
      replySenders.map((u) => [u.id, u.username]),
    );
    for (const r of replyRows) {
      replyMap.set(r.id, {
        sender_id: r.sender_id,
        sender_name: replySenderMap.get(r.sender_id) ?? "已注销用户",
        content: r.recalled_at ? "该消息已撤回" : r.content,
        type: r.type,
      });
    }
  }

  // ── 批量查询转发来源用户（forwarded_from_user）────────────────
  const fwdUserIds = rows
    .map((r) => r.forwarded_from_user_id)
    .filter((id): id is string => !!id);
  const fwdUserMap = new Map<string, string>();
  if (fwdUserIds.length > 0) {
    const fwdUsers = await getDb()
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...new Set(fwdUserIds)]));
    for (const u of fwdUsers) fwdUserMap.set(u.id, u.username);
  }

  // ── 批量聚合 reactions ───────────────────────────────────────
  // 每项含操作人列表（users），供前端展示操作人头像
  const reactionsMap = new Map<
    string,
    {
      emoji: string;
      count: number;
      reacted_by_me: boolean;
      users: { id: string; username: string; avatar_url: string | null }[];
    }[]
  >();
  if (msgIds.length > 0) {
    const reactionRows = await getDb()
      .select({
        message_id: messageReactions.message_id,
        user_id: messageReactions.user_id,
        emoji: messageReactions.emoji,
      })
      .from(messageReactions)
      .where(inArray(messageReactions.message_id, msgIds));
    // 批量查询 reaction 操作人信息
    const reactorIds = [...new Set(reactionRows.map((r) => r.user_id))];
    const reactors = reactorIds.length > 0
      ? await getDb()
        .select({
          id: users.id,
          username: users.username,
          avatar_url: users.avatar_url,
        })
        .from(users)
        .where(inArray(users.id, reactorIds))
      : [];
    const reactorMap = new Map(reactors.map((u) => [u.id, u]));
    for (const r of reactionRows) {
      const list = reactionsMap.get(r.message_id) ?? [];
      const existing = list.find((e) => e.emoji === r.emoji);
      const reactor = reactorMap.get(r.user_id);
      if (existing) {
        existing.count += 1;
        if (r.user_id === userId) existing.reacted_by_me = true;
        if (reactor) {
          existing.users.push({
            id: reactor.id,
            username: reactor.username,
            avatar_url: reactor.avatar_url,
          });
        }
      } else {
        list.push({
          emoji: r.emoji,
          count: 1,
          reacted_by_me: r.user_id === userId,
          users: reactor
            ? [{
              id: reactor.id,
              username: reactor.username,
              avatar_url: reactor.avatar_url,
            }]
            : [],
        });
      }
      reactionsMap.set(r.message_id, list);
    }
  }

  // ── 对方已读位置（read 推导）──────────────────────────────────
  const [otherRead] = await getDb()
    .select({ last_read_message_id: conversationReads.last_read_message_id })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.user_id, otherUserId),
        eq(conversationReads.conversation_id, conversationId),
      ),
    )
    .limit(1);
  let otherReadAt: string | null = null;
  if (otherRead?.last_read_message_id) {
    const [readMsg] = await getDb()
      .select({ created_at: messages.created_at })
      .from(messages)
      .where(eq(messages.id, otherRead.last_read_message_id))
      .limit(1);
    otherReadAt = readMsg?.created_at ?? null;
  }

  // ── 组装响应 ───────────────────────────────────────────────────
  const data = rows.map((r) => {
    const reply = r.reply_to_message_id
      ? replyMap.get(r.reply_to_message_id)
      : undefined;
    const fwdUserId = r.forwarded_from_user_id;
    return {
      id: r.id,
      sender_id: r.sender_id,
      type: r.type,
      image_url: r.recalled_at ? null : r.image_url,
      content: r.recalled_at ? "该消息已撤回" : r.content,
      created_at: r.created_at,
      edited_at: r.edited_at,
      recalled_at: r.recalled_at,
      reply_to: reply
        ? {
          message_id: r.reply_to_message_id,
          sender_id: reply.sender_id,
          sender_name: reply.sender_name,
          content: reply.content,
          type: reply.type,
        }
        : null,
      forwarded_from_user: fwdUserId
        ? { id: fwdUserId, username: fwdUserMap.get(fwdUserId) ?? "已注销用户" }
        : null,
      reactions: (reactionsMap.get(r.id) ?? []).sort((a, b) =>
        b.count - a.count
      ),
      // 自己发送的消息：对方已读位置越过该消息即视为已读
      read: r.sender_id === userId
        ? !!(otherReadAt && r.created_at <= otherReadAt)
        : null,
    };
  });

  return {
    data,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.ceil(total / perPage),
    },
  };
}

/**
 * 标记会话已读至指定消息。
 *
 * 使用 UPSERT 语义，首次创建记录，后续更新位置。
 *
 * @param userId 当前用户 ID
 * @param conversationId 会话 ID
 * @param lastReadMessageId 最后阅读的消息 ID
 */
export async function markConversationRead(
  userId: string,
  conversationId: string,
  lastReadMessageId: string,
) {
  await assertParticipant(userId, conversationId);
  // 校验已读位置消息属于该会话，防止跨会话污染已读状态
  const [msg] = await getDb()
    .select({ conversation_id: messages.conversation_id })
    .from(messages)
    .where(eq(messages.id, lastReadMessageId))
    .limit(1);
  if (!msg || msg.conversation_id !== conversationId) {
    throw new BadRequestError("已读位置消息不存在或不属于该会话");
  }
  const now = new Date().toISOString();

  await getDb()
    .insert(conversationReads)
    .values({
      user_id: userId,
      conversation_id: conversationId,
      last_read_message_id: lastReadMessageId,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [conversationReads.user_id, conversationReads.conversation_id],
      set: {
        last_read_message_id: lastReadMessageId,
        updated_at: now,
      },
    });

  // 通知会话另一方刷新已读状态（对方页面即时显示"已读"）
  const { otherUserId } = await assertParticipant(userId, conversationId);
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:read",
      conversation_id: conversationId,
      reader_id: userId,
      last_read_message_id: lastReadMessageId,
    },
  );
}

/**
 * 读取私信图片字节与元数据。
 *
 * 校验请求者是图片消息所在会话的参与者后，从存储读取字节。
 * 供前端 `<img>` 展示（`noj-storage://` 无法直接作为 src）。
 *
 * @param userId 请求者 ID
 * @param conversationId 会话 ID（须与消息所在会话一致）
 * @param messageId 图片消息 ID
 * @returns 图片字节、Content-Type、ETag
 */
export async function getMessageImageBytes(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const [msg] = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      type: messages.type,
      image_url: messages.image_url,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .leftJoin(
      messageDeletions,
      and(
        eq(messageDeletions.message_id, messages.id),
        eq(messageDeletions.user_id, userId),
      ),
    )
    .where(
      and(
        eq(messages.id, messageId),
        // 排除当前用户已软删除的消息
        sql`${messageDeletions.user_id} IS NULL`,
      ),
    )
    .limit(1);
  if (!msg || msg.type !== "image" || !msg.image_url) {
    throw new NotFoundError("图片消息不存在");
  }
  if (msg.recalled_at) {
    throw new NotFoundError("图片消息不存在");
  }
  // 消息必须属于 URL 中的会话，且请求者是参与者
  if (msg.conversation_id !== conversationId) {
    throw new NotFoundError("图片消息不存在");
  }
  await assertParticipant(userId, msg.conversation_id);

  const provider = await getStorageProvider();
  const bytes = await provider.get(msg.image_url);
  const parsed = parseStorageUrl(msg.image_url);
  const contentType = /\.png$/i.test(parsed.key)
    ? "image/png"
    : /\.webp$/i.test(parsed.key)
    ? "image/webp"
    : "image/jpeg";
  const etag = parsed.checksumSha256
    ? `"${parsed.checksumSha256}"`
    : `"${parsed.key}"`;
  return { bytes, contentType, etag };
}

/**
 * 获取用户所有会话的未读消息总数（用于导航栏徽标）。
 */
export async function getUnreadCount(userId: string): Promise<number> {
  // NOJ-081：单条 SQL 聚合用户所有会话的未读数，替代「逐会话查询」N+1。
  const result = await getDb().execute<{ total: string }>(sql`
    SELECT count(*)::text AS total
    FROM messages m
    JOIN conversations c
      ON c.id = m.conversation_id
    LEFT JOIN conversation_reads cr
      ON cr.conversation_id = m.conversation_id
     AND cr.user_id = ${userId}
    LEFT JOIN messages lr
      ON lr.id = cr.last_read_message_id
    LEFT JOIN message_deletions md
      ON md.message_id = m.id
     AND md.user_id = ${userId}
    WHERE (c.user1_id = ${userId} OR c.user2_id = ${userId})
      AND m.sender_id <> ${userId}
      AND md.user_id IS NULL
      AND (lr.id IS NULL OR m.created_at > lr.created_at)
  `);
  const rows = executeRows(result);
  return Number(rows[0]?.total ?? 0);
}

/**
 * 获取指定会话的未读消息数。
 */
export async function getUnreadCountByConversation(
  userId: string,
  conversationId: string,
): Promise<number> {
  // 查询当前用户的已读位置
  const [readState] = await getDb()
    .select({ last_read_message_id: conversationReads.last_read_message_id })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.user_id, userId),
        eq(conversationReads.conversation_id, conversationId),
      ),
    )
    .limit(1);

  // 构建查询：计数该会话中创建时间 > 已读位置的消息（排除自己发送的）
  let conditions = and(
    eq(messages.conversation_id, conversationId),
    sql`${messages.sender_id} <> ${userId}`,
  )!;

  if (readState?.last_read_message_id) {
    // 查询已读消息的 created_at，然后计数之后的消息
    const [lastReadMsg] = await getDb()
      .select({ created_at: messages.created_at })
      .from(messages)
      .where(eq(messages.id, readState.last_read_message_id!))
      .limit(1);

    if (lastReadMsg) {
      conditions = and(
        conditions,
        gt(messages.created_at, lastReadMsg.created_at),
      )!;
    }
  }

  // 排除已删除消息
  const [countRow] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(messages)
    .leftJoin(
      messageDeletions,
      and(
        eq(messageDeletions.message_id, messages.id),
        eq(messageDeletions.user_id, userId),
      ),
    )
    .where(
      and(
        conditions,
        sql`${messageDeletions.user_id} IS NULL`,
      ),
    );

  return Number(countRow?.total ?? 0);
}

/**
 * 删除消息（软删除，仅当前用户视角）。
 *
 * 在 message_deletions 表插入记录，原始消息保留（对方仍可见）。
 */
export async function deleteMessage(
  userId: string,
  messageId: string,
) {
  // 校验消息存在（且用户是会话参与者——通过 assertParticipant 校验）
  const [msg] = await getDb()
    .select({ conversation_id: messages.conversation_id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!msg) throw new NotFoundError("消息不存在");

  // 校验会话参与者
  await assertParticipant(userId, msg.conversation_id);

  const now = new Date().toISOString();
  await getDb()
    .insert(messageDeletions)
    .values({
      user_id: userId,
      message_id: messageId,
      deleted_at: now,
    })
    .onConflictDoNothing();
}

/**
 * 添加/替换消息 Reaction。
 *
 * 同一用户对同一消息仅保留一个 reaction（复合主键 UPSERT 语义），
 * 重复提交替换为新的 emoji。emoji 必须取自固定常用集合。
 *
 * @param userId 当前用户 ID
 * @param messageId 消息 ID
 * @param emoji 表情符号
 */
export async function addReaction(
  userId: string,
  conversationId: string,
  messageId: string,
  emoji: string,
) {
  if (!(REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    throw new BadRequestError("不支持的表情");
  }
  // 校验消息存在、属于该会话且用户是会话参与者
  const [msg] = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg || msg.conversation_id !== conversationId) {
    throw new NotFoundError("消息不存在");
  }
  if (msg.recalled_at) {
    throw new BadRequestError("已撤回的消息不可操作");
  }
  await assertParticipant(userId, msg.conversation_id);

  const now = new Date().toISOString();
  await getDb()
    .insert(messageReactions)
    .values({
      message_id: messageId,
      user_id: userId,
      emoji,
      created_at: now,
    })
    .onConflictDoUpdate({
      // 主键 (message_id, user_id, emoji)：同一用户可对不同 emoji 分别 upsert
      target: [
        messageReactions.message_id,
        messageReactions.user_id,
        messageReactions.emoji,
      ],
      set: { emoji, created_at: now },
    });

  // 通知对方刷新 reaction
  const { otherUserId } = await assertParticipant(userId, msg.conversation_id);
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:reaction",
      conversation_id: msg.conversation_id,
      message_id: messageId,
      user_id: userId,
      emoji,
    },
  );
}

/**
 * 取消当前用户对消息的 Reaction（幂等）。
 *
 * @param userId 当前用户 ID
 * @param conversationId 会话 ID（须与消息所在会话一致）
 * @param messageId 消息 ID
 */
export async function removeReaction(
  userId: string,
  conversationId: string,
  messageId: string,
  emoji: string,
) {
  // 校验消息存在、属于该会话且用户是会话参与者
  const [msg] = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg || msg.conversation_id !== conversationId) {
    throw new NotFoundError("消息不存在");
  }
  if (msg.recalled_at) {
    throw new BadRequestError("已撤回的消息不可操作");
  }
  await assertParticipant(userId, msg.conversation_id);

  await getDb()
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.message_id, messageId),
        eq(messageReactions.user_id, userId),
        eq(messageReactions.emoji, emoji),
      ),
    );

  // 通知对方刷新 reaction
  const { otherUserId } = await assertParticipant(userId, msg.conversation_id);
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:reaction",
      conversation_id: msg.conversation_id,
      message_id: messageId,
      user_id: userId,
      emoji,
    },
  );
}

/** 编辑时间窗口（毫秒）：发送后 5 分钟内可编辑 */
const EDIT_WINDOW_MS = 5 * 60 * 1000;
/** 撤回时间窗口（毫秒）：发送后 2 分钟内可撤回 */
const RECALL_WINDOW_MS = 2 * 60 * 1000;

/**
 * 编辑消息（仅发送者本人，发送后 5 分钟内，仅文本消息）。
 *
 * 编辑历史保存在 edit_history（JSON 数组），不对外展示。
 *
 * @param userId 当前用户 ID
 * @param conversationId 会话 ID
 * @param messageId 消息 ID
 * @param content 新内容
 */
export async function editMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
) {
  const [msg] = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      sender_id: messages.sender_id,
      type: messages.type,
      content: messages.content,
      created_at: messages.created_at,
      edit_history: messages.edit_history,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg || msg.conversation_id !== conversationId) {
    throw new NotFoundError("消息不存在");
  }
  if (msg.sender_id !== userId) {
    throw new BadRequestError("只能编辑自己发送的消息");
  }
  if (msg.type !== "text") {
    throw new BadRequestError("仅文本消息可编辑");
  }
  if (msg.recalled_at) {
    throw new BadRequestError("已撤回的消息不可编辑");
  }
  const elapsed = Date.now() - new Date(msg.created_at).getTime();
  if (elapsed > EDIT_WINDOW_MS) {
    throw new BadRequestError("发送超过 5 分钟，无法编辑");
  }
  if (!content || content.trim().length === 0) {
    throw new BadRequestError("消息内容不能为空");
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(`消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
  }

  const now = new Date().toISOString();
  // 追加编辑历史（仅后台保存）
  let history: { content: string; edited_at: string }[] = [];
  if (msg.edit_history) {
    try {
      history = JSON.parse(msg.edit_history);
    } catch {
      history = [];
    }
  }
  history.push({ content: msg.content, edited_at: now });

  await getDb()
    .update(messages)
    .set({
      content,
      edited_at: now,
      edit_history: JSON.stringify(history),
    })
    .where(eq(messages.id, messageId));

  // 通知对方刷新
  const { otherUserId } = await assertParticipant(userId, conversationId);
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:edited",
      conversation_id: conversationId,
      message_id: messageId,
    },
  );
}

/**
 * 撤回消息（仅发送者本人，发送后 2 分钟内）。
 *
 * 撤回后消息内容保留在服务器，仅标记 recalled_at，前端显示系统提示。
 *
 * @param userId 当前用户 ID
 * @param conversationId 会话 ID
 * @param messageId 消息 ID
 */
export async function recallMessage(
  userId: string,
  conversationId: string,
  messageId: string,
) {
  const [msg] = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      sender_id: messages.sender_id,
      created_at: messages.created_at,
      recalled_at: messages.recalled_at,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg || msg.conversation_id !== conversationId) {
    throw new NotFoundError("消息不存在");
  }
  if (msg.sender_id !== userId) {
    throw new BadRequestError("只能撤回自己发送的消息");
  }
  if (msg.recalled_at) {
    throw new BadRequestError("消息已撤回");
  }
  const elapsed = Date.now() - new Date(msg.created_at).getTime();
  if (elapsed > RECALL_WINDOW_MS) {
    throw new BadRequestError("发送超过 2 分钟，无法撤回");
  }

  const now = new Date().toISOString();
  await getDb()
    .update(messages)
    .set({ recalled_at: now })
    .where(eq(messages.id, messageId));

  // 通知对方刷新
  const { otherUserId } = await assertParticipant(userId, conversationId);
  await publishSseEvent(
    Channels.user(otherUserId),
    {
      type: "message:recalled",
      conversation_id: conversationId,
      message_id: messageId,
    },
  );
}

/**
 * 更新会话备注名（仅当前用户视角）。
 * 空字符串视为清除备注。
 *
 * @param userId 当前用户 ID（须为会话参与者）
 * @param conversationId 会话 ID
 * @param remarkName 备注名（空 = 清除）
 */
export async function updateConversationRemark(
  userId: string,
  conversationId: string,
  remarkName: string,
) {
  await assertParticipant(userId, conversationId);
  const trimmed = remarkName.trim();
  await getDb()
    .insert(conversationPreferences)
    .values({
      user_id: userId,
      conversation_id: conversationId,
      remark_name: trimmed || null,
      is_muted: false,
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        conversationPreferences.user_id,
        conversationPreferences.conversation_id,
      ],
      set: {
        remark_name: trimmed || null,
        updated_at: new Date().toISOString(),
      },
    });
  return { conversation_id: conversationId, remark_name: trimmed || null };
}

/**
 * 切换会话消息免打扰（仅当前用户视角）。
 * 开启后新消息仅显示红点不显示数量。
 *
 * @param userId 当前用户 ID（须为会话参与者）
 * @param conversationId 会话 ID
 * @param isMuted 是否免打扰
 */
export async function setConversationMuted(
  userId: string,
  conversationId: string,
  isMuted: boolean,
) {
  await assertParticipant(userId, conversationId);
  await getDb()
    .insert(conversationPreferences)
    .values({
      user_id: userId,
      conversation_id: conversationId,
      remark_name: null,
      is_muted: isMuted,
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        conversationPreferences.user_id,
        conversationPreferences.conversation_id,
      ],
      set: { is_muted: isMuted, updated_at: new Date().toISOString() },
    });
  return { conversation_id: conversationId, is_muted: isMuted };
}

/**
 * 清空聊天记录（仅对当前用户隐藏，不实际删除消息）。
 * 批量插入 message_deletions 标记该会话全部消息对当前用户不可见。
 *
 * @param userId 当前用户 ID（须为会话参与者）
 * @param conversationId 会话 ID
 */
export async function clearConversationMessages(
  userId: string,
  conversationId: string,
) {
  await assertParticipant(userId, conversationId);
  const now = new Date().toISOString();
  // 查询该会话全部消息 ID，批量插入删除标记（幂等：PK 冲突忽略）
  const msgRows = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversation_id, conversationId));
  if (msgRows.length > 0) {
    await getDb()
      .insert(messageDeletions)
      .values(
        msgRows.map((m) => ({
          user_id: userId,
          message_id: m.id,
          deleted_at: now,
        })),
      )
      .onConflictDoNothing();
  }
  return { conversation_id: conversationId, cleared: msgRows.length };
}
