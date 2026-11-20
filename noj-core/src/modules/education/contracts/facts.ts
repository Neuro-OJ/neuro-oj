import type { DbRoot, DbTx } from "../../../shared/db/executor.ts";
import {
  educationOutbox,
  queryProjectionRevisions,
} from "../../../shared/db/schema.ts";
import { sql } from "drizzle-orm";
import type { EducationNoticeType } from "../../../shared/education-types.ts";
import { enqueueEducationOutboxTaskTx } from "./outbox-migration.ts";

/** 生产者只登记事实定位，消费者从数据库读取最新结果，不信任事件里的成绩。 */
export interface EducationEvent {
  domain_id: string;
  event_type:
    | "submission.changed"
    | "problem.changed"
    | "recipient.changed"
    | "assignment.published"
    | "assignment.refresh"
    | "notification"
    | "module.changed";
  user_id?: string;
  problem_id?: string;
  classroom_id?: string;
  assignment_id?: string;
  payload?: Record<string, unknown>;
}

/** 必须传入业务事务，保证事实写入与教学事件共同提交或回滚。 */
export async function recordEducationEvent(
  tx: DbTx,
  event: EducationEvent,
  options: { availableAt?: string } = {},
) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    ...event,
    created_at: now,
    available_at: options.availableAt ?? now,
    payload: {
      ...event.payload,
      ...(options.availableAt && options.availableAt > now
        ? { _invalidate_on_claim: true }
        : {}),
    },
  } satisfies typeof educationOutbox.$inferInsert;
  await tx.insert(educationOutbox).values(row);
  await enqueueEducationOutboxTaskTx(tx, {
    ...row,
    user_id: row.user_id ?? null,
    problem_id: row.problem_id ?? null,
    classroom_id: row.classroom_id ?? null,
    assignment_id: row.assignment_id ?? null,
    payload: row.payload ?? {},
    leased_until: null,
    lease_token: null,
    attempts: 0,
    processed_at: null,
    last_error: null,
  });
  if (!options.availableAt || options.availableAt <= now) {
    await invalidateEducationEvent(tx, event);
  }
}

/** 到期事件开始处理时再递增事实版本，比赛结束前不会提前标为已公开成绩。 */
export async function invalidateEducationEvent(
  tx: DbTx,
  event: EducationEvent,
) {
  const [clock] = await tx.insert(queryProjectionRevisions).values({
    scope_key: educationRevisionScope(event.domain_id),
    data_revision: 1,
    materialized_revision: 0,
  }).onConflictDoUpdate({
    target: queryProjectionRevisions.scope_key,
    set: { data_revision: sql`${queryProjectionRevisions.data_revision} + 1` },
  }).returning({ revision: queryProjectionRevisions.data_revision });
  await tx.insert(queryProjectionRevisions).values({
    scope_key: educationEventScope(event),
    data_revision: clock.revision,
    materialized_revision: 0,
  }).onConflictDoUpdate({
    target: queryProjectionRevisions.scope_key,
    set: { data_revision: clock.revision },
  });
}

/** 互动事实和通知事件同事务落库；通知不使成绩投影失效。 */
export async function recordEducationNotice(tx: DbTx, notice: {
  domain_id: string;
  assignment_id: string;
  type: EducationNoticeType;
  user_id?: string;
  feedback_id?: string;
  help_id?: string;
  reply_id?: string;
}) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    domain_id: notice.domain_id,
    assignment_id: notice.assignment_id,
    user_id: notice.user_id,
    event_type: "notification",
    created_at: now,
    available_at: now,
    payload: {
      notice_type: notice.type,
      feedback_id: notice.feedback_id ?? null,
      help_id: notice.help_id ?? null,
      reply_id: notice.reply_id ?? null,
    },
  } satisfies typeof educationOutbox.$inferInsert;
  await tx.insert(educationOutbox).values(row);
  await enqueueEducationOutboxTaskTx(tx, {
    ...row,
    user_id: row.user_id ?? null,
    problem_id: null,
    classroom_id: null,
    assignment_id: row.assignment_id ?? null,
    leased_until: null,
    lease_token: null,
    attempts: 0,
    processed_at: null,
    last_error: null,
  });
}

/** 教学事实版本用于识别异步投影陈旧，计数持久化于数据库。 */
export function educationRevisionScope(domainId: string) {
  return `education:domain:${domainId}`;
}

/** 事实版本只让受影响单元陈旧，其他学生或题目不因无关评测而全部补算。 */
export function educationEventScope(event: EducationEvent) {
  const base = educationRevisionScope(event.domain_id);
  if (event.assignment_id) {
    return `${base}:assignment:${event.assignment_id}${
      event.user_id ? `:user:${event.user_id}` : ""
    }`;
  }
  if (event.classroom_id) {
    return `${base}:class:${event.classroom_id}${
      event.user_id ? `:user:${event.user_id}` : ""
    }`;
  }
  if (event.user_id && event.problem_id) {
    return `${base}:cell:${event.user_id}:${event.problem_id}`;
  }
  if (event.problem_id) return `${base}:problem:${event.problem_id}`;
  if (event.user_id) return `${base}:user:${event.user_id}`;
  return `${base}:all`;
}

/** 一份进度读取这些事实版本，最大值是单调的 Domain 事实时钟。 */
export function educationCellScopes(
  domainId: string,
  classroomId: string,
  assignmentId: string,
  userId: string,
  problemId: string,
) {
  const base = educationRevisionScope(domainId);
  return [
    `${base}:all`,
    `${base}:assignment:${assignmentId}`,
    `${base}:assignment:${assignmentId}:user:${userId}`,
    `${base}:class:${classroomId}`,
    `${base}:class:${classroomId}:user:${userId}`,
    `${base}:problem:${problemId}`,
    `${base}:user:${userId}`,
    `${base}:cell:${userId}:${problemId}`,
  ];
}

/** 读取过期投影只请求补算，不改变事实版本；数据库唯一索引合并并发刷新。 */
export async function enqueueEducationRefresh(
  db: DbRoot,
  domainId: string,
  assignmentId: string,
  userId?: string,
) {
  await db.transaction((tx) =>
    enqueueEducationRefreshTx(tx, domainId, assignmentId, userId)
  );
}

/** 业务事务已经存在时使用的刷新登记合同。 */
export async function enqueueEducationRefreshTx(
  tx: DbTx,
  domainId: string,
  assignmentId: string,
  userId?: string,
) {
  const now = new Date().toISOString();
  const rows = await tx.insert(educationOutbox).values({
    id: crypto.randomUUID(),
    domain_id: domainId,
    assignment_id: assignmentId,
    user_id: userId,
    event_type: "assignment.refresh",
    created_at: now,
    available_at: now,
  }).onConflictDoNothing().returning();
  const row = rows[0];
  if (row) await enqueueEducationOutboxTaskTx(tx, row);
}
