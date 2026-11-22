import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import type {
  ClaimedTask,
  TaskHandler,
  TaskRescheduleResult,
} from "../../../shared/tasks/contracts.ts";
import {
  lockLeasedTaskTx,
  updateLeasedTaskPayloadTx,
} from "../../../shared/tasks/repository.ts";
import { recomputeAssignmentProgress } from "./progress-materializer.ts";
import {
  EDUCATION_TASK_PAYLOAD_VERSION,
  type EducationTaskPayload,
  invalidateEducationEvent,
} from "../contracts/facts.ts";
import { processEducationNotice } from "./notifications.ts";
import { Channels, publishSseEvent } from "../../../shared/sse/event-bus.ts";

/** 一次领取处理一页；`payload` 为下一页的可恢复依据，`done` 表示事件已处理完。 */
export type EducationStep =
  | { readonly done: true; readonly skipped?: string }
  | { readonly done: false; readonly payload: EducationTaskPayload };

type EducationCursor = {
  assignment_after?: string;
  assignment_id?: string;
  student_after?: string;
};

function readEducationPayload(task: ClaimedTask): EducationTaskPayload {
  const payload = task.payload as Partial<EducationTaskPayload>;
  if (
    task.payloadVersion !== EDUCATION_TASK_PAYLOAD_VERSION ||
    typeof payload.domain_id !== "string" ||
    typeof payload.event_type !== "string" ||
    typeof payload.event_id !== "string"
  ) {
    throw new TypeError("教学任务 payload 版本或结构无效");
  }
  return { ...payload, data: payload.data ?? {} } as EducationTaskPayload;
}

/**
 * 到期事件（比赛结束后才公开的成绩）在首次领取时递增事实版本。
 *
 * 失效与清除标记在同一事务内、以租约为条件完成，重复领取不会重复失效。
 */
async function invalidateOnClaim(
  task: ClaimedTask,
  payload: EducationTaskPayload,
): Promise<EducationTaskPayload | null> {
  if (!payload.data._invalidate_on_claim) return payload;
  const next: EducationTaskPayload = {
    ...payload,
    data: { ...payload.data, _invalidate_on_claim: false },
  };
  const held = await getDb().transaction(async (tx) => {
    if (!(await lockLeasedTaskTx(tx, task.id, task.leaseToken))) return false;
    await invalidateEducationEvent(tx, {
      domain_id: payload.domain_id,
      event_type: "submission.changed",
      user_id: payload.user_id ?? undefined,
      problem_id: payload.problem_id ?? undefined,
      assignment_id: payload.assignment_id ?? undefined,
      classroom_id: payload.classroom_id ?? undefined,
    });
    return await updateLeasedTaskPayloadTx(tx, task.id, task.leaseToken, next);
  });
  return held ? next : null;
}

/** 每次只处理一个任务的一页学生，持久游标让大量名单也可在重启后继续。 */
async function recomputeEducationPage(
  payload: EducationTaskPayload,
): Promise<EducationStep> {
  const db = getDb(),
    cursor = (payload.data._education_cursor ?? {}) as EducationCursor;
  const [assignment] = await db.select().from(assignments).where(
    and(
      eq(assignments.domain_id, payload.domain_id),
      isNotNull(assignments.published_at),
      cursor.assignment_id
        ? eq(assignments.id, cursor.assignment_id)
        : cursor.assignment_after
        ? gt(assignments.id, cursor.assignment_after)
        : undefined,
      payload.assignment_id
        ? eq(assignments.id, payload.assignment_id)
        : undefined,
      payload.classroom_id
        ? eq(assignments.classroom_id, payload.classroom_id)
        : undefined,
      payload.problem_id
        ? sql`EXISTS (SELECT 1 FROM assignment_items i WHERE i.assignment_id = ${assignments.id} AND i.problem_id = ${payload.problem_id})`
        : undefined,
      payload.user_id
        ? sql`EXISTS (SELECT 1 FROM assignment_recipients r WHERE r.assignment_id = ${assignments.id} AND r.user_id = ${payload.user_id})`
        : undefined,
    ),
  ).orderBy(assignments.id).limit(1);
  if (!assignment) return { done: true };
  const students = await db.select({ user_id: assignmentRecipients.user_id })
    .from(assignmentRecipients).where(and(
      eq(assignmentRecipients.assignment_id, assignment.id),
      payload.user_id
        ? eq(assignmentRecipients.user_id, payload.user_id)
        : undefined,
      cursor.student_after
        ? gt(assignmentRecipients.user_id, cursor.student_after)
        : undefined,
    )).orderBy(assignmentRecipients.user_id).limit(50);
  await recomputeAssignmentProgress(
    assignment.id,
    students.map((s) => s.user_id),
  );
  await publishSseEvent(Channels.education(payload.domain_id), {
    type: "education:sync",
    domain_id: payload.domain_id,
    assignment_id: assignment.id,
  });
  const next: EducationCursor = students.length < 50
    ? { assignment_after: assignment.id }
    : { assignment_id: assignment.id, student_after: students.at(-1)!.user_id };
  return {
    done: false,
    payload: {
      ...payload,
      data: { ...payload.data, _education_cursor: next },
    },
  };
}

/**
 * 处理一条已领取的教学任务的一页。
 *
 * 成绩重算读取最新事实且幂等；通知投递在同一事务内复核租约并推进游标。
 */
export async function processEducationStep(
  task: ClaimedTask,
): Promise<EducationStep> {
  const payload = await invalidateOnClaim(task, readEducationPayload(task));
  if (!payload) return { done: true, skipped: "lease_lost" };
  if (payload.event_type === "notification") {
    return await processEducationNotice(task, payload);
  }
  return await recomputeEducationPage(payload);
}

/**
 * `education.recompute` 后台任务处理器。
 *
 * 每次只处理一页；未完成时返回 reschedule，由通用 worker 以租约为条件把新
 * payload 写回并重新置为 pending。
 */
export const processEducationTask: TaskHandler = async (task, signal) => {
  if (signal.aborted) throw new DOMException("任务已取消", "AbortError");
  const step = await processEducationStep(task);
  if (step.done) {
    return {
      event_id: (task.payload as Partial<EducationTaskPayload>).event_id ??
        null,
      ...(step.skipped ? { skipped: step.skipped } : {}),
    };
  }
  if (signal.aborted) throw new DOMException("任务已取消", "AbortError");
  const result: TaskRescheduleResult = {
    __task_control: "reschedule",
    availableAt: new Date().toISOString(),
    payload: step.payload,
  };
  return result;
};
