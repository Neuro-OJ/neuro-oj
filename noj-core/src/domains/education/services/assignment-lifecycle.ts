import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
} from "../../../shared/base/errors.ts";
import {
  assignmentItemHistory,
  assignmentItems,
  assignmentRecipients,
  assignments,
  domains,
} from "../../../shared/db/schema.ts";
import { recordEducationEvent } from "../../../shared/education-events.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { assertClassroomRevision } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import {
  assignmentDate,
  assignmentProblem,
  assignmentStudents,
} from "./assignments.ts";
import { educationOperation } from "./operations.ts";
import { lockTrainingExpansion } from "../../catalog/index.ts";
import { expandAssignmentTraining } from "./assignment-training.ts";

/** 发布一次性校验所有题目、版本、授权与名单，任意失败都回滚整个发布。 */
export async function publishAssignment(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  idempotencyKey: string,
) {
  return await getDb().transaction(async (tx) => {
    const initial = await loadAssignment(slug, id, actorId, { executor: tx });
    if (
      initial.assignment.source_training_id && !initial.assignment.published_at
    ) {
      await lockTrainingExpansion(
        tx,
        slug,
        initial.assignment.source_training_id,
        actorId,
      );
    }
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "assignment.publish",
      idempotencyKey,
      { id, revision },
      async () => {
        const assignment = access.assignment;
        assertClassroomRevision(assignment.revision, revision);
        if (
          !["draft", "scheduled"].includes(assignment.state)
        ) {
          throw new ConflictError("作业已发布或归档", "ASSIGNMENT_IMMUTABLE");
        }
        const now = new Date().toISOString();
        if (assignment.state === "scheduled" && assignment.publish_at! > now) {
          throw new ConflictError("未到预定发布时间", "ASSIGNMENT_NOT_DUE");
        }
        if (
          assignment.deadline_at && assignment.deadline_at <= now
        ) {
          throw new BadRequestError("发布时间必须早于截止时间");
        }
        await expandAssignmentTraining(tx, slug, actorId, assignment);
        const items = await tx.select().from(assignmentItems).where(
          eq(assignmentItems.assignment_id, id),
        ).orderBy(assignmentItems.sort_order);
        if (!items.length) throw new BadRequestError("作业至少需要一道题");
        for (const item of items) {
          const resource = await assignmentProblem(
            tx,
            slug,
            assignment.domain_id,
            actorId,
            item.binding_id,
          );
          const values = {
            published_version_id: resource.version.id,
            published_policy_mode: resource.binding.effective_version_mode,
            published_required_version_id: resource.binding.required_version_id,
            published_policy_revision: resource.binding.revision,
            answer_version_id: resource.version.id,
            policy_revision: resource.binding.revision,
            resource_available: true,
          };
          await tx.update(assignmentItems).set(values).where(
            eq(assignmentItems.id, item.id),
          );
          await tx.insert(assignmentItemHistory).values({
            id: crypto.randomUUID(),
            domain_id: assignment.domain_id,
            item_id: item.id,
            problem_id: item.problem_id,
            answer_version_id: resource.version.id,
            policy_mode: resource.binding.effective_version_mode,
            required_version_id: resource.binding.required_version_id,
            policy_revision: resource.binding.revision,
            reason: "作业发布",
            actor_id: actorId,
            created_at: now,
          });
        }
        const students = await assignmentStudents(
          tx,
          assignment.domain_id,
          assignment.classroom_id,
          assignment.target_student_ids,
        );
        if (students.length) {
          await tx.insert(assignmentRecipients).values(
            students.map(({ user_id }) => ({
              id: crypto.randomUUID(),
              domain_id: assignment.domain_id,
              classroom_id: assignment.classroom_id,
              assignment_id: id,
              user_id,
              added_by: "initial" as const,
              joined_at: now,
              credit_intervals: [{
                start: assignment.include_previous_submissions
                  ? "1970-01-01T00:00:00.000Z"
                  : now,
                end: null,
              }],
            })),
          );
        }
        const [published] = await tx.update(assignments).set({
          state: "published",
          published_at: now,
          publish_error: null,
          revision: assignment.revision + 1,
          updated_at: now,
        }).where(eq(assignments.id, id)).returning();
        await recordEducationEvent(tx, {
          domain_id: assignment.domain_id,
          assignment_id: id,
          classroom_id: assignment.classroom_id,
          event_type: "assignment.published",
        });
        await workspaceAudit(
          tx,
          actorId,
          assignment.domain_id,
          "domain.update",
          {
            operation: "assignment.publish",
            assignment_id: id,
            recipient_count: students.length,
            revision: published.revision,
          },
        );
        return published;
      },
    );
  });
}

/** 定时发布只预约草稿，实际执行时仍重新校验题目共享和发布人的教学权限。 */
export async function scheduleAssignment(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  publishAt: string,
) {
  const date = assignmentDate(publishAt, "发布时间");
  if (!date || date <= new Date().toISOString()) {
    throw new BadRequestError("预定发布时间必须在未来");
  }
  return await getDb().transaction(async (tx) => {
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomRevision(access.assignment.revision, revision);
    if (access.assignment.state !== "draft") {
      throw new ConflictError("只能预约草稿");
    }
    if (
      access.assignment.deadline_at && date >= access.assignment.deadline_at
    ) throw new BadRequestError("发布时间必须早于截止时间");
    const [scheduled] = await tx.update(assignments).set({
      state: "scheduled",
      publish_at: date,
      publish_error: null,
      revision: access.assignment.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(assignments.id, id)).returning();
    return scheduled;
  });
}

/** 延长截止必须留理由；提前结束与归档不会改动已受理提交和发布依据。 */
export async function changeAssignmentLifecycle(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  input: {
    action: "extend" | "end" | "archive";
    reason: string;
    deadline_at?: string | null;
  },
) {
  if (
    !["extend", "end", "archive"].includes(input.action) ||
    typeof input.reason !== "string" ||
    !input.reason.trim() || input.reason.length > 2000
  ) throw new BadRequestError("需要有效操作和变更理由");
  return await getDb().transaction(async (tx) => {
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    const assignment = access.assignment;
    assertClassroomRevision(assignment.revision, revision);
    if (assignment.state === "archived") throw new ConflictError("作业已归档");
    const now = new Date().toISOString();
    const changes: Partial<typeof assignments.$inferInsert> = {
      revision: assignment.revision + 1,
      updated_at: now,
    };
    if (input.action === "archive") {
      changes.state = "archived";
      changes.archived_at = now;
    } else {
      if (assignment.state !== "published" || assignment.ended_at) {
        throw new ConflictError("此作业不允许延长或结束");
      }
      if (input.action === "end") changes.ended_at = now;
      else {
        const deadline = assignmentDate(input.deadline_at, "截止时间");
        if (
          !assignment.deadline_at ||
          deadline && (deadline <= assignment.deadline_at || deadline <= now)
        ) {
          throw new BadRequestError(
            "新截止必须延后；无截止时间的作业不需要延长",
          );
        }
        changes.deadline_at = deadline;
      }
    }
    const [updated] = await tx.update(assignments).set(changes).where(
      eq(assignments.id, id),
    ).returning();
    await workspaceAudit(tx, actorId, assignment.domain_id, "domain.update", {
      operation: `assignment.${input.action}`,
      assignment_id: id,
      reason: input.reason.trim(),
      previous_deadline: assignment.deadline_at,
      deadline_at: updated.deadline_at,
      revision: updated.revision,
    });
    await recordEducationEvent(tx, {
      domain_id: assignment.domain_id,
      assignment_id: id,
      event_type: "recipient.changed",
      payload: { action: input.action },
    });
    return updated;
  });
}

/** 多副本可重复扫描到期任务，发布幂等键与班级锁保证只有一份发布结果。 */
export async function publishDueAssignments(limit = 20) {
  const db = getDb(), now = new Date().toISOString();
  const due = await db.select({ assignment: assignments, slug: domains.slug })
    .from(assignments)
    .innerJoin(domains, eq(domains.id, assignments.domain_id)).where(
      and(eq(assignments.state, "scheduled"), lte(assignments.publish_at, now)),
    ).orderBy(assignments.publish_at, assignments.id).limit(limit);
  const results: Array<{ id: string; published: boolean }> = [];
  for (const { assignment, slug } of due) {
    try {
      await publishAssignment(
        slug,
        assignment.id,
        assignment.created_by,
        assignment.revision,
        `scheduled:${assignment.id}:${assignment.revision}`,
      );
      results.push({ id: assignment.id, published: true });
    } catch (error) {
      // 仅业务校验失败转回草稿；数据库或服务故障保持预约状态等待重试。
      if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
      const rows = await db.update(assignments).set({
        state: "draft",
        publish_error: error.message,
        revision: assignment.revision + 1,
        updated_at: now,
      }).where(
        and(
          eq(assignments.id, assignment.id),
          eq(assignments.state, "scheduled"),
          eq(assignments.revision, assignment.revision),
        ),
      ).returning({ id: assignments.id });
      if (rows.length) results.push({ id: assignment.id, published: false });
    }
  }
  return results;
}
