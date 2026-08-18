import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityComments,
  communityPosts,
  communityReports,
  communitySanctions,
} from "../db/schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { logAudit } from "./audit-log.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import { reloadSingleKey, updateSetting } from "./system-settings.ts";
import { nowIso } from "../lib/dates.ts";

export async function createReport(
  reporterId: string,
  input: { post_id?: string; comment_id?: string; reason: string },
) {
  assertCommunityEnabled();
  if (!!input.post_id === !!input.comment_id) {
    throw new ValidationError("必须指定一个举报目标");
  }
  const db = getDb();
  const target = input.post_id
    ? await db.select({
      id: communityPosts.id,
      content: communityPosts.content,
      status: communityPosts.status,
    }).from(communityPosts).where(eq(communityPosts.id, input.post_id)).limit(1)
    : await db.select({
      id: communityComments.id,
      content: communityComments.content,
      status: communityComments.status,
    }).from(communityComments).where(
      eq(communityComments.id, input.comment_id!),
    ).limit(1);
  if (!target[0] || target[0].status === "deleted") {
    throw new NotFoundError("举报目标不存在");
  }
  const existing = await db.select({ id: communityReports.id }).from(
    communityReports,
  ).where(
    and(
      eq(communityReports.reporter_id, reporterId),
      input.post_id
        ? eq(communityReports.post_id, input.post_id)
        : eq(communityReports.comment_id, input.comment_id!),
      eq(communityReports.status, "pending"),
    ),
  ).limit(1);
  if (existing[0]) throw new ConflictError("已举报该内容");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("举报原因不能为空");
  if (reason.length > 500) throw new ValidationError("举报原因最多 500 个字符");
  const report = {
    id: crypto.randomUUID(),
    reporter_id: reporterId,
    post_id: input.post_id ?? null,
    comment_id: input.comment_id ?? null,
    reason,
    content_snapshot: target[0].content,
    status: "pending",
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    created_at: nowIso(),
  };
  await db.insert(communityReports).values(report);
  return report;
}

export function listReports() {
  const db = getDb();
  return db.select().from(communityReports).where(
    eq(communityReports.status, "pending"),
  ).orderBy(communityReports.created_at);
}

export async function resolveReport(
  reportId: string,
  actorId: string,
  status: "resolved" | "dismissed",
  resolution = "",
) {
  const db = getDb();
  const rows = await db.update(communityReports).set({
    status,
    resolution,
    resolved_by: actorId,
    resolved_at: nowIso(),
  }).where(eq(communityReports.id, reportId)).returning();
  if (!rows[0]) throw new NotFoundError("举报不存在");
  await logAudit(
    "community.report_resolved",
    { action: "community.report_resolved", status, resolution },
    { type: "community_report", id: reportId },
  );
  return rows[0];
}

export async function createSanction(
  actorId: string,
  userId: string,
  reason: string,
  expiresAt?: string,
) {
  const db = getDb();
  const sanction = {
    id: crypto.randomUUID(),
    user_id: userId,
    reason,
    expires_at: expiresAt ?? null,
    created_by: actorId,
    created_at: nowIso(),
    revoked_at: null,
    revoked_by: null,
  };
  await db.insert(communitySanctions).values(sanction);
  await logAudit(
    "community.sanction_created",
    {
      action: "community.sanction_created",
      reason,
      expires_at: expiresAt ?? null,
    },
    { type: "user", id: userId },
  );
  return sanction;
}

export async function revokeSanction(actorId: string, sanctionId: string) {
  const db = getDb();
  const rows = await db.update(communitySanctions).set({
    revoked_at: nowIso(),
    revoked_by: actorId,
  }).where(eq(communitySanctions.id, sanctionId)).returning();
  if (!rows[0]) throw new NotFoundError("社区处罚不存在");
  await logAudit(
    "community.sanction_revoked",
    { action: "community.sanction_revoked" },
    { type: "community_sanction", id: sanctionId },
  );
  return rows[0];
}

export function listSanctions() {
  const db = getDb();
  return db.select().from(communitySanctions).orderBy(
    desc(communitySanctions.created_at),
  );
}

/** 某用户的全部社区处罚历史（含已撤销记录），按创建时间倒序。 */
export function listUserSanctions(userId: string) {
  const db = getDb();
  return db.select().from(communitySanctions).where(
    eq(communitySanctions.user_id, userId),
  ).orderBy(desc(communitySanctions.created_at));
}

const PRESETS: Record<
  "public" | "private" | "knowledge",
  Record<string, boolean>
> = {
  public: {
    community_enabled: true,
    community_guest_read_enabled: true,
    community_read_only: false,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: true,
    community_activities_enabled: true,
    community_comments_enabled: true,
    community_reactions_enabled: true,
    community_bookmarks_enabled: true,
    community_follows_enabled: true,
    private_messaging_enabled: true,
    community_external_images_enabled: true,
  },
  private: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: false,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: true,
    community_activities_enabled: true,
    community_comments_enabled: true,
    community_reactions_enabled: true,
    community_bookmarks_enabled: true,
    community_follows_enabled: true,
    private_messaging_enabled: true,
    community_external_images_enabled: false,
  },
  knowledge: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: true,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: false,
    community_activities_enabled: false,
    community_comments_enabled: false,
    community_reactions_enabled: false,
    community_bookmarks_enabled: false,
    community_follows_enabled: false,
    private_messaging_enabled: false,
    community_external_images_enabled: false,
  },
};

export async function applyCommunityPreset(
  actorId: string,
  preset: keyof typeof PRESETS,
) {
  // 预设必须事务化写入（design.md / community-configuration spec），
  // 中途失败不得留下部分应用状态；审计在提交成功后记录
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(PRESETS[preset])) {
      await updateSetting(key, value, actorId, tx);
    }
  });
  await logAudit(
    "community.preset_applied",
    { action: "community.preset_applied", preset },
    { type: "community_preset", id: preset },
  );
  // 事务提交后统一刷新内存缓存（事务模式下 updateSetting 跳过缓存刷新）
  for (const key of Object.keys(PRESETS[preset])) {
    await reloadSingleKey(key);
  }
  return getCommunityConfig();
}
