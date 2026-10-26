import { and, count, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { assignmentFeedback, users } from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { educationOperation } from "./operations.ts";
import { assertClassroomCapability } from "./access.ts";
import {
  assertFeedbackAuthor,
  assertInteractionRecipient,
  interactionRevision,
  interactionStaff,
  interactionText,
  loadInteractionAccess,
} from "./interaction-access.ts";
import { recordEducationNotice } from "../../../shared/education-events.ts";

/** 整体及学生反馈通过同一服务保存，目标范围发布后不能静默修改。 */
export async function createAssignmentFeedback(
  slug: string,
  id: string,
  actorId: string,
  key: string,
  input: { body: string; target_user_id?: string | null },
) {
  const body = interactionText(input.body),
    target = input.target_user_id ?? null;
  if (target !== null && (typeof target !== "string" || !target)) {
    throw new BadRequestError("反馈目标格式错误");
  }
  return await getDb().transaction(async (tx) => {
    const access = await loadInteractionAccess(slug, id, actorId, tx, true);
    assertClassroomCapability(access, "feedback:write");
    if (target) await assertInteractionRecipient(access, target, tx);
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "feedback.create",
      key,
      { id, body, target },
      async () => {
        const now = new Date().toISOString();
        const [feedback] = await tx.insert(assignmentFeedback).values({
          id: crypto.randomUUID(),
          domain_id: access.domain.id,
          assignment_id: id,
          target_user_id: target,
          author_id: actorId,
          body,
          created_at: now,
          updated_at: now,
        }).returning();
        await recordEducationNotice(tx, {
          domain_id: access.domain.id,
          assignment_id: id,
          type: "feedback",
          feedback_id: feedback.id,
          user_id: target ?? undefined,
        });
        await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
          operation: "feedback.create",
          assignment_id: id,
          feedback_id: feedback.id,
          target_user_id: target,
        });
        return feedback;
      },
    );
  });
}

/** 私人学生反馈先过滤再分页，不能从总数或目录看到同学的反馈。 */
export async function listAssignmentFeedback(
  slug: string,
  id: string,
  actorId: string,
  page = 1,
) {
  const access = await loadInteractionAccess(slug, id, actorId);
  const all = interactionStaff(access, "feedback:write");
  if (!all) await assertInteractionRecipient(access, actorId);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("分页格式错误");
  }
  const db = getDb(),
    where = and(
      eq(assignmentFeedback.assignment_id, id),
      isNull(assignmentFeedback.deleted_at),
      all ? undefined : or(
        isNull(assignmentFeedback.target_user_id),
        eq(assignmentFeedback.target_user_id, actorId),
      ),
    );
  const [total] = await db.select({ count: count() }).from(assignmentFeedback)
    .where(where);
  const rows = await db.select({
    feedback: assignmentFeedback,
    username: users.username,
    deleted_at: users.deleted_at,
  }).from(assignmentFeedback)
    .innerJoin(users, eq(users.id, assignmentFeedback.author_id)).where(where)
    .orderBy(assignmentFeedback.created_at, assignmentFeedback.id).limit(50)
    .offset((page - 1) * 50);
  return {
    page,
    per_page: 50,
    total: total.count,
    data: rows.map((row) => ({
      ...row.feedback,
      author_name: row.deleted_at ? "已注销账号" : row.username,
    })),
  };
}

/** 通知点击及详情读取再次校验当前关系，而不是信任曾收到的反馈 ID。 */
export async function getAssignmentFeedback(
  slug: string,
  id: string,
  feedbackId: string,
  actorId: string,
) {
  const access = await loadInteractionAccess(slug, id, actorId),
    all = interactionStaff(access, "feedback:write");
  if (!all) await assertInteractionRecipient(access, actorId);
  const [row] = await getDb().select({
    feedback: assignmentFeedback,
    username: users.username,
    deleted_at: users.deleted_at,
  }).from(assignmentFeedback)
    .innerJoin(users, eq(users.id, assignmentFeedback.author_id)).where(
      and(
        eq(assignmentFeedback.assignment_id, id),
        eq(assignmentFeedback.id, feedbackId),
        isNull(assignmentFeedback.deleted_at),
        all ? undefined : or(
          isNull(assignmentFeedback.target_user_id),
          eq(assignmentFeedback.target_user_id, actorId),
        ),
      ),
    );
  if (!row) throw new NotFoundError("反馈不存在或不可访问");
  return {
    ...row.feedback,
    author_name: row.deleted_at ? "已注销账号" : row.username,
  };
}

/** 原作者编辑；教练及域治理可撤回他人反馈，正文和作者历史仍保留在库中。 */
export async function updateAssignmentFeedback(
  slug: string,
  id: string,
  feedbackId: string,
  actorId: string,
  revision: number | null,
  input: { body?: string; withdraw?: boolean },
) {
  const body = input.withdraw ? null : interactionText(input.body!);
  return await getDb().transaction(async (tx) => {
    const access = await loadInteractionAccess(slug, id, actorId, tx, true);
    assertClassroomCapability(access, "feedback:write");
    const [row] = await tx.select().from(assignmentFeedback).where(
      and(
        eq(assignmentFeedback.assignment_id, id),
        eq(assignmentFeedback.id, feedbackId),
        isNull(assignmentFeedback.deleted_at),
      ),
    ).for("update");
    if (!row) throw new NotFoundError("反馈不存在或已撤回");
    interactionRevision(row.revision, revision);
    if (!input.withdraw) assertFeedbackAuthor(row.author_id, actorId);
    else if (
      row.author_id !== actorId && !access.managesDomain &&
      access.classMembership?.role !== "coach"
    ) throw new ForbiddenError("助教不能撤回其他作者的反馈");
    const now = new Date().toISOString();
    const [updated] = await tx.update(assignmentFeedback).set({
      ...(body !== null ? { body } : { deleted_at: now }),
      revision: row.revision + 1,
      updated_at: now,
    })
      .where(eq(assignmentFeedback.id, feedbackId)).returning();
    if (body !== null) {
      await recordEducationNotice(tx, {
        domain_id: access.domain.id,
        assignment_id: id,
        type: "feedback",
        feedback_id: feedbackId,
        user_id: row.target_user_id ?? undefined,
      });
    }
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: input.withdraw ? "feedback.withdraw" : "feedback.update",
      feedback_id: feedbackId,
      revision: updated.revision,
    });
    return updated;
  });
}
