/**
 * 私信服务的内部共享件（在 messages 与 messages-conversation-actions 之间复用）。
 *
 * 拆出背景（2026-09-13）：`messages.ts` 曾达 1517 行，越过
 * `scripts/check-file-size.ts` 的 1200 行棘轮阈值。拆分只移动物理位置，
 * 对外行为与导出面完全不变（`services/messages.ts` 仍是唯一入口）。
 *
 * 本文件仅放**两侧都要用的最小内核**：参与者校验、消息长度上限、
 * reaction 白名单。业务函数不放这里，避免它重新长成巨型文件。
 */

import { eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { conversations } from "./../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../shared/base/errors.ts";

/** 消息内容最大长度 */
export const MAX_MESSAGE_LENGTH = 10_000;

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

/**
 * 校验用户是否为会话参与者。
 *
 * @returns 会话信息和对方用户 ID
 */
export async function assertParticipant(
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
