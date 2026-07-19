/**
 * Submissions 结果写回（PR-3 拆分）。
 *
 * 包含：
 * - saveEvaluationResult：由 mq/consumer 调用，写入 judge 返回的结果
 * - updateSubmissionStatus：状态机校验 + 时间戳更新
 *
 * 重测相关在 submissions-rejudge.ts；CRUD 在 submissions-crud.ts。
 */

import { eq } from "drizzle-orm";
import { evaluationResults, submissions } from "../db/schema.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import { getDb } from "../db/connection.ts";
import type { JudgeResult, SubmissionStatus } from "../types/index.ts";
import { applyNewResult } from "./stats-cache.ts";
import { refreshRankingsView } from "./rankings.ts";
import { logger } from "../lib/logging.ts";

// 允许的状态转换
const VALID_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending: ["judging", "error"],
  judging: ["finished", "error"],
  finished: [],
  error: [],
};

/**
 * 保存评测结果。
 *
 * 由结果消费者调用，将 noj-judge 返回的 JudgeResult 持久化到数据库。
 * 原子操作：更新 submission 状态 → INSERT evaluation_results。
 */
export async function saveEvaluationResult(
  result: JudgeResult,
): Promise<void> {
  const db = getDb();

  const incomingSeq = result.rejudge_seq ?? 0;
  const [sub] = await db
    .select({
      rejudge_seq: submissions.rejudge_seq,
      created_at: submissions.created_at,
    })
    .from(submissions)
    .where(eq(submissions.id, result.submission_id))
    .limit(1);

  if (!sub) {
    logger.warn("提交不存在，忽略评测结果", {
      submission_id: result.submission_id,
    });
    return;
  }

  if (incomingSeq < sub.rejudge_seq) {
    logger.warn("忽略过时的评测结果", {
      submission_id: result.submission_id,
      result_seq: incomingSeq,
      current_seq: sub.rejudge_seq,
    });
    return;
  }

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const submissionStatus: SubmissionStatus = result.status === "SystemError"
      ? "error"
      : "finished";

    await tx
      .update(submissions)
      .set({
        status: submissionStatus,
        judge_finished_at: now,
      })
      .where(eq(submissions.id, result.submission_id));

    await tx
      .insert(evaluationResults)
      .values({
        id: crypto.randomUUID(),
        submission_id: result.submission_id,
        status: result.status,
        score: result.score,
        output: result.output,
        details: JSON.stringify(result.details),
        time_ms: result.time_ms ?? null,
        memory_kb: result.memory_kb ?? null,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: evaluationResults.submission_id,
        set: {
          status: result.status,
          score: result.score,
          output: result.output,
          details: JSON.stringify(result.details),
          time_ms: result.time_ms ?? null,
          memory_kb: result.memory_kb ?? null,
          created_at: now,
        },
      });
  });

  // 更新内存统计缓存（仅 net-new 结果，重测不计入避免 double-count）
  if (sub.created_at) {
    applyNewResult(result.score, sub.created_at);
  }

  // PR-4 评审修订：异步触发榜单物化视图刷新
  // 不 await：避免阻塞主业务（saveEvaluationResult 是热路径）
  // 失败仅 console.error（rankings.ts 内已处理）
  refreshRankingsView().catch(() => {/* ignore - rankings.ts 内已记录 */});
}

/**
 * 更新提交状态。
 * 校验状态转换是否合法（pending → judging → finished）。
 * 同步更新 judge_started_at / judge_finished_at 时间戳。
 *
 * @throws {NotFoundError} 提交不存在
 * @throws {BadRequestError} 状态转换非法
 */
export async function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const current = existing[0].status as SubmissionStatus;
  if (!VALID_TRANSITIONS[current]?.includes(status)) {
    throw new BadRequestError(`无效的状态转换: ${current} → ${status}`);
  }

  const now = new Date().toISOString();
  const updates: Record<string, string | undefined> = { status };

  // 设置 judge_started_at：pending → judging
  if (status === "judging") {
    updates.judge_started_at = now;
  }

  // 设置 judge_finished_at：judging → finished / error
  if (status === "finished" || status === "error") {
    updates.judge_finished_at = now;
  }

  await db
    .update(submissions)
    .set(updates)
    .where(eq(submissions.id, id));
}
