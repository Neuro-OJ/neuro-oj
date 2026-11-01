import { aliasedTable, and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import {
  communityComments,
  communityPosts,
  communityReports,
  communitySanctions,
  userBans,
  users,
} from "../../../../../shared/db/schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../../../shared/base/errors.ts";
import { logAudit } from "../../../../platform/contracts/cross-module/system_services_audit-log.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import {
  REPORT_CATEGORIES,
  type ReportCategory,
} from "../../types/community.ts";
import { reloadSingleKey } from "../../../../platform/contracts/cross-module/services_system-settings.ts";
import { updateSetting } from "../../../../platform/contracts/cross-module/system_services_system-settings.ts";
import { nowIso } from "../../../../../shared/base/dates.ts";
import { createNotification } from "../notifications.ts";
import { invalidateBanCache } from "../../../../access/contracts/cross-module/identity_services_security_banCache.ts";
import { isProblemInUnendedPublicContest } from "../../../../contests/contracts/cross-module/services_problem-secrecy.ts";
import {
  communityDb,
  communityDomainId,
  communityDomainWhere,
  communityResourceVisible,
  type CommunityScope,
  loadCommunityScope,
} from "./community-scope.ts";
import { withDefaultCommunity } from "./domain-community.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../../shared/workspace/types.ts";
import { getPost } from "./community-post-crud.ts";

export {
  banUser,
  getLatestActiveBanId,
} from "../../../../access/identity/index.ts";

/**
 * 创建举报工单：校验举报目标、分类与原因，并通知举报者已提交。
 * @param reporterId 举报者用户 UUID。
 * @param input 举报输入：post_id/comment_id（二选一）、reason（原因）、category（分类）。
 * @returns 新建的举报记录。
 * @throws {ValidationError} 未指定目标、分类无效、原因为空或超长时抛出。
 * @throws {NotFoundError} 举报目标不存在或已删除时抛出。
 * @throws {ConflictError} 同一举报者对同一内容已有待处理举报时抛出。
 * @param moderator 举报者是否为审核员（审核员免赛期门控，可举报任意内容）。
 */
export async function createReport(
  reporterId: string,
  input: {
    post_id?: string;
    comment_id?: string;
    reason: string;
    category?: string;
  },
  moderator = false,
  scope?: CommunityScope,
): Promise<typeof communityReports.$inferSelect> {
  if (!scope) {
    return await withDefaultCommunity(
      reporterId,
      { write: true, moderator },
      (current) => createReport(reporterId, input, moderator, current),
    );
  }
  assertCommunityEnabled();
  const targetCount = [input.post_id, input.comment_id]
    .filter((x) => !!x).length;
  if (targetCount !== 1) {
    throw new ValidationError("必须指定一个举报目标");
  }
  // 举报分类必选
  const category = input.category;
  if (!category || !REPORT_CATEGORIES.includes(category as ReportCategory)) {
    throw new ValidationError("请选择举报分类");
  }
  const db = communityDb(scope);
  let contentSnapshot = "";
  let contentType = "post";
  let targetFilter;
  if (input.post_id) {
    if (scope) await getPost(input.post_id, reporterId, moderator, scope);
    const target = await db.select({
      id: communityPosts.id,
      content: communityPosts.content,
      status: communityPosts.status,
      type: communityPosts.type,
      problem_id: communityPosts.problem_id,
      author_id: communityPosts.author_id,
    }).from(communityPosts).where(
      and(
        eq(communityPosts.id, input.post_id),
        communityDomainWhere(communityPosts.domain_id, scope),
      ),
    ).limit(
      1,
    );
    if (!target[0] || target[0].status === "deleted") {
      throw new NotFoundError("举报目标不存在");
    }
    // 赛期题解门控（2026-09-14 评审 High#3/#4）：举报接口会**原样返回**被举报
    // 内容的完整正文，而 `community:report` 在默认角色权限集内。若此处不门控，
    // 「匿名主页拿到 post id（High#1）→ 举报接口拿全文」即可链式绕过赛期隐藏。
    // 口径与读路径一致：无权限一律 404，不确认内容是否存在。
    // 作者本人与审核员例外（作者需要能举报/申诉自己的帖子）。
    //
    // **窗口口径必须是 unended（含赛前筹备期 pending）**（2026-09-29 面 1.4/1.5 审计 F-02/N-02）：
    // 此前用 `isProblemInRunningContest`（仅 start≤now<end），于是赛前筹备期里
    // `GET /community/posts/:id` 已 404、而本接口仍返回题解**全文**——同一份"未结束公开赛"
    // 事实的两套口径，pending 阶段恰好是最需要保密的阶段。
    if (
      !moderator && target[0].author_id !== reporterId &&
      target[0].problem_id &&
      await isProblemInUnendedPublicContest(
        target[0].problem_id,
        communityDomainId(scope),
        db,
      )
    ) {
      throw new NotFoundError("举报目标不存在");
    }
    contentSnapshot = target[0].content;
    targetFilter = eq(communityReports.post_id, input.post_id);
  } else {
    const target = await db.select({
      id: communityComments.id,
      content: communityComments.content,
      status: communityComments.status,
      author_id: communityComments.author_id,
      // 评论所在帖子的门控信息：评论讨论同样会泄露赛期题目内容
      post_type: communityPosts.type,
      post_problem_id: communityPosts.problem_id,
      post_id: communityPosts.id,
    }).from(communityComments)
      .innerJoin(
        communityPosts,
        eq(communityPosts.id, communityComments.post_id),
      )
      .where(
        and(
          eq(communityComments.id, input.comment_id!),
          communityDomainWhere(communityComments.domain_id, scope),
        ),
      ).limit(1);
    if (!target[0] || target[0].status === "deleted") {
      throw new NotFoundError("举报目标不存在");
    }
    if (scope) await getPost(target[0].post_id, reporterId, moderator, scope);
    // 与帖子举报同口径：评论所属帖子处于赛期门控时一并隐藏（High#3/#4）
    // 窗口口径 = unended（含 pending），见上方帖子举报处的说明（审计 N-02）。
    if (
      !moderator && target[0].author_id !== reporterId &&
      target[0].post_type === "solution" && target[0].post_problem_id &&
      await isProblemInUnendedPublicContest(
        target[0].post_problem_id,
        communityDomainId(scope),
        db,
      )
    ) {
      throw new NotFoundError("举报目标不存在");
    }
    contentSnapshot = target[0].content;
    contentType = "comment";
    targetFilter = eq(communityReports.comment_id, input.comment_id!);
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
    domain_id: communityDomainId(scope),
    reporter_id: reporterId,
    post_id: input.post_id ?? null,
    comment_id: input.comment_id ?? null,
    content_type: contentType,
    category,
    reason,
    content_snapshot: contentSnapshot,
    status: "pending",
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    ban_id: null,
    sanction_id: null,
    updated_at: nowIso(),
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
    scope,
    report.domain_id ?? undefined,
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
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  const conditions = status === "all"
    ? []
    : [eq(communityReports.status, status)];
  const contentWhere = and(
    communityDomainWhere(communityReports.domain_id, scope),
    sql`EXISTS (
    SELECT 1 FROM community_posts WHERE community_posts.id = coalesce(${communityReports.post_id},
      (SELECT report_comment.post_id FROM community_comments report_comment WHERE report_comment.id = ${communityReports.comment_id}))
      AND ${communityDomainWhere(communityPosts.domain_id, scope)} AND ${
      communityResourceVisible(scope)
    }
  )`,
  );
  conditions.push(contentWhere!);
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
    // 被举报者：帖子取 posts.author_id，评论取 comments.author_id
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
    .leftJoin(
      targetAuthor,
      eq(
        targetAuthor.id,
        sql`COALESCE(${communityPosts.author_id}, ${communityComments.author_id})`,
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
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  if (scope && banId) throw new ValidationError("域治理不能修改全站账号封禁");
  const rows = await db.update(communityReports).set({
    status,
    resolution,
    resolved_by: actorId,
    resolved_at: nowIso(),
    updated_at: nowIso(),
    ban_id: banId ?? undefined,
    sanction_id: sanctionId ?? undefined,
  }).where(
    and(
      eq(communityReports.id, reportId),
      communityDomainWhere(communityReports.domain_id, scope),
    ),
  ).returning();
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
    scope,
    rows[0].domain_id ?? undefined,
  );
  await logAudit(
    "community.report_resolved",
    { action: "community.report_resolved", status, resolution },
    { type: "community_report", id: reportId },
  );
  return rows[0];
}

/** 撤销处理/驳回：把举报放回待处理，恢复被隐藏内容并解除关联封禁/禁言。 */
export async function reopenReport(reportId: string, scope?: CommunityScope) {
  const db = communityDb(scope);
  const current = await db.select({
    id: communityReports.id,
    post_id: communityReports.post_id,
    comment_id: communityReports.comment_id,
    ban_id: communityReports.ban_id,
    sanction_id: communityReports.sanction_id,
  }).from(communityReports).where(
    and(
      eq(communityReports.id, reportId),
      communityDomainWhere(communityReports.domain_id, scope),
    ),
  ).limit(1);
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
        updated_at: nowIso(),
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
        updated_at: nowIso(),
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
      updated_at: nowIso(),
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
      scope,
      rows[0].domain_id ?? undefined,
    );
  }
  return rows[0];
}

/** 举报目标信息（处理时需要知道被举报对象与被举报用户）。 */
export async function getReportTarget(
  reportId: string,
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
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
  }).from(communityReports)
    .leftJoin(communityPosts, eq(communityPosts.id, communityReports.post_id))
    .leftJoin(
      communityComments,
      eq(communityComments.id, communityReports.comment_id),
    )
    .where(
      and(
        eq(communityReports.id, reportId),
        communityDomainWhere(communityReports.domain_id, scope),
      ),
    ).limit(1);
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
    .where(
      and(
        eq(communityReports.id, reportId),
        communityDomainWhere(communityReports.domain_id),
      ),
    ).limit(1);
  if (!rows[0] || !rows[0].scope) return null;
  return rows[0].scope === "social" ? "social" : "platform";
}

/**
 * 获取单个举报详情（供用户可见的举报工单页）。
 * 仅举报者本人或审核员可查看。
 *
 * 赛期门控（2026-09-14 评审 High#4）：举报详情会返回被举报内容与
 * `content_snapshot` 正文。若创建时已门控（High#3），存量工单仍可能在详情页
 * 泄露全文，故此处同样门控——两条路径必须同时收口。
 *
 * @param reportId 举报工单 id。
 * @param _viewerId 查看者 id（调用方已做归属校验，此处仅保留签名兼容）。
 * @param moderator 查看者是否为审核员（审核员需看到全文以处理工单）。
 */
export async function getReportDetail(
  reportId: string,
  _viewerId: string,
  moderator = false,
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  // 同一张 community_posts 需要出现两次（被举报帖 / 评论的父帖），必须用别名
  // 区分，否则 SQL 里两个同名列引用会产生歧义（评审 #1）。
  const parentPost = aliasedTable(communityPosts, "comment_parent_post");
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
      problem_id: communityPosts.problem_id,
    },
    comment: {
      id: communityComments.id,
      content: communityComments.content,
      post_id: communityComments.post_id,
      author_id: communityComments.author_id,
    },
    // 评论所属的父帖：评论工单的 report.post_id 为 null，故 row.post 恒为 null，
    // 门控必须沿 comment -> post 这条边取父帖信息（评审 #1）。
    // **只取门控所需字段，不取父帖正文**——否则等于把被门控的题解正文随响应返回。
    parent_post: {
      type: parentPost.type,
      problem_id: parentPost.problem_id,
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
    // 父帖 join 挂在评论上：这样评论工单也能拿到"评论所在帖子"的门控依据
    .leftJoin(parentPost, eq(parentPost.id, communityComments.post_id))
    .leftJoin(userBans, eq(userBans.id, communityReports.ban_id))
    .where(
      and(
        eq(communityReports.id, reportId),
        communityDomainWhere(communityReports.domain_id, scope),
      ),
    ).limit(1);
  if (!rows[0]) throw new NotFoundError("举报不存在");
  const row = rows[0];
  if (row.report.reporter_id !== _viewerId && !moderator) {
    throw new NotFoundError("举报不存在");
  }
  if (!scope && row.report.domain_id) {
    scope = await loadCommunityScope(DEFAULT_DOMAIN_SLUG, _viewerId);
  }
  if (scope && (row.post || row.comment)) {
    try {
      await getPost(
        row.post?.id ?? row.comment!.post_id,
        _viewerId,
        moderator,
        scope,
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return {
        ...row,
        report: { ...row.report, content_snapshot: "" },
        post: null,
        comment: null,
        parent_post: null,
      };
    }
  }
  // 赛期门控（High#4 / 评审 #1）：非审核员查看存量工单时，剥离被门控的正文与快照。
  // 不抛 404——工单归属已由调用方校验，此处只需不返回受保护正文。
  //
  // 两条被举报内容的门控口径必须一致：
  // - 帖子工单：依据 report.post_id 关联到的帖子；
  // - 评论工单：report.post_id 为 null，必须依据**父帖**（comment.post_id）判定，
  //   否则 row.post 恒为 null，评论正文与 content_snapshot 会原样泄露给举报人。
  const gatedProblemId = row.post?.problem_id ??
    (row.comment ? row.parent_post?.problem_id : null);
  const gatedType = row.post?.type ??
    (row.comment ? row.parent_post?.type : null);
  if (
    !moderator && gatedProblemId && gatedType === "solution" &&
    await isProblemInUnendedPublicContest(
      gatedProblemId,
      communityDomainId(scope),
      db,
    )
  ) {
    return {
      ...row,
      report: { ...row.report, content_snapshot: "" },
      post: row.post ? { ...row.post, content: "" } : row.post,
      comment: row.comment ? { ...row.comment, content: "" } : row.comment,
    };
  }
  return row;
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
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  const sanction = {
    id: crypto.randomUUID(),
    domain_id: communityDomainId(scope),
    user_id: userId,
    reason,
    expires_at: expiresAt ?? null,
    created_by: actorId,
    created_at: nowIso(),
    updated_at: nowIso(),
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
export async function revokeSanction(
  actorId: string,
  sanctionId: string,
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  const rows = await db.update(communitySanctions).set({
    revoked_at: nowIso(),
    revoked_by: actorId,
    updated_at: nowIso(),
  }).where(
    and(
      eq(communitySanctions.id, sanctionId),
      communityDomainWhere(communitySanctions.domain_id, scope),
    ),
  ).returning();
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
export function listSanctions(scope?: CommunityScope) {
  const db = communityDb(scope);
  return db.select().from(communitySanctions).where(
    communityDomainWhere(communitySanctions.domain_id, scope),
  ).orderBy(
    desc(communitySanctions.created_at),
  );
}

/** 某用户的全部社区处罚历史（含已撤销记录），按创建时间倒序。 */
export function listUserSanctions(userId: string, scope?: CommunityScope) {
  const db = communityDb(scope);
  return db.select().from(communitySanctions).where(
    and(
      eq(communitySanctions.user_id, userId),
      communityDomainWhere(communitySanctions.domain_id, scope),
    ),
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
    community_comments_enabled: true,
    community_external_images_enabled: true,
  },
  private: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: false,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: true,
    community_comments_enabled: true,
    community_external_images_enabled: false,
  },
  knowledge: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: true,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: false,
    community_comments_enabled: false,
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
