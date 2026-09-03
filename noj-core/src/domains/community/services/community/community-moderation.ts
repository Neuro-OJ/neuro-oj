import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityComments,
  communityPosts,
  communityReports,
  communitySanctions,
  conversations,
  messages,
  userBans,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { logAudit } from "../../../system/index.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import {
  REPORT_CATEGORIES,
  type ReportCategory,
} from "../../../../types/community.ts";
import { reloadSingleKey, updateSetting } from "../../../system/index.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";
import { createNotification } from "../notifications.ts";
import { invalidateBanCache } from "./../../../identity/index.ts";
import { getStorageProvider } from "./../../../system/index.ts";
import { parseStorageUrl } from "./../../../system/index.ts";

export { banUser, getLatestActiveBanId } from "../../../identity/index.ts";

/**
 * 创建举报工单：校验举报目标、分类与原因，并通知举报者已提交。
 * @param reporterId 举报者用户 UUID。
 * @param input 举报输入：post_id/comment_id（二选一）、reason（原因）、category（分类）。
 * @returns 新建的举报记录。
 * @throws {ValidationError} 未指定目标、分类无效、原因为空或超长时抛出。
 * @throws {NotFoundError} 举报目标不存在或已删除时抛出。
 * @throws {ConflictError} 同一举报者对同一内容已有待处理举报时抛出。
 */
export async function createReport(
  reporterId: string,
  input: {
    post_id?: string;
    comment_id?: string;
    message_id?: string;
    reason: string;
    category?: string;
  },
) {
  assertCommunityEnabled();
  const targetCount = [input.post_id, input.comment_id, input.message_id]
    .filter((x) => !!x).length;
  if (targetCount !== 1) {
    throw new ValidationError("必须指定一个举报目标");
  }
  // 举报分类必选
  const category = input.category;
  if (!category || !REPORT_CATEGORIES.includes(category as ReportCategory)) {
    throw new ValidationError("请选择举报分类");
  }
  const db = getDb();
  let contentSnapshot = "";
  let contentType = "post";
  let targetFilter;
  if (input.post_id) {
    const target = await db.select({
      id: communityPosts.id,
      content: communityPosts.content,
      status: communityPosts.status,
    }).from(communityPosts).where(eq(communityPosts.id, input.post_id)).limit(
      1,
    );
    if (!target[0] || target[0].status === "deleted") {
      throw new NotFoundError("举报目标不存在");
    }
    contentSnapshot = target[0].content;
    targetFilter = eq(communityReports.post_id, input.post_id);
  } else if (input.comment_id) {
    const target = await db.select({
      id: communityComments.id,
      content: communityComments.content,
      status: communityComments.status,
    }).from(communityComments).where(
      eq(communityComments.id, input.comment_id),
    ).limit(1);
    if (!target[0] || target[0].status === "deleted") {
      throw new NotFoundError("举报目标不存在");
    }
    contentSnapshot = target[0].content;
    contentType = "comment";
    targetFilter = eq(communityReports.comment_id, input.comment_id);
  } else {
    // 私信消息举报：校验消息存在且举报者是该会话参与者
    const target = await db.select({
      id: messages.id,
      conversation_id: messages.conversation_id,
      content: messages.content,
      type: messages.type,
    }).from(messages).where(eq(messages.id, input.message_id!)).limit(1);
    if (!target[0]) {
      throw new NotFoundError("举报目标不存在");
    }
    // 举报者必须是消息所在会话的参与者
    const [conv] = await db.select()
      .from(conversations)
      .where(eq(conversations.id, target[0].conversation_id))
      .limit(1);
    if (
      !conv ||
      (conv.user1_id !== reporterId && conv.user2_id !== reporterId)
    ) {
      throw new NotFoundError("举报目标不存在");
    }
    contentSnapshot = target[0].type === "image" ? "[图片]" : target[0].content;
    contentType = "message";
    targetFilter = eq(communityReports.message_id, input.message_id!);
  }
  const existing = await db.select({ id: communityReports.id }).from(
    communityReports,
  ).where(
    and(
      eq(communityReports.reporter_id, reporterId),
      targetFilter,
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
    message_id: input.message_id ?? null,
    content_type: contentType,
    category,
    reason,
    content_snapshot: contentSnapshot,
    status: "pending",
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    created_at: nowIso(),
  };
  await db.insert(communityReports).values(report);
  // 通知举报者：已提交，等待管理员审核
  await createNotification(
    reporterId,
    null,
    "report",
    report.post_id,
    report.comment_id,
    {
      report_id: report.id,
      status: "pending",
      message: "你的举报已提交，等待管理员审核中",
    },
  );
  return report;
}

/**
 * 列出举报工单（含举报者、被举报内容、被举报者、处理者与关联封禁/处罚信息）。
 * @param status 过滤状态：pending / resolved / dismissed / all，默认 pending。
 * @returns 举报列表，按创建时间倒序。
 */
export function listReports(
  status: "pending" | "resolved" | "dismissed" | "all" = "pending",
) {
  const db = getDb();
  const conditions = status === "all"
    ? []
    : [eq(communityReports.status, status)];
  const targetAuthor = aliasedTable(users, "target_author");
  const resolvedByUser = aliasedTable(users, "resolved_by_user");
  return db.select({
    report: communityReports,
    reporter: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
    post: {
      id: communityPosts.id,
      title: communityPosts.title,
      content: communityPosts.content,
      type: communityPosts.type,
      author_id: communityPosts.author_id,
    },
    comment: {
      id: communityComments.id,
      content: communityComments.content,
      post_id: communityComments.post_id,
      author_id: communityComments.author_id,
    },
    message: {
      id: messages.id,
      content: messages.content,
      type: messages.type,
      sender_id: messages.sender_id,
      conversation_id: messages.conversation_id,
    },
    // 被举报者：帖子取 posts.author_id，评论取 comments.author_id，消息取 messages.sender_id
    reported_author: {
      id: targetAuthor.id,
      username: targetAuthor.username,
    },
    // 处理者
    resolved_by_user: {
      id: resolvedByUser.id,
      username: resolvedByUser.username,
    },
    // 是否有关联的生效处罚（撤销处理时需一并撤销）
    active_sanction: sql<boolean>`exists(
      select 1 from community_sanctions
      where community_sanctions.id = ${communityReports.sanction_id}
        and community_sanctions.revoked_at is null
    )`,
    // 关联封禁信息（处理方式为封禁时展示 scope/期限）
    ban: {
      id: userBans.id,
      scope: userBans.scope,
      banned_until: userBans.banned_until,
    },
  }).from(communityReports)
    .innerJoin(users, eq(users.id, communityReports.reporter_id))
    .leftJoin(communityPosts, eq(communityPosts.id, communityReports.post_id))
    .leftJoin(
      communityComments,
      eq(communityComments.id, communityReports.comment_id),
    )
    .leftJoin(messages, eq(messages.id, communityReports.message_id))
    .leftJoin(
      targetAuthor,
      eq(
        targetAuthor.id,
        sql`COALESCE(${communityPosts.author_id}, ${communityComments.author_id}, ${messages.sender_id})`,
      ),
    )
    .leftJoin(
      resolvedByUser,
      eq(resolvedByUser.id, communityReports.resolved_by),
    )
    .leftJoin(userBans, eq(userBans.id, communityReports.ban_id))
    .where(and(...conditions))
    .orderBy(desc(communityReports.created_at));
}

/**
 * 处理或驳回举报：更新状态、处理者与处理结果，并通知举报者。
 * @param reportId 举报 UUID。
 * @param actorId 处理者用户 UUID。
 * @param status 处理结果：resolved（已处理）或 dismissed（已驳回）。
 * @param resolution 可选，处理说明。
 * @param banId 可选，关联的封禁 UUID。
 * @param sanctionId 可选，关联的社区处罚 UUID。
 * @returns 更新后的举报记录。
 * @throws {NotFoundError} 举报不存在时抛出。
 */
export async function resolveReport(
  reportId: string,
  actorId: string,
  status: "resolved" | "dismissed",
  resolution = "",
  banId?: string,
  sanctionId?: string,
) {
  const db = getDb();
  const rows = await db.update(communityReports).set({
    status,
    resolution,
    resolved_by: actorId,
    resolved_at: nowIso(),
    ban_id: banId ?? undefined,
    sanction_id: sanctionId ?? undefined,
  }).where(eq(communityReports.id, reportId)).returning();
  if (!rows[0]) throw new NotFoundError("举报不存在");
  // 通知举报者处理结果（resolved=已处理，dismissed=已驳回）。
  // actor 用 null（系统）而非处理者：当处理者恰好是举报者本人时，
  // createNotification 的 recipientId===actorId 跳过会误拦截，导致收不到结果通知。
  await createNotification(
    rows[0].reporter_id,
    null,
    "report",
    rows[0].post_id,
    rows[0].comment_id,
    {
      report_id: reportId,
      status,
      message: status === "resolved" ? "你的举报已处理" : "你的举报已被驳回",
      resolution: resolution || undefined,
    },
  );
  await logAudit(
    "community.report_resolved",
    { action: "community.report_resolved", status, resolution },
    { type: "community_report", id: reportId },
  );
  return rows[0];
}

/** 撤销处理/驳回：把举报放回待处理，恢复被隐藏内容并解除关联封禁/禁言。 */
export async function reopenReport(reportId: string) {
  const db = getDb();
  const current = await db.select({
    id: communityReports.id,
    post_id: communityReports.post_id,
    comment_id: communityReports.comment_id,
    ban_id: communityReports.ban_id,
    sanction_id: communityReports.sanction_id,
  }).from(communityReports).where(eq(communityReports.id, reportId)).limit(1);
  if (!current[0]) throw new NotFoundError("举报不存在");

  // 恢复内容 + 撤销封禁/禁言 + 重置状态需原子化，避免部分成功导致状态不一致
  const rows = await db.transaction(async (tx) => {
    // 恢复被隐藏的内容（处理时若隐藏了帖子/评论则恢复为 published）
    if (current[0].post_id) {
      const post = await tx.select({ status: communityPosts.status })
        .from(communityPosts).where(eq(communityPosts.id, current[0].post_id))
        .limit(1);
      if (post[0] && post[0].status === "hidden") {
        await tx.update(communityPosts).set({
          status: "published",
          updated_at: nowIso(),
        })
          .where(eq(communityPosts.id, current[0].post_id));
      }
    }
    if (current[0].comment_id) {
      const comment = await tx.select({ status: communityComments.status })
        .from(communityComments).where(
          eq(communityComments.id, current[0].comment_id),
        ).limit(1);
      if (comment[0] && comment[0].status === "hidden") {
        await tx.update(communityComments).set({
          status: "published",
          updated_at: nowIso(),
        })
          .where(eq(communityComments.id, current[0].comment_id));
      }
    }

    // 若举报关联了仍未撤销的封禁，一并撤销（恢复被处罚用户）
    if (current[0].ban_id) {
      const banRows = await tx.select({ user_id: userBans.user_id })
        .from(userBans).where(eq(userBans.id, current[0].ban_id)).limit(1);
      await tx.update(userBans).set({
        unbanned_at: nowIso(),
        unbanned_by: null,
      }).where(
        and(eq(userBans.id, current[0].ban_id), isNull(userBans.unbanned_at)),
      );
      if (banRows[0]) {
        invalidateBanCache({ userId: banRows[0].user_id });
      }
    }
    // 兼容旧数据：撤销关联的社区禁言
    if (current[0].sanction_id) {
      await tx.update(communitySanctions).set({
        revoked_at: nowIso(),
        revoked_by: null,
      }).where(
        and(
          eq(communitySanctions.id, current[0].sanction_id),
          isNull(communitySanctions.revoked_at),
        ),
      );
    }

    return await tx.update(communityReports).set({
      status: "pending",
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      ban_id: null,
      sanction_id: null,
    }).where(eq(communityReports.id, reportId)).returning();
  });
  // 通知举报者：处理已撤销，回到待审核
  if (rows[0]) {
    await createNotification(
      rows[0].reporter_id,
      null,
      "report",
      rows[0].post_id,
      rows[0].comment_id,
      {
        report_id: reportId,
        status: "pending",
        message: "你的举报已重新开启，等待管理员审核",
      },
    );
  }
  return rows[0];
}

/** 举报目标信息（处理时需要知道被举报对象与被举报用户）。 */
export async function getReportTarget(reportId: string) {
  const db = getDb();
  const rows = await db.select({
    report: communityReports,
    post: {
      id: communityPosts.id,
      type: communityPosts.type,
      author_id: communityPosts.author_id,
    },
    comment: {
      id: communityComments.id,
      post_id: communityComments.post_id,
      author_id: communityComments.author_id,
    },
    message: {
      id: messages.id,
      conversation_id: messages.conversation_id,
      sender_id: messages.sender_id,
    },
  }).from(communityReports)
    .leftJoin(communityPosts, eq(communityPosts.id, communityReports.post_id))
    .leftJoin(
      communityComments,
      eq(communityComments.id, communityReports.comment_id),
    )
    .leftJoin(messages, eq(messages.id, communityReports.message_id))
    .where(eq(communityReports.id, reportId)).limit(1);
  if (!rows[0]) throw new NotFoundError("举报不存在");
  return rows[0];
}

/** 举报关联封禁的 scope（用于撤销时判断是否需要管理员权限）。 */
export async function getReportBanScope(
  reportId: string,
): Promise<"platform" | "social" | null> {
  const db = getDb();
  const rows = await db.select({ scope: userBans.scope })
    .from(communityReports)
    .innerJoin(userBans, eq(userBans.id, communityReports.ban_id))
    .where(eq(communityReports.id, reportId)).limit(1);
  if (!rows[0] || !rows[0].scope) return null;
  return rows[0].scope === "social" ? "social" : "platform";
}

/**
 * 获取单个举报详情（供用户可见的举报工单页）。
 * 仅举报者本人或审核员可查看。
 */
export async function getReportDetail(reportId: string, _viewerId: string) {
  const db = getDb();
  const rows = await db.select({
    report: communityReports,
    reporter: {
      id: users.id,
      username: users.username,
    },
    post: {
      id: communityPosts.id,
      title: communityPosts.title,
      content: communityPosts.content,
      type: communityPosts.type,
      author_id: communityPosts.author_id,
    },
    comment: {
      id: communityComments.id,
      content: communityComments.content,
      post_id: communityComments.post_id,
      author_id: communityComments.author_id,
    },
    message: {
      id: messages.id,
      content: messages.content,
      type: messages.type,
      conversation_id: messages.conversation_id,
      sender_id: messages.sender_id,
      recalled_at: messages.recalled_at,
    },
    // 关联封禁信息（处理方式为封禁时展示 scope/期限）
    ban: {
      id: userBans.id,
      scope: userBans.scope,
      banned_until: userBans.banned_until,
      unbanned_at: userBans.unbanned_at,
    },
  }).from(communityReports)
    .innerJoin(users, eq(users.id, communityReports.reporter_id))
    .leftJoin(communityPosts, eq(communityPosts.id, communityReports.post_id))
    .leftJoin(
      communityComments,
      eq(communityComments.id, communityReports.comment_id),
    )
    .leftJoin(messages, eq(messages.id, communityReports.message_id))
    .leftJoin(userBans, eq(userBans.id, communityReports.ban_id))
    .where(eq(communityReports.id, reportId)).limit(1);
  if (!rows[0]) throw new NotFoundError("举报不存在");
  return rows[0];
}

/**
 * 创建社区处罚（禁言）：限制用户社区互动，可指定过期时间。
 * @param actorId 执行者用户 UUID。
 * @param userId 被处罚用户 UUID。
 * @param reason 处罚原因。
 * @param expiresAt 可选，处罚过期时间（ISO 字符串），缺省为永久。
 * @returns 新建的社区处罚记录。
 */
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

/**
 * 撤销社区处罚（解除禁言）。
 * @param actorId 执行者用户 UUID。
 * @param sanctionId 社区处罚 UUID。
 * @returns 撤销后的社区处罚记录。
 * @throws {NotFoundError} 社区处罚不存在时抛出。
 */
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

/**
 * 列出全部社区处罚记录，按创建时间倒序。
 * @returns 社区处罚列表。
 */
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

/**
 * 应用社区预设（public / private / knowledge）：事务化写入全部配置项并刷新缓存。
 * @param actorId 执行者用户 UUID。
 * @param preset 预设名称：public / private / knowledge。
 * @returns 应用后的社区配置。
 */
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

/**
 * 查询举报目标会话的完整聊天记录（供举报工单附带展示/审核）。
 *
 * 按 created_at ASC 排序，时间上限取举报时间附近（最多 200 条）。
 * 撤回消息内容保留在 response（由 route 层按查看者角色决定是否隐藏）。
 *
 * @param conversationId 会话 ID
 * @param reporterId 举报者 ID（用于校验举报者参与了该会话）
 */
export async function getReportMessageHistory(
  conversationId: string,
  reporterId: string,
): Promise<
  {
    id: string;
    sender_id: string;
    type: string;
    content: string;
    created_at: string;
    recalled_at: string | null;
    image_url: string | null;
    conversation_id: string;
    reply_to_message_id: string | null;
    reply_to: {
      sender_name: string;
      content: string;
      type: string;
    } | null;
    forwarded_from_user_id: string | null;
    forwarded_from_user: { id: string; username: string } | null;
  }[]
> {
  const db = getDb();
  // 校验举报者是会话参与者（防越权读取他人私聊记录）
  const [conv] = await db.select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (
    !conv ||
    (conv.user1_id !== reporterId && conv.user2_id !== reporterId)
  ) {
    throw new NotFoundError("会话不存在");
  }
  const rows = await db
    .select({
      id: messages.id,
      sender_id: messages.sender_id,
      type: messages.type,
      content: messages.content,
      created_at: messages.created_at,
      recalled_at: messages.recalled_at,
      image_url: messages.image_url,
      conversation_id: messages.conversation_id,
      reply_to_message_id: messages.reply_to_message_id,
      forwarded_from_user_id: messages.forwarded_from_user_id,
    })
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .orderBy(asc(messages.created_at))
    .limit(200);

  // 批量查询被引用消息摘要（reply_to）
  const replyIds = rows
    .map((r) => r.reply_to_message_id)
    .filter((id): id is string => !!id);
  const replyMap = new Map<
    string,
    { sender_name: string; content: string; type: string }
  >();
  if (replyIds.length > 0) {
    const replyRows = await db
      .select({
        id: messages.id,
        sender_id: messages.sender_id,
        content: messages.content,
        type: messages.type,
      })
      .from(messages)
      .where(inArray(messages.id, [...new Set(replyIds)]));
    const replySenderIds = [...new Set(replyRows.map((r) => r.sender_id))];
    const replySenders = replySenderIds.length > 0
      ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, replySenderIds))
      : [];
    const senderMap = new Map(replySenders.map((u) => [u.id, u.username]));
    for (const r of replyRows) {
      replyMap.set(r.id, {
        sender_name: senderMap.get(r.sender_id) ?? "已注销用户",
        content: r.type === "image" ? "[图片]" : r.content,
        type: r.type,
      });
    }
  }

  // 批量查询转发来源用户名
  const fwdUserIds = rows
    .map((r) => r.forwarded_from_user_id)
    .filter((id): id is string => !!id);
  const fwdMap = new Map<string, { id: string; username: string }>();
  if (fwdUserIds.length > 0) {
    const fwdUsers = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...new Set(fwdUserIds)]));
    for (const u of fwdUsers) fwdMap.set(u.id, u);
  }

  return rows.map((r) => ({
    id: r.id,
    sender_id: r.sender_id,
    type: r.type,
    content: r.content,
    created_at: r.created_at,
    recalled_at: r.recalled_at,
    image_url: r.image_url,
    conversation_id: r.conversation_id,
    reply_to_message_id: r.reply_to_message_id,
    reply_to: r.reply_to_message_id
      ? replyMap.get(r.reply_to_message_id) ?? null
      : null,
    forwarded_from_user_id: r.forwarded_from_user_id,
    forwarded_from_user: r.forwarded_from_user_id
      ? fwdMap.get(r.forwarded_from_user_id) ?? null
      : null,
  }));
}

/**
 * 审核员读取举报附带私信图片字节（复用消息图片存储读取）。
 *
 * 与 conversations 的图片端点不同：不要求请求者是会话参与者，
 * 仅要求具备社区审核权限（由路由守卫保证）。
 *
 * @param conversationId 会话 ID（须与消息所在会话一致）
 * @param messageId 图片消息 ID
 */
export async function getReportImageBytes(
  conversationId: string,
  messageId: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const db = getDb();
  const [msg] = await db
    .select({
      conversation_id: messages.conversation_id,
      type: messages.type,
      image_url: messages.image_url,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg || msg.type !== "image" || !msg.image_url) {
    throw new NotFoundError("图片消息不存在");
  }
  if (msg.conversation_id !== conversationId) {
    throw new NotFoundError("图片消息不存在");
  }
  // 仅允许读取确实存在于举报工单中的私信图片，防止审核员越权访问任意会话图片
  const [report] = await db
    .select({ id: communityReports.id })
    .from(communityReports)
    .where(eq(communityReports.message_id, messageId))
    .limit(1);
  if (!report) {
    throw new NotFoundError("图片消息不存在");
  }
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
