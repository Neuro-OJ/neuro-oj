/**
 * Submissions 结果写回（PR-3 拆分）。
 *
 * 包含：
 * - saveEvaluationResult：由 mq/consumer 调用，写入 judge 返回的结果
 * - updateSubmissionStatus：状态机校验 + 时间戳更新
 *
 * 重测相关在 submissions-rejudge.ts；CRUD 在 submissions-crud.ts。
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { evaluationResults, submissions } from "../../db/schema.ts";
import { BadRequestError, NotFoundError } from "../../lib/errors.ts";
import { getDb } from "../../db/connection.ts";
import { getStorageProvider } from "../../lib/storage/mod.ts";
import type { JudgeResult, SubmissionStatus } from "../../types/index.ts";
import { applyNewResult } from "../stats-cache.ts";
import { refreshRankingsView } from "../rankings.ts";
import { logger } from "../../lib/logging.ts";
import { Channels, publishEvent } from "../../lib/event-bus.ts";
import { createActivity } from "../community/community.ts";

// 允许的状态转换
const VALID_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending: ["judging", "error"],
  judging: ["finished", "error"],
  finished: [],
  error: [],
};

/**
 * 保存评测结果（幂等 + rejudge_seq 事务内校验）。
 *
 * 返回 true 表示本次结果已应用；false 表示过时/重复消息已忽略。
 * 事务内对 submissions 行加锁，避免 NOJ-065 的 TOCTOU 与 NOJ-068/182
 * 的重复统计。
 */
export async function saveEvaluationResult(
  result: JudgeResult,
): Promise<boolean> {
  const db = getDb();

  const incomingSeq = result.rejudge_seq ?? 0;
  const now = new Date().toISOString();

  const outcome = await db.transaction(async (tx) => {
    const [sub] = await tx
      .select({
        rejudge_seq: submissions.rejudge_seq,
        created_at: submissions.created_at,
        contest_id: submissions.contest_id,
        user_id: submissions.user_id,
        problem_id: submissions.problem_id,
        status: submissions.status,
        artifact_storage_url: submissions.artifact_storage_url,
      })
      .from(submissions)
      .where(eq(submissions.id, result.submission_id))
      .for("update")
      .limit(1);

    if (!sub) {
      logger.warn("提交不存在，忽略评测结果", {
        submission_id: result.submission_id,
      });
      return null;
    }

    // 过时结果：本次消息早于当前重测序号，直接丢弃。
    if (incomingSeq < sub.rejudge_seq) {
      logger.warn("忽略过时的评测结果", {
        submission_id: result.submission_id,
        result_seq: incomingSeq,
        current_seq: sub.rejudge_seq,
      });
      return null;
    }

    // 重复结果幂等：同一 submission + rejudge_seq 已落库时跳过。
    const [existingResult] = await tx
      .select({ id: evaluationResults.id })
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, result.submission_id))
      .limit(1);
    if (existingResult && incomingSeq === sub.rejudge_seq) {
      logger.info("重复评测结果，跳过", {
        submission_id: result.submission_id,
        rejudge_seq: incomingSeq,
      });
      return null;
    }

    // 状态机收紧：正常结果只允许 pending/judging → 终态。
    // error 提交重测时会先重置为 pending，因此也允许从 error 修复。
    const currentStatus = sub.status as SubmissionStatus;
    if (
      currentStatus !== "pending" && currentStatus !== "judging" &&
      currentStatus !== "error"
    ) {
      logger.warn("提交状态不允许写入评测结果", {
        submission_id: result.submission_id,
        status: currentStatus,
      });
      return null;
    }

    const submissionStatus: SubmissionStatus = [
        "error",
        "SystemError",
        "TimeLimitExceeded",
        "MemoryLimitExceeded",
        "RuntimeError",
      ].includes(result.status)
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
      });

    return {
      applied: true,
      created_at: sub.created_at,
      contest_id: sub.contest_id,
      user_id: sub.user_id,
      problem_id: sub.problem_id,
      is_rejudge: sub.rejudge_seq > 0,
      artifact_storage_url: sub.artifact_storage_url,
    };
  });

  if (!outcome) return false;

  // artifact 评测完成（finished/error）后立即删除存储对象
  if (outcome.artifact_storage_url) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(outcome.artifact_storage_url);
      logger.info("artifact 评测完成，已删除存储对象", {
        submission_id: result.submission_id,
      });
    } catch (err) {
      logger.error("artifact 评测后删除失败", {
        submission_id: result.submission_id,
        storage_url: outcome.artifact_storage_url,
        err,
      });
    }
  }

  // 统计缓存仅对首次结果递增；重测结果不计入（NOJ-068）。
  if (!outcome.is_rejudge && outcome.created_at) {
    applyNewResult(result.score, outcome.created_at);
  }

  // PR-4 评审修订：异步触发榜单物化视图刷新
  // 不 await：避免阻塞主业务（saveEvaluationResult 是热路径）
  // 失败仅 console.error（rankings.ts 内已处理）
  refreshRankingsView().catch(() => {/* ignore - rankings.ts 内已记录 */});

  if (result.score > 0) {
    const previousScored = await db.select({ id: submissions.id }).from(
      submissions,
    ).innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    ).where(and(
      eq(submissions.user_id, outcome.user_id),
      eq(submissions.problem_id, outcome.problem_id),
      eq(evaluationResults.status, "finished"),
      sql`${evaluationResults.score} > 0`,
      ne(submissions.id, result.submission_id),
    )).limit(1);
    if (!previousScored[0]) {
      await createActivity(
        outcome.user_id,
        "first_accepted",
        "problem",
        outcome.problem_id,
        { submission_id: result.submission_id },
      );
    }
  }

  if (outcome.contest_id) {
    publishEvent(
      Channels.contestRanking(outcome.contest_id),
      JSON.stringify({
        type: "contest:ranking:updated",
        contest_id: outcome.contest_id,
        submission_id: result.submission_id,
      }),
    );
  }

  return true;
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
