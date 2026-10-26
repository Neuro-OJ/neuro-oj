/**
 * 评测派发任务处理器（P4）。
 *
 * 受理事务在提交、attempt 与**可恢复派发任务**三者的同一事务里登记任务；
 * 提交后由本处理器把任务推送进 Redis 队列：
 * - Redis 暂时不可用时任务保留 pending，按退避重试，已受理的提交不会变成孤儿；
 * - 派发重试使用同一 attempt/run identity（从数据库事实重建任务，不重放旧消息）；
 * - 无法验证必要准入条件（活动尝试缺失、版本缺失）时任务终态失败并标记平台错误，
 *   不会无限重试；
 * - 不把 `submission_jobs` 等业务进度表替换成通用任务表：任务只负责"把已存在的
 *   事实推给 Judge"，业务进度仍在自己的表里。
 */
import { getLogger } from "@logtape/logtape";
import type { ClaimedTask } from "../runtime/tasks/contracts.ts";
import { getDb } from "../../shared/db/connection.ts";
import { AppError } from "../../shared/base/errors.ts";
import { and, eq } from "drizzle-orm";
import { submissions } from "../../shared/db/schema.ts";
import {
  loadSubmissionRecoveryRow,
  rebuildPendingTask,
} from "../evaluations/mq/pending-recovery.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../evaluations/mq/producer.ts";
import { publishQueueChange } from "../evaluations/services/queue.ts";
import { applyAttemptResultTx } from "../evaluations/services/versioning/result-write.ts";
import { runAttemptTerminalRevocationAfterCommit } from "../evaluations/services/versioning/attempts.ts";

const logger = getLogger(["noj", "application", "dispatch-tasks"]);

/**
 * 处理一条 `evaluation.dispatch` 任务。
 *
 * 成功：Redis 已接收任务，且提交状态已从 pending 推进到 judging。
 * 失败：抛错由 worker 记失败并退避；永久错误（消息超限、缺少活动尝试）
 * 直接标记平台错误后返回，不进入重试。
 */
export async function handleEvaluationDispatchTask(
  task: ClaimedTask,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const submissionId = task.targetId;
  const attemptId = task.payload.attempt_id;
  if (typeof attemptId !== "string" || !attemptId) {
    throw new TypeError("评测派发任务缺少 attempt_id");
  }
  const db = getDb();
  const [row] = await db.select({
    id: submissions.id,
    status: submissions.status,
    activeAttemptId: submissions.active_attempt_id,
  }).from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!row) {
    // 提交已被删除：任务幂等结束，不重试。
    return { skipped: "submission_deleted" };
  }
  if (row.status !== "pending") {
    // 已被其他路径派发或已出结果：任务幂等结束。
    return { skipped: `status_${row.status}` };
  }
  if (row.activeAttemptId !== attemptId) {
    return { skipped: "attempt_changed" };
  }

  const permanentFailure = async () => {
    signal?.throwIfAborted();
    // 统一终态入口同时处理 attempt、提交投影、任务条目与吊销 outbox。
    const outcome = await db.transaction((tx) =>
      applyAttemptResultTx(tx, { kind: "system", purpose: "background_task" }, {
        attemptId,
        resultKind: "platform_error",
        resultStatus: "DISPATCH_FAILED",
        score: null,
        accepted: false,
        output: "评测派发失败，请联系管理员检查评测配置",
      })
    );
    if (outcome.applied !== "ignored") {
      await runAttemptTerminalRevocationAfterCommit(attemptId);
      await publishQueueChange(submissionId);
    }
    return { permanent_error: "dispatch_failed" };
  };

  let judgeTask;
  try {
    const recoveryRow = await loadSubmissionRecoveryRow(submissionId);
    if (!recoveryRow) return { skipped: "submission_deleted" };
    if (recoveryRow.active_attempt_id !== attemptId) {
      return { skipped: "attempt_changed" };
    }
    judgeTask = await rebuildPendingTask(recoveryRow, "submission");
  } catch (error) {
    // 缺少活动尝试/版本属于永久错误：标记平台错误，避免无限重试。
    logger.error("评测派发任务无法重建 JudgeTask", {
      submission_id: submissionId,
      err: error,
    });
    if (error instanceof AppError && error.statusCode < 500) {
      return await permanentFailure();
    }
    throw error;
  }

  signal?.throwIfAborted();
  try {
    await pushJudgeTask(judgeTask);
  } catch (error) {
    if (!isRetryableJudgeQueueError(error)) {
      logger.error("评测派发永久失败，标记平台错误", {
        submission_id: submissionId,
        err: error,
      });
      return await permanentFailure();
    }
    throw error;
  }

  // 条件更新：极端竞态下结果可能已先落库，不能把 finished 覆盖回 judging。
  await db.update(submissions).set({ status: "judging" }).where(
    and(
      eq(submissions.id, submissionId),
      eq(submissions.status, "pending"),
      eq(submissions.active_attempt_id, attemptId),
    ),
  );
  await publishQueueChange(submissionId);
  return { dispatched: true };
}
