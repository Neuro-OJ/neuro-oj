import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  conversationReads,
  conversations,
  messageDeletions,
  messages,
  users,
} from "../db/schema.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10_000;
/** 消息预览截断长度 */
const PREVIEW_LENGTH = 50;

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
 * 发送消息。
 *
 * 校验发送者是会话参与者后，写入消息并更新会话最后消息时间。
 * 通过 Redis Pub/Sub 推送通知给接收方。
 *
 * @param userId 发送者 ID
 * @param conversationId 会话 ID
 * @param content 消息内容（1-10000 字符）
 * @returns 创建的消息对象
 */
export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
) {
  // 防御性校验 — 路由层已校验，service 层再加一道防止绕过
  if (!content || content.trim().length === 0) {
    throw new BadRequestError("消息内容不能为空");
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(`消息内容不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
  }

  const { otherUserId } = await assertParticipant(userId, conversationId);

  const now = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    sender_id: userId,
    content,
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
  // 通过 Redis Pub/Sub 通知接收方
  publishEvent(
    Channels.user(otherUserId),
    JSON.stringify({
      type: "message:new",
      conversation_id: conversationId,
      sender_id: userId,
    }),
  );

  return message;
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
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(or(...otherUserIds.map((id) => eq(users.id, id))));

  const userMap = new Map(otherUsers.map((u) => [u.id, u.username]));

  // 查询每个会话的最后一条消息预览
  const convIds = rows.map((r) => r.id);
  const lastMessages = await getDb()
    .select({
      conversation_id: messages.conversation_id,
      content: messages.content,
    })
    .from(messages)
    .where(
      or(...convIds.map((id) => eq(messages.conversation_id, id))),
    )
    .orderBy(desc(messages.created_at));

  // 取每个会话的最新一条消息
  const lastMsgMap = new Map<string, string>();
  const seen = new Set<string>();
  for (const msg of lastMessages) {
    if (!seen.has(msg.conversation_id)) {
      seen.add(msg.conversation_id);
      const preview = msg.content.length > PREVIEW_LENGTH
        ? msg.content.slice(0, PREVIEW_LENGTH) + "..."
        : msg.content;
      lastMsgMap.set(msg.conversation_id, preview);
    }
  }

  // 查询未读计数（排除当前用户已删除的消息）
  const unreadCounts = await Promise.all(
    rows.map((r) => getUnreadCountByConversation(userId, r.id)),
  );

  // 组装响应
  const data = rows.map((r, i) => {
    const otherUserId = r.user1_id === userId ? r.user2_id : r.user1_id;
    return {
      id: r.id,
      other_user_id: otherUserId,
      other_user_name: userMap.get(otherUserId) ?? "已注销用户",
      last_message_preview: lastMsgMap.get(r.id) ?? "",
      last_message_at: r.last_message_at,
      unread_count: unreadCounts[i],
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
  await assertParticipant(userId, conversationId);

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
      content: messages.content,
      created_at: messages.created_at,
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

  return {
    data: rows,
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
}

/**
 * 获取用户所有会话的未读消息总数（用于导航栏徽标）。
 */
export async function getUnreadCount(userId: string): Promise<number> {
  // 查询用户参与的所有会话
  const convRows = await getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      or(
        eq(conversations.user1_id, userId),
        eq(conversations.user2_id, userId),
      ),
    );

  if (convRows.length === 0) return 0;

  let total = 0;
  for (const conv of convRows) {
    total += await getUnreadCountByConversation(userId, conv.id);
  }
  return total;
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

  // 构建查询：计数该会话中创建时间 > 已读位置的消息
  let conditions = eq(messages.conversation_id, conversationId);

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
