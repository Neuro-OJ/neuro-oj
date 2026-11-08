// 队列管理操作：移除待处理提交、发布队列变更信号与查询提交队列状态。
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { selfTests, submissions } from "../../../../shared/db/schema.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "../../../../shared/sse/event-bus.ts";
import { logAudit } from "../../../platform/contracts/cross-module/system_services_audit-log.ts";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { getPendingQueuePosition, JUDGE_QUEUE_LIST } from "./pending.ts";
import type { SubmissionStatusResponse } from "./overview.ts";

/** 普通队列通知只发到提交的使用域；共享池健康信息另走平台治理接口。 */
export function queueEventChannel(domainId: string) {
  return domainId === DEFAULT_DOMAIN_ID
    ? Channels.queue
    : `noj:events:domain:${domainId}:queue`;
}
/** 全局频道只包含失效信号，不包含域、任务或评测内容。 */
export const INSTANCE_QUEUE_CHANNEL = "noj:events:instance:queue";

/** 归属从可信源记录读取，不接受 evaluator 或 Redis 消息覆盖。 */
export async function publishQueueChange(submissionId: string) {
  const db = getDb(),
    table = submissionId.startsWith(SELF_TEST_ID_PREFIX)
      ? selfTests
      : submissions;
  const [row] = await db.select({ domain_id: table.domain_id }).from(table)
    .where(eq(table.id, submissionId));
  if (row) {
    await publishSseEvent(
      queueEventChannel(row.domain_id ?? DEFAULT_DOMAIN_ID),
      { type: "queue:changed" },
    );
    await publishSseEvent(INSTANCE_QUEUE_CHANNEL, { type: "queue:changed" });
  }
}

/** 管理员移除尚未被 worker 领取的评测任务。 */
export async function removePendingSubmission(id: string): Promise<void> {
  const db = getDb();
  const [submission] = await db
    .select({ id: submissions.id, status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);
  if (!submission) {
    throw new NotFoundError("提交不存在");
  }

  const redis = getRedis();
  if (redis.status !== "ready") await redis.connect();
  let raw: string | undefined;
  let targetQueue: string | undefined;
  for (const queue of JUDGE_QUEUE_LIST) {
    const rawItems = await redis.lrange(queue, 0, -1);
    const found = rawItems.find((item) => {
      try {
        return JSON.parse(item).submission_id === id;
      } catch {
        return false;
      }
    });
    if (found) {
      raw = found;
      targetQueue = queue;
      break;
    }
  }
  if (!raw || !targetQueue) {
    throw new NotFoundError("待处理队列中不存在该提交");
  }
  const removed = await redis.lrem(targetQueue, 1, raw);
  if (removed !== 1) throw new NotFoundError("待处理队列中不存在该提交");

  if (submission.status === "judging") {
    await db.update(submissions).set({
      status: "error",
      judge_finished_at: new Date().toISOString(),
    })
      .where(and(eq(submissions.id, id), eq(submissions.status, "judging")));
  }

  await logAudit(
    "submissions.queue_removed",
    { action: "submissions.queue_removed", submission_id: id },
    { type: "submission", id },
  );
  await publishQueueChange(id);
}

/**
 * 获取单个提交的队列状态。
 *
 * 权限控制（审计 VULN-13 修正）：**仅提交所有者本人或 admin** 可见。
 * 此前判据是 `viewerUserId !== undefined && viewerRole !== "admin"`，于是**匿名**
 * 访问（`viewerUserId === undefined`）反而跳过了归属校验、能拿到排队位置，
 * 而已登录的非所有者却被返回 null —— 权限逻辑完全倒挂。
 * 现在未登录访客与非所有者一样返回 null。
 *
 * @param submissionId 提交 ID
 * @param viewerUserId 当前查看者用户 ID（可选）
 * @param viewerRole 当前查看者角色（可选，"admin" 拥有所有权限）
 * @returns 队列状态；提交不存在或查看者无权访问时返回 null
 */
export async function getSubmissionQueueStatus(
  submissionId: string,
  viewerUserId?: string,
  viewerRole?: string,
  domainId?: string,
): Promise<SubmissionStatusResponse | null> {
  const db = getDb();

  // 1. 查询提交基本信息（含 user_id 用于权限校验）
  const rows = await db
    .select({
      user_id: submissions.user_id,
      contest_id: submissions.contest_id,
      status: submissions.status,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
    })
    .from(submissions)
    .where(and(
      eq(submissions.id, submissionId),
      domainId
        ? eq(submissions.domain_id, domainId)
        : sql`(${submissions.domain_id} = ${DEFAULT_DOMAIN_ID} OR ${submissions.domain_id} IS NULL)`,
    ))
    .limit(1);

  if (rows.length === 0) return null;

  // 2. 权限校验：仅 admin 或提交所有者可查看（匿名访客同样被拒绝）
  if (viewerRole !== "admin") {
    if (!viewerUserId || rows[0].user_id !== viewerUserId) return null;
  }

  const row = rows[0];
  const status = row.status;
  let queuePosition: number | null = null;
  let queueLength: number | null = null;

  // 3. 如果状态是 judging 或 pending，查询排队位置
  //    注意：DB 中 status 在入队后立即标记为 judging，
  //    因此需要结合 Redis 队列判断实际排队情况
  //    Redis 不可用时静默失败，queue_position/queue_length 保持 null
  if (status === "judging" || status === "pending") {
    try {
      const info = await getPendingQueuePosition(submissionId);
      queueLength = info.queueLength;
      // 不在主队列中（正在评测或已出队）时 queue_position 保持 null
      queuePosition = info.position;
    } catch {
      // Redis 不可用时静默跳过，queue_position/queue_length 保持 null
    }
  }

  return {
    id: submissionId,
    status,
    contest_id: row.contest_id,
    queue_position: queuePosition,
    queue_length: queueLength,
    judge_started_at: row.judge_started_at ?? null,
    judge_finished_at: row.judge_finished_at ?? null,
  };
}
