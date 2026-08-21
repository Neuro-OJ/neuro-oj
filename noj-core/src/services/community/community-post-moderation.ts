import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import { communityModerationActions, communityPosts } from "../../db/schema.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { nowIso } from "../../lib/dates.ts";
import type { CommunityPostStatus } from "../../types/community.ts";
import { createNotification } from "../notifications.ts";
import { logAudit } from "../audit-log.ts";

export async function changePostStatus(
  postId: string,
  actorId: string,
  status: CommunityPostStatus,
  reason = "",
) {
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    status,
    moderation_reason: reason || null,
    published_at: status === "published" ? nowIso() : null,
    updated_at: nowIso(),
  }).where(eq(communityPosts.id, postId)).returning();
  if (!rows[0]) throw new NotFoundError("社区内容不存在");
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: status,
    target_type: "post",
    target_id: postId,
    reason,
    metadata: {},
    created_at: nowIso(),
  });
  if (rows[0].author_id !== actorId) {
    await createNotification(
      rows[0].author_id,
      actorId,
      "moderation",
      postId,
      null,
      { status, reason },
    );
  }
  // 作者自删与审核员处置在审计 detail 中区分，便于追溯删除性质
  const isSelfDelete = status === "deleted" && rows[0].author_id === actorId;
  await logAudit(
    "community.post_moderated",
    {
      action: "community.post_moderated",
      status,
      reason,
      self_delete: isSelfDelete,
    },
    { type: "community_post", id: postId },
  );
  return rows[0];
}

export async function togglePostFlag(
  postId: string,
  actorId: string,
  field: "is_locked" | "is_pinned",
  value: boolean,
) {
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    [field]: value,
    updated_at: nowIso(),
  }).where(eq(communityPosts.id, postId)).returning();
  if (!rows[0]) throw new NotFoundError("社区内容不存在");
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: field,
    target_type: "post",
    target_id: postId,
    reason: "",
    metadata: { value },
    created_at: nowIso(),
  });
  await logAudit(
    "community.post_moderated",
    {
      action: "community.post_moderated",
      status: field === "is_locked" ? "locked" : "pinned",
      reason: "",
    },
    { type: "community_post", id: postId },
  );
  return rows[0];
}
