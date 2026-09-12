/**
 * 私信的消息交互与会话偏好操作。
 *
 * 从 `messages.ts` 拆出（2026-09-13，棘轮门禁）：该文件曾达 1517 行。
 * 本模块聚合「对单条消息/会话的交互」——reaction、编辑、撤回、
 * 会话备注与免打扰、清空聊天记录；消息的创建与查询仍在 `messages.ts`。
 *
 * 对外入口不变：`services/messages.ts` 会再导出这里的所有函数，
 * 调用方（路由 / index.ts / 测试）无需改动。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  conversationPreferences,
  messageDeletions,
  messageReactions,
  messages,
} from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
import { publishSearchIndexEvent } from "./../../../shared/search-events.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "messaging"]);
import {
  assertParticipant,
  MAX_MESSAGE_LENGTH,
  REACTION_EMOJIS,
} from "./messages-shared.ts";

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
  await publishSearchIndexEvent("message", messageId, "upsert");
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
  await publishSearchIndexEvent("message", messageId, "upsert");
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
    try {
      for (const row of msgRows) {
        await publishSearchIndexEvent("message", row.id, "upsert");
      }
    } catch (err) {
      logger.error("清空会话后发布搜索索引事件失败", { err });
    }
  }
  return { conversation_id: conversationId, cleared: msgRows.length };
}
