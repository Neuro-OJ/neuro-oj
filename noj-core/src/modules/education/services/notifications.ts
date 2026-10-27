import {
  getAccountNotification,
  listAccountNotifications,
  readAccountNotifications,
} from "../../communication/contracts/account-notifications.ts";
import { createAccountNotificationTx } from "../../communication/contracts/account-notifications.ts";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { AppError, BadRequestError } from "../../../shared/base/errors.ts";
import {
  accountNotifications,
  assignments,
  domains,
  educationNotificationEmails,
  educationOutbox,
} from "../../../shared/db/schema.ts";
import type { EducationNoticeType } from "../../../shared/education-types.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import { getAssignmentFeedback } from "./feedback.ts";
import { getAssignmentHelp } from "./help.ts";
import { loadInteractionAccess } from "./interaction-access.ts";
import type { ClaimedEducationEvent } from "./progress-worker.ts";
import {
  Channels,
  publishSseEventAfterTx,
} from "../../../shared/sse/event-bus.ts";
import { recordSseEvent } from "../../../shared/sse/sse-events.ts";

/** 通知投递复用真实资源读取检查；授权失效只跳过收件人，不发送私有摘要。 */
async function canReceive(
  slug: string,
  assignmentId: string,
  userId: string,
  type: EducationNoticeType,
  payload: Record<string, unknown>,
  executor: Executor = getDb(),
) {
  try {
    if (type === "feedback") {
      await getAssignmentFeedback(
        slug,
        assignmentId,
        payload.feedback_id as string,
        userId,
        executor,
      );
    } else if (type === "help" || type === "help_reply") {
      await getAssignmentHelp(
        slug,
        assignmentId,
        payload.help_id as string,
        userId,
        1,
        executor,
      );
    } else await loadInteractionAccess(slug, assignmentId, userId, executor);
    return true;
  } catch (error) {
    if (
      error instanceof AppError && [401, 403, 404].includes(error.statusCode)
    ) return false;
    throw error;
  }
}

/** 每个领取只投递一页，租约及数据库唯一键保证重试、重启不产生重复通知。 */
export async function processEducationNotice(event: ClaimedEducationEvent) {
  if (!event.assignment_id) throw new Error("教学通知缺少任务定位");
  const type = event.payload.notice_type as EducationNoticeType;
  if (
    ![
      "assignment",
      "assignment_changed",
      "resource_unavailable",
      "feedback",
      "help",
      "help_reply",
    ].includes(type)
  ) throw new Error("教学通知类型非法");
  const delivered = await getDb().transaction(async (tx) => {
    const updates: Array<
      { channel: string; eventId: number; payload: Record<string, unknown> }
    > = [];
    const now = new Date().toISOString();
    const [current] = await tx.select().from(educationOutbox).where(
      and(
        eq(educationOutbox.id, event.id),
        eq(educationOutbox.lease_token, event.lease_token!),
        sql`${educationOutbox.leased_until} > ${now}`,
        isNull(educationOutbox.processed_at),
      ),
    ).for("update");
    if (!current) return { processed: false, updates };
    const [resource] = await tx.select({
      assignment: assignments,
      slug: domains.slug,
    }).from(assignments).innerJoin(
      domains,
      eq(domains.id, assignments.domain_id),
    )
      .where(
        and(
          eq(assignments.id, event.assignment_id!),
          eq(assignments.domain_id, event.domain_id),
        ),
      );
    if (!resource) throw new Error("教学通知任务定位无效");
    const after = current.payload._notice_after as string | undefined;
    const staff = (type === "help" || type === "help_reply") && !event.user_id;
    const lifecycle =
      ["assignment", "assignment_changed", "resource_unavailable"].includes(
        type,
      ) && !event.user_id;
    // 教学人员身份属于域；班级成员表只承载学生名单。
    const teachers = sql`SELECT dm.user_id FROM domain_memberships dm
      JOIN domain_member_roles dr ON dr.membership_id = dm.id
      WHERE dm.domain_id = ${event.domain_id} AND dm.status = 'active'
        AND dr.role IN ('educator', 'admin', 'owner')`;
    const selection = lifecycle
      ? sql`SELECT r.user_id FROM assignment_recipients r WHERE r.assignment_id = ${event
        .assignment_id!}
          UNION ${teachers}`
      : staff
      ? teachers
      : sql`SELECT r.user_id FROM assignment_recipients r WHERE r.assignment_id = ${event
        .assignment_id!}
          ${event.user_id ? sql`AND r.user_id = ${event.user_id}` : sql``}`;
    const raw = await tx.execute(
      sql`SELECT DISTINCT user_id FROM (${selection}) audience
      ${
        after
          ? sql`WHERE user_id > ${after}`
          : sql``
      } ORDER BY user_id LIMIT 50`,
    );
    const targets = unwrapRows<{ user_id: string }>(raw as never);
    for (const { user_id } of targets) {
      if (
        !(await canReceive(
          resource.slug,
          event.assignment_id!,
          user_id,
          type,
          current.payload,
          tx,
        ))
      ) continue;
      const inserted = await createAccountNotificationTx(tx, {
        id: crypto.randomUUID(),
        domain_id: event.domain_id,
        assignment_id: event.assignment_id!,
        recipient_id: user_id,
        event_id: event.id,
        type,
        feedback_id: (current.payload.feedback_id as string | null) ?? null,
        help_id: (current.payload.help_id as string | null) ?? null,
        reply_id: (current.payload.reply_id as string | null) ?? null,
        created_at: now,
      });
      if (inserted) {
        await tx.insert(educationNotificationEmails).values({
          notification_id: inserted.id,
          available_at: now,
        });
        const channel = Channels.user(user_id);
        const payload = {
          type: "notification:new",
          notification_id: inserted.id,
          domain_id: event.domain_id,
          assignment_id: event.assignment_id!,
        };
        const eventId = await recordSseEvent(channel, payload, tx);
        updates.push({ channel, eventId, payload });
      }
    }
    const complete = targets.length < 50 || !!event.user_id;
    await tx.update(educationOutbox).set({
      processed_at: complete ? now : null,
      lease_token: null,
      leased_until: null,
      payload: {
        ...current.payload,
        _notice_after: targets.at(-1)?.user_id ?? after,
      },
      available_at: now,
      last_error: null,
      attempts: 0,
    }).where(
      and(
        eq(educationOutbox.id, event.id),
        eq(educationOutbox.lease_token, event.lease_token!),
      ),
    );
    return { processed: true, updates };
  });
  for (const update of delivered.updates) {
    publishSseEventAfterTx(update.channel, update.payload, update.eventId);
  }
  return delivered.processed;
}

function visibleNotifications(
  governs: boolean | SQL,
  member: boolean | SQL,
  actorId: string,
) {
  const recipient = sql`${member} AND EXISTS (
    SELECT 1 FROM assignment_recipients r JOIN classroom_memberships cm
      ON cm.classroom_id = r.classroom_id AND cm.user_id = r.user_id
    WHERE r.assignment_id = n.assignment_id AND r.user_id = ${actorId}
      AND (cm.status = 'active' OR cm.role = 'student'))`;
  const staff = (_capability: string) => sql`${governs}`;
  return sql`a.published_at IS NOT NULL AND (
    (n.type IN ('assignment','assignment_changed','resource_unavailable') AND ((${recipient}) OR (${
    staff("progress:read")
  }) OR (${staff("assignments:manage")})))
    OR (n.type = 'feedback' AND EXISTS (SELECT 1 FROM assignment_feedback f WHERE f.id = n.feedback_id AND f.deleted_at IS NULL
      AND ((${
    staff("feedback:write")
  }) OR ((${recipient}) AND (f.target_user_id IS NULL OR f.target_user_id = ${actorId})))))
    OR (n.type IN ('help','help_reply') AND EXISTS (SELECT 1 FROM assignment_help_requests h WHERE h.id = n.help_id
      AND ((${
    staff("help:manage")
  }) OR ((${recipient}) AND h.user_id = ${actorId}))))
  )`;
}

/** 统一收件箱组合根调用；域、角色及资源关系在每次 SQL 读取时验证。 */
export function educationNotificationVisibleWhere(
  actorId: string,
  platformAdmin: boolean,
) {
  const member =
    sql`EXISTS (SELECT 1 FROM domain_memberships dm WHERE dm.domain_id = n.domain_id AND dm.user_id = ${actorId} AND dm.status = 'active')`;
  const governs =
    sql`${platformAdmin} OR EXISTS (SELECT 1 FROM domain_memberships dm
    JOIN domain_member_roles dr ON dr.membership_id = dm.id
    WHERE dm.domain_id = n.domain_id AND dm.user_id = ${actorId} AND dm.status = 'active'
      AND dr.role IN ('educator','admin','owner'))`;
  return sql`EXISTS (SELECT 1 FROM notifications n JOIN assignments a ON a.id = n.assignment_id AND a.domain_id = n.domain_id
    JOIN domains d ON d.id = n.domain_id WHERE n.id = ${accountNotifications.id}
      AND d.status <> 'suspended' AND (${platformAdmin} OR ${member})
      AND ${
    visibleNotifications(governs, sql`${platformAdmin} OR ${member}`, actorId)
  })`;
}

/** 单条通知供邮件等内部调用复用统一查询，并在发送前重验授权。 */
export async function getEducationNotification(
  slug: string,
  actorId: string,
  id: string,
) {
  const workspace = await loadWorkspace(slug, actorId);
  const row = await getAccountNotification(
    and(
      eq(accountNotifications.domain_id, workspace.domain.id),
      eq(accountNotifications.recipient_id, actorId),
      educationNotificationVisibleWhere(actorId, workspace.platformAdmin),
    )!,
    id,
  );
  return {
    ...row.notification,
    domain_id: workspace.domain.id,
    domain_slug: workspace.domain.slug,
  };
}

/** 教学内部目录复用账号收件箱查询；对外只有统一通知接口。 */
export async function listEducationNotifications(
  slug: string,
  actorId: string,
  page = 1,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("通知分页格式错误");
  }
  const workspace = await loadWorkspace(slug, actorId);
  const result = await listAccountNotifications(
    and(
      eq(accountNotifications.domain_id, workspace.domain.id),
      eq(accountNotifications.recipient_id, actorId),
      educationNotificationVisibleWhere(actorId, workspace.platformAdmin),
    )!,
    page,
    50,
  );
  return {
    ...result,
    unread: result.unread_count,
    data: result.data.map((row) => ({
      ...row.notification,
      domain_slug: workspace.domain.slug,
    })),
  };
}

/** 教学内部调用复用统一已读写入。 */
export async function markEducationNotificationRead(
  slug: string,
  id: string,
  actorId: string,
) {
  const workspace = await loadWorkspace(slug, actorId);
  await readAccountNotifications(
    and(
      eq(accountNotifications.domain_id, workspace.domain.id),
      eq(accountNotifications.recipient_id, actorId),
      educationNotificationVisibleWhere(actorId, workspace.platformAdmin),
    )!,
    id,
  );
  return { read: true };
}
