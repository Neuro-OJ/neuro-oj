import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentRecipients,
  assignments,
  educationOutbox,
} from "../../../shared/db/schema.ts";
import { recomputeAssignmentProgress } from "./progress-materializer.ts";
import { invalidateEducationEvent } from "../../../shared/education-events.ts";
import { processEducationNotice } from "./notifications.ts";
import { Channels, publishSseEvent } from "../../../shared/sse/event-bus.ts";

/** 租约标识只用于当前数据库领取，不代表用户权限。 */
export type ClaimedEducationEvent = typeof educationOutbox.$inferSelect;

/** 短事务领取到期事件，多个进程通过 SKIP LOCKED 领取不同记录。 */
export async function claimEducationEvents(limit = 20) {
  const now = new Date().toISOString(),
    lease = new Date(Date.now() + 60000).toISOString();
  return await getDb().transaction(async (tx) => {
    const events = await tx.select().from(educationOutbox).where(and(
      isNull(educationOutbox.processed_at),
      lte(educationOutbox.available_at, now),
      or(
        isNull(educationOutbox.leased_until),
        lte(educationOutbox.leased_until, now),
      ),
    )).orderBy(educationOutbox.created_at, educationOutbox.id).limit(limit).for(
      "update",
      { skipLocked: true },
    );
    if (!events.length) return [];
    const claimed = await tx.update(educationOutbox).set({
      lease_token: crypto.randomUUID(),
      leased_until: lease,
      attempts: sql`${educationOutbox.attempts} + 1`,
    }).where(inArray(educationOutbox.id, events.map((e) => e.id))).returning();
    for (const event of claimed) {
      if (event.payload._invalidate_on_claim) {
        await invalidateEducationEvent(tx, {
          domain_id: event.domain_id,
          event_type: "submission.changed",
          user_id: event.user_id ?? undefined,
          problem_id: event.problem_id ?? undefined,
          assignment_id: event.assignment_id ?? undefined,
          classroom_id: event.classroom_id ?? undefined,
        });
        event.payload = { ...event.payload, _invalidate_on_claim: false };
        await tx.update(educationOutbox).set({ payload: event.payload }).where(
          eq(educationOutbox.id, event.id),
        );
      }
    }
    return claimed;
  });
}

type EducationCursor = {
  assignment_after?: string;
  assignment_id?: string;
  student_after?: string;
};

/** 每次只处理一个任务的一页学生，持久游标让大量名单也可在重启后继续。 */
export async function processEducationEvent(event: ClaimedEducationEvent) {
  if (event.event_type === "notification") {
    return await processEducationNotice(event);
  }
  const db = getDb(),
    cursor = (event.payload._education_cursor ?? {}) as EducationCursor;
  const query = db.select().from(assignments).where(
    and(
      eq(assignments.domain_id, event.domain_id),
      isNotNull(assignments.published_at),
      cursor.assignment_id
        ? eq(assignments.id, cursor.assignment_id)
        : cursor.assignment_after
        ? gt(assignments.id, cursor.assignment_after)
        : undefined,
      event.assignment_id ? eq(assignments.id, event.assignment_id) : undefined,
      event.classroom_id
        ? eq(assignments.classroom_id, event.classroom_id)
        : undefined,
      event.problem_id
        ? sql`EXISTS (SELECT 1 FROM assignment_items i WHERE i.assignment_id = ${assignments.id} AND i.problem_id = ${event.problem_id})`
        : undefined,
      event.user_id
        ? sql`EXISTS (SELECT 1 FROM assignment_recipients r WHERE r.assignment_id = ${assignments.id} AND r.user_id = ${event.user_id})`
        : undefined,
    ),
  ).orderBy(assignments.id).limit(1);
  const [assignment] = await query;
  const now = new Date().toISOString();
  if (!assignment) {
    const rows = await db.update(educationOutbox).set({
      processed_at: now,
      lease_token: null,
      leased_until: null,
      last_error: null,
    }).where(
      and(
        eq(educationOutbox.id, event.id),
        eq(educationOutbox.lease_token, event.lease_token!),
      ),
    ).returning({ id: educationOutbox.id });
    return rows.length > 0;
  }
  const students = await db.select({ user_id: assignmentRecipients.user_id })
    .from(assignmentRecipients).where(and(
      eq(assignmentRecipients.assignment_id, assignment.id),
      event.user_id
        ? eq(assignmentRecipients.user_id, event.user_id)
        : undefined,
      cursor.student_after
        ? gt(assignmentRecipients.user_id, cursor.student_after)
        : undefined,
    )).orderBy(assignmentRecipients.user_id).limit(50);
  const projection = await recomputeAssignmentProgress(
    assignment.id,
    students.map((s) => s.user_id),
  );
  const next: EducationCursor = projection?.history_pending
    ? { assignment_id: assignment.id, student_after: cursor.student_after }
    : students.length < 50
    ? { assignment_after: assignment.id }
    : { assignment_id: assignment.id, student_after: students.at(-1)!.user_id };
  const rows = await db.update(educationOutbox).set({
    payload: { ...event.payload, _education_cursor: next },
    available_at: now,
    leased_until: null,
    lease_token: null,
    last_error: null,
    attempts: 0,
  }).where(and(
    eq(educationOutbox.id, event.id),
    eq(educationOutbox.lease_token, event.lease_token!),
  )).returning({ id: educationOutbox.id });
  if (rows.length) {
    await publishSseEvent(Channels.education(event.domain_id), {
      type: "education:sync",
      domain_id: event.domain_id,
      assignment_id: assignment.id,
    });
  }
  return rows.length > 0;
}

/** 一批处理失败保留事件并退避，重试读取最新事实，不累计旧载荷中的成绩。 */
export async function processEducationBatch(limit = 20) {
  const events = await claimEducationEvents(limit),
    results: Array<{ id: string; succeeded: boolean }> = [];
  for (const event of events) {
    try {
      results.push({
        id: event.id,
        succeeded: await processEducationEvent(event),
      });
    } catch (error) {
      const delay = Math.min(60000, 1000 * 2 ** Math.min(event.attempts, 6));
      await getDb().update(educationOutbox).set({
        leased_until: null,
        lease_token: null,
        available_at: new Date(Date.now() + delay).toISOString(),
        last_error: error instanceof Error ? error.name : "Error",
      }).where(
        and(
          eq(educationOutbox.id, event.id),
          eq(educationOutbox.lease_token, event.lease_token!),
        ),
      );
      results.push({ id: event.id, succeeded: false });
    }
  }
  return results;
}
