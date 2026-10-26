import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  assignmentRecipients,
  assignments,
  classroomMemberships,
  domains,
  educationNotificationEmails,
  educationNotifications,
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
    const audience = lifecycle
      ? tx.execute(sql`SELECT user_id FROM (
        SELECT r.user_id FROM assignment_recipients r WHERE r.assignment_id = ${event
        .assignment_id!}
        UNION
        SELECT cm.user_id FROM classroom_memberships cm WHERE cm.classroom_id = ${resource.assignment.classroom_id}
          AND cm.status = 'active' AND (cm.role = 'coach' OR (cm.role = 'assistant' AND EXISTS
            (SELECT 1 FROM classroom_assistant_grants g WHERE g.membership_id = cm.id
              AND g.capability IN ('progress:read', 'assignments:manage'))))
      ) audience ${
        after ? sql`WHERE user_id > ${after}` : sql``
      } ORDER BY user_id LIMIT 50`)
      : staff
      ? tx.select({ user_id: classroomMemberships.user_id }).from(
        classroomMemberships,
      ).where(and(
        eq(classroomMemberships.classroom_id, resource.assignment.classroom_id),
        eq(classroomMemberships.status, "active"),
        sql`(${classroomMemberships.role} = 'coach' OR (${classroomMemberships.role} = 'assistant' AND EXISTS
          (SELECT 1 FROM classroom_assistant_grants g WHERE g.membership_id = ${classroomMemberships.id} AND g.capability = 'help:manage')))`,
        after ? gt(classroomMemberships.user_id, after) : undefined,
      )).orderBy(classroomMemberships.user_id).limit(50)
      : tx.select({ user_id: assignmentRecipients.user_id }).from(
        assignmentRecipients,
      ).where(and(
        eq(assignmentRecipients.assignment_id, event.assignment_id!),
        event.user_id
          ? eq(assignmentRecipients.user_id, event.user_id)
          : undefined,
        after ? gt(assignmentRecipients.user_id, after) : undefined,
      )).orderBy(assignmentRecipients.user_id).limit(50);
    const raw = await audience;
    const targets = lifecycle
      ? unwrapRows<{ user_id: string }>(raw as never)
      : raw as { user_id: string }[];
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
      const [inserted] = await tx.insert(educationNotifications).values({
        id: crypto.randomUUID(),
        domain_id: event.domain_id,
        assignment_id: event.assignment_id!,
        user_id,
        event_id: event.id,
        type,
        feedback_id: (current.payload.feedback_id as string | null) ?? null,
        help_id: (current.payload.help_id as string | null) ?? null,
        reply_id: (current.payload.reply_id as string | null) ?? null,
        created_at: now,
      }).onConflictDoNothing().returning({ id: educationNotifications.id });
      if (inserted) {
        await tx.insert(educationNotificationEmails).values({
          notification_id: inserted.id,
          available_at: now,
        });
        const channel = Channels.user(user_id);
        const payload = {
          type: "education:notification",
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
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  actorId: string,
) {
  const governs = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("classroom:manage_any");
  const recipient = sql`${
    !!workspace.membership || workspace.platformAdmin
  } AND EXISTS (
    SELECT 1 FROM assignment_recipients r JOIN classroom_memberships cm
      ON cm.classroom_id = r.classroom_id AND cm.user_id = r.user_id
    WHERE r.assignment_id = n.assignment_id AND r.user_id = ${actorId}
      AND (cm.status = 'active' OR cm.role = 'student'))`;
  const staff = (capability: string) =>
    sql`${governs} OR (${!!workspace
      .membership} AND EXISTS (SELECT 1 FROM classroom_memberships cm
    WHERE cm.classroom_id = a.classroom_id AND cm.user_id = ${actorId} AND cm.status = 'active'
      AND (cm.role = 'coach' OR (cm.role = 'assistant' AND EXISTS (SELECT 1 FROM classroom_assistant_grants g
        WHERE g.membership_id = cm.id AND g.capability = ${capability})))))`;
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

type NotificationRow = {
  id: string;
  type: EducationNoticeType;
  assignment_id: string;
  feedback_id: string | null;
  help_id: string | null;
  reply_id: string | null;
  created_at: string;
  read_at: string | null;
};

/** 单条通知读取用于实时推送和邮件投递，重新检查当前域与具体资源关系。 */
export async function getEducationNotification(
  slug: string,
  actorId: string,
  id: string,
) {
  const workspace = await loadWorkspace(slug, actorId);
  const result = await getDb().execute(
    sql`SELECT n.id, n.type, n.assignment_id, n.feedback_id, n.help_id, n.reply_id, n.created_at, n.read_at
    FROM education_notifications n JOIN assignments a ON a.id = n.assignment_id
    WHERE n.id = ${id} AND n.domain_id = ${workspace.domain.id} AND n.user_id = ${actorId} AND ${
      visibleNotifications(workspace, actorId)
    }`,
  );
  const [notification] = unwrapRows<NotificationRow>(result as never);
  if (!notification) throw new NotFoundError("通知不存在或不可访问");
  return {
    ...notification,
    domain_id: workspace.domain.id,
    domain_slug: workspace.domain.slug,
  };
}

/** 通知目录在计数及分页前检查当前教学关系；摘要只说明类型，不返回私有正文。 */
export async function listEducationNotifications(
  slug: string,
  actorId: string,
  page = 1,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("通知分页格式错误");
  }
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const condition =
    sql`n.domain_id = ${workspace.domain.id} AND n.user_id = ${actorId} AND ${
      visibleNotifications(workspace, actorId)
    }`;
  const countResult = await db.execute(
    sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE n.read_at IS NULL)::int AS unread
    FROM education_notifications n JOIN assignments a ON a.id = n.assignment_id WHERE ${condition}`,
  );
  const [counts] = unwrapRows<{ total: number; unread: number }>(
    countResult as never,
  );
  const result = await db.execute(
    sql`SELECT n.id, n.type, n.assignment_id, n.feedback_id, n.help_id, n.reply_id, n.created_at, n.read_at
    FROM education_notifications n JOIN assignments a ON a.id = n.assignment_id WHERE ${condition}
    ORDER BY n.created_at DESC, n.id DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
  );
  return {
    page,
    per_page: 50,
    ...counts,
    data: unwrapRows<NotificationRow>(result as never),
  };
}

/** 已读操作也重新验证范围，不用裸 ID 修改其他域或他人的通知。 */
export async function markEducationNotificationRead(
  slug: string,
  id: string,
  actorId: string,
) {
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const result = await db.execute(
    sql`SELECT n.id FROM education_notifications n JOIN assignments a ON a.id = n.assignment_id
    WHERE n.id = ${id} AND n.domain_id = ${workspace.domain.id} AND n.user_id = ${actorId} AND ${
      visibleNotifications(workspace, actorId)
    }`,
  );
  if (!unwrapRows<{ id: string }>(result as never).length) {
    throw new NotFoundError("通知不存在或不可访问");
  }
  await db.update(educationNotifications).set({
    read_at: new Date().toISOString(),
  }).where(eq(educationNotifications.id, id));
  return { read: true };
}
