import type { DbRoot, DbTx } from "../../../shared/db/executor.ts";
import { queryProjectionRevisions } from "../../../shared/db/schema.ts";
import { sql } from "drizzle-orm";
import type { EducationNoticeType } from "../../../shared/education-types.ts";
import {
  enqueueOrReviveTaskTx,
  enqueueTaskTx,
} from "../../../shared/tasks/repository.ts";
import type {
  EnqueueTaskResult,
  TaskPayload,
} from "../../../shared/tasks/contracts.ts";

/** 教学事件在 `background_tasks` 中的任务类型与 payload 结构版本。 */
export const EDUCATION_TASK_TYPE = "education.recompute";
export const EDUCATION_TASK_PAYLOAD_VERSION = 2;

/**
 * 教学事件即一条 `education.recompute` 后台任务。
 *
 * 事实定位字段放在顶层；`data` 承载事件附加信息（比赛 id、通知类型等）以及
 * 处理过程中的可恢复游标（`_education_cursor` / `_notice_after`）和到期失效
 * 标记（`_invalidate_on_claim`）。`event_id` 是通知投递的幂等键。
 */
export interface EducationTaskPayload extends TaskPayload {
  readonly event_id: string;
  readonly domain_id: string;
  readonly event_type: EducationEvent["event_type"];
  readonly user_id: string | null;
  readonly problem_id: string | null;
  readonly classroom_id: string | null;
  readonly assignment_id: string | null;
  readonly data: Record<string, unknown>;
}

/** 在业务事务内登记教学事件任务；同一事件只登记一次。 */
async function enqueueEducationTaskTx(
  tx: DbTx,
  event: EducationEvent,
  options: {
    eventId?: string;
    availableAt?: string;
    data?: Record<string, unknown>;
    revive?: { dedupeKey: string };
  } = {},
): Promise<EnqueueTaskResult> {
  const eventId = options.eventId ?? crypto.randomUUID();
  const payload: EducationTaskPayload = {
    event_id: eventId,
    domain_id: event.domain_id,
    event_type: event.event_type,
    user_id: event.user_id ?? null,
    problem_id: event.problem_id ?? null,
    classroom_id: event.classroom_id ?? null,
    assignment_id: event.assignment_id ?? null,
    data: options.data ?? event.payload ?? {},
  };
  const input = {
    taskType: EDUCATION_TASK_TYPE,
    targetKind: event.assignment_id ? "assignment" : "domain",
    targetId: event.assignment_id ?? event.domain_id,
    dedupeKey: options.revive?.dedupeKey ?? `event:${eventId}`,
    payloadVersion: EDUCATION_TASK_PAYLOAD_VERSION,
    payload,
    availableAt: options.availableAt,
  } as const;
  return options.revive
    ? await enqueueOrReviveTaskTx(tx, input)
    : await enqueueTaskTx(tx, input);
}

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
  const delayed = !!options.availableAt && options.availableAt > now;
  await enqueueEducationTaskTx(tx, event, {
    availableAt: options.availableAt,
    data: {
      ...event.payload,
      ...(delayed ? { _invalidate_on_claim: true } : {}),
    },
  });
  if (!delayed) await invalidateEducationEvent(tx, event);
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
  await enqueueEducationTaskTx(tx, {
    domain_id: notice.domain_id,
    assignment_id: notice.assignment_id,
    user_id: notice.user_id,
    event_type: "notification",
    payload: {
      notice_type: notice.type,
      feedback_id: notice.feedback_id ?? null,
      help_id: notice.help_id ?? null,
      reply_id: notice.reply_id ?? null,
    },
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

/**
 * 业务事务已经存在时使用的刷新登记合同。
 *
 * 同一任务 + 学生同时只保留一条未完成的刷新；已完成的刷新会被原地复活。
 */
export async function enqueueEducationRefreshTx(
  tx: DbTx,
  domainId: string,
  assignmentId: string,
  userId?: string,
) {
  await enqueueEducationTaskTx(tx, {
    domain_id: domainId,
    assignment_id: assignmentId,
    user_id: userId,
    event_type: "assignment.refresh",
  }, { revive: { dedupeKey: `refresh:${userId ?? ""}` } });
}
