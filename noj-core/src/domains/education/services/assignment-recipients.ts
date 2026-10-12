import { and, eq, isNotNull } from "drizzle-orm";
import { recordEducationNotice } from "../../../shared/education-events.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import { recordEducationEvent } from "../../../shared/education-events.ts";

/** 持有班级锁的成员事务同步名单；离班结束计入区间，重入不回填离班练习。 */
export async function syncStudentAssignmentRecipients(
  executor: Executor,
  domainId: string,
  classroomId: string,
  userId: string,
  activeStudent: boolean,
  now: string,
) {
  const tasks = await executor.select().from(assignments).where(and(
    eq(assignments.domain_id, domainId),
    eq(assignments.classroom_id, classroomId),
    isNotNull(assignments.published_at),
  )).orderBy(assignments.id).for("update");
  for (const task of tasks) {
    const [recipient] = await executor.select().from(assignmentRecipients)
      .where(and(
        eq(assignmentRecipients.assignment_id, task.id),
        eq(assignmentRecipients.user_id, userId),
      ));
    if (!activeStudent) {
      if (!recipient || recipient.status === "historical") continue;
      await executor.update(assignmentRecipients).set({
        status: "historical",
        left_at: now,
        credit_intervals: recipient.credit_intervals.map((w) => ({
          ...w,
          end: w.end ?? now,
        })),
      }).where(eq(assignmentRecipients.id, recipient.id));
    } else {
      if (
        task.state !== "published" ||
        !recipient &&
          (task.ended_at || task.deadline_at && task.deadline_at <= now) ||
        task.target_student_ids !== null && !recipient ||
        recipient?.status === "active"
      ) continue;
      await recordEducationNotice(executor, {
        domain_id: domainId,
        assignment_id: task.id,
        type: "assignment",
        user_id: userId,
      });
      if (recipient) {
        await executor.update(assignmentRecipients).set({
          status: "active",
          left_at: null,
          credit_intervals: [...recipient.credit_intervals, {
            start: now,
            end: null,
          }],
        }).where(eq(assignmentRecipients.id, recipient.id));
      } else {
        await executor.insert(assignmentRecipients).values({
          id: crypto.randomUUID(),
          domain_id: domainId,
          classroom_id: classroomId,
          assignment_id: task.id,
          user_id: userId,
          added_by: "automatic",
          joined_at: now,
          credit_intervals: [{
            start: task.include_previous_submissions
              ? "1970-01-01T00:00:00.000Z"
              : task.published_at!,
            end: null,
          }],
        });
      }
    }
    await recordEducationEvent(executor, {
      domain_id: domainId,
      classroom_id: classroomId,
      assignment_id: task.id,
      user_id: userId,
      event_type: "recipient.changed",
    });
  }
}
