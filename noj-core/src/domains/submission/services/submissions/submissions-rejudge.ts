/**
 * Submissions 重测（PR-3 拆分）。
 *
 * 包含：
 * - rejudgeSubmission：单条重测（管理员单条入口）
 * - rejudgeProblemSubmissions：批量重测（管理员按题目入口）
 *
 * CRUD 在 submissions-crud.ts；结果写回在 submissions-result.ts。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  evaluationResults,
  submissions,
} from "./../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getDb } from "./../../../../shared/db/connection.ts";
import { pushJudgeTask } from "../../../../mq/producer.ts";
import { getProblem } from "../../../catalog/index.ts";
import { getStorageProvider } from "./../../../system/index.ts";
import { logAudit } from "../../../system/index.ts";
import { buildJudgeTaskLlm } from "./../../../gateway/index.ts";
import { buildJudgeTaskLlmForProvider } from "./../../../gateway/index.ts";
import { getUserLlmProvider } from "../../../gateway/index.ts";
import type { JudgeTask, JudgeTaskLlm } from "../../types/index.ts";
import type { RuntimeConfig } from "./../../../catalog/index.ts";
import { LANGUAGE_EXT_MAP } from "../../types/index.ts";
import {
  Channels,
  publishSseEvent,
} from "./../../../../shared/sse/event-bus.ts";
import { updateSubmissionStatus } from "./submissions-result.ts";
import { logger } from "./../../../../shared/base/logging.ts";

const MAX_BATCH_REJUDGE = 500;

type BatchTxResult = {
  ids: string[];
  count: number;
  rows?: {
    id: string;
    language: string;
    code: string;
    file_name: string | null;
  }[];
} | { error: string };

/**
 * 单条提交重测。
 *
 * 流程：
 * 1. 删除 evaluation_results（事务）
 * 2. 重置 submission 状态为 pending（事务）+ rejudge_seq++
 * 3. 写审计
 * 4. 推送 MQ
 *
 * @throws {NotFoundError} 提交不存在
 * @throws {AppError} 推送 MQ 失败
 */
export async function rejudgeSubmission(id: string): Promise<void> {
  const db = getDb();

  const [submission] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (!submission) {
    throw new NotFoundError("提交不存在");
  }

  if (submission.artifact_storage_url) {
    throw new BadRequestError("artifact 提交不支持重测");
  }

  if (submission.status !== "finished" && submission.status !== "error") {
    throw new BadRequestError("仅已完成或出错的提交可以重测");
  }

  const problem = await getProblem(submission.problem_id);

  // 获取支持包 download URL
  let download_url: string | undefined;
  try {
    if (problem.support_package_storage_url) {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    }
  } catch (err) {
    logger.error("重测获取支持包 download URL 失败", {
      storage_url: problem.support_package_storage_url,
      err,
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(evaluationResults)
      .where(eq(evaluationResults.submission_id, id));

    await tx.update(submissions)
      .set({
        status: "pending",
        judge_started_at: null,
        judge_finished_at: null,
        rejudge_seq: sql`${submissions.rejudge_seq} + 1`,
      })
      .where(eq(submissions.id, id));
  });

  const [updated] = await db
    .select({ rejudge_seq: submissions.rejudge_seq })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  const runtimeConfig = problem.runtime_config as
    | RuntimeConfig
    | null
    | undefined;

  let llmTask: JudgeTaskLlm | undefined;
  if (problem.llm_config && runtimeConfig) {
    llmTask = await buildJudgeTaskLlm(
      problem.llm_config,
      id,
      submission.problem_id,
      submission.user_id,
      runtimeConfig,
    );
  }
  let userLlmTask: JudgeTaskLlm | undefined;
  if (submission.llm_provider_config_id && runtimeConfig) {
    const provider = await getUserLlmProvider(
      submission.user_id,
      submission.llm_provider_config_id,
    );
    if (provider.enabled) {
      userLlmTask = await buildJudgeTaskLlmForProvider(
        provider.id,
        provider.model,
        id,
        submission.problem_id,
        submission.user_id,
        runtimeConfig,
      );
    }
  }

  const task: JudgeTask = {
    submission_id: id,
    problem_id: submission.problem_id,
    runtime_config: runtimeConfig as NonNullable<typeof runtimeConfig>,
    download_url,
    language: submission.language,
    code: submission.code,
    file_name: submission.file_name ??
      (LANGUAGE_EXT_MAP[submission.language] || "main.txt"),
    rejudge_seq: updated?.rejudge_seq ?? 0,
    ...(llmTask ? { llm: llmTask } : {}),
    ...(userLlmTask ? { user_llm: userLlmTask } : {}),
  };

  // 审计日志：先写入审计再推送不可逆的 MQ 消息（issue #101）
  await logAudit(
    "submissions.rejudge",
    {
      action: "submissions.rejudge",
      submission_id: id,
    },
    { type: "submission", id },
  );

  try {
    await pushJudgeTask(task);
    // 入队成功后才置为 judging，并且只在仍为 pending 时更新，
    // 避免结果先落库后把 finished 覆盖回 judging（与批量重测路径一致）。
    await db.update(submissions).set({ status: "judging" }).where(
      and(eq(submissions.id, id), eq(submissions.status, "pending")),
    );
  } catch (mqErr) {
    logger.error("重测任务推送失败", { submission_id: id, err: mqErr });
    try {
      await updateSubmissionStatus(id, "error");
    } catch {
      // ignore cleanup failure
    }
    throw new AppError(
      "重测失败：评测队列暂时不可用，请稍后重试",
      500,
      "REJUDGE_QUEUE_ERROR",
    );
  }

  await publishSseEvent(Channels.queue, { type: "queue:changed" });
}

/**
 * 批量重测某题目所有 finished/error 状态的提交。
 *
 * 事务内：检查无活跃任务 → 删除所有 evaluation_results → 重置状态 + rejudge_seq++
 * 事务后：写审计 + 逐条推 MQ（任一失败不阻断整体）
 *
 * @returns total / queued / skipped（部分入队失败时 skipped > 0）
 * @throws {BadRequestError} 题目仍有 pending/judging 提交 / 超过 MAX_BATCH_REJUDGE
 */
export async function rejudgeProblemSubmissions(
  problemId: string,
): Promise<{ total: number; queued: number; skipped: number }> {
  const db = getDb();

  const problem = await getProblem(problemId);

  // 获取支持包 download URL（该题所有提交共享同一份）
  let download_url: string | undefined;
  try {
    if (problem.support_package_storage_url) {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    }
  } catch (err) {
    logger.error("批量重测获取支持包 download URL 失败", {
      storage_url: problem.support_package_storage_url,
      err,
    });
  }

  const txResult = await db.transaction<BatchTxResult>(async (tx) => {
    const activeCounts = await tx
      .select({ status: submissions.status, count: sql<number>`count(*)` })
      .from(submissions)
      .where(
        and(
          eq(submissions.problem_id, problemId),
          inArray(submissions.status, ["pending", "judging"]),
        ),
      )
      .groupBy(submissions.status);

    if (activeCounts.length > 0) {
      const details = activeCounts
        .map((r) => `${r.status}: ${r.count}条`)
        .join("、");
      return {
        error:
          `该题目尚有活跃评测中的提交（${details}），无法批量重测，请等待完成后再试`,
      };
    }

    const rows = await tx
      .select({
        id: submissions.id,
        language: submissions.language,
        code: submissions.code,
        file_name: submissions.file_name,
        user_id: submissions.user_id,
        llm_provider_config_id: submissions.llm_provider_config_id,
        artifact_storage_url: submissions.artifact_storage_url,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.problem_id, problemId),
          inArray(submissions.status, ["finished", "error"]),
        ),
      );

    if (rows.length === 0) {
      return { ids: [], count: 0 };
    }

    if (rows.some((r) => r.artifact_storage_url)) {
      return {
        error: "该题目包含 artifact 提交，artifact 提交不支持重测",
      };
    }

    if (rows.length > MAX_BATCH_REJUDGE) {
      return {
        error:
          `批量重测超过上限（${rows.length} > ${MAX_BATCH_REJUDGE}），请分批操作`,
      };
    }

    const ids = rows.map((r) => r.id);

    await tx.delete(evaluationResults)
      .where(inArray(evaluationResults.submission_id, ids));

    await tx.update(submissions)
      .set({
        status: "pending",
        judge_started_at: null,
        judge_finished_at: null,
        rejudge_seq: sql`${submissions.rejudge_seq} + 1`,
      })
      .where(inArray(submissions.id, ids));

    return { ids, count: ids.length, rows };
  });

  if ("error" in txResult) {
    throw new BadRequestError(txResult.error);
  }

  const { ids: allIds, count: total } = txResult;

  if (total === 0) {
    return { total: 0, queued: 0, skipped: 0 };
  }

  // NOJ-075：不再用首条提交的 rejudge_seq 覆盖全部提交。
  // 事务内已对每条提交递增各自的 rejudge_seq，逐行读取并透传。
  const rejudgeRows = await db
    .select()
    .from(submissions)
    .where(inArray(submissions.id, allIds));

  // 审计日志：先写入审计再推送不可逆的 MQ 消息
  if (total > 0) {
    await logAudit(
      "submissions.rejudge",
      {
        action: "submissions.rejudge",
        problem_id: problemId,
        count: total,
      },
      { type: "problem", id: problemId },
    );
  }

  // 逐条入队（每条代码内容不同，无法合并）
  let queued = 0;
  for (const sub of rejudgeRows) {
    try {
      let llmTask: JudgeTaskLlm | undefined;
      const runtimeConfig = problem.runtime_config as RuntimeConfig | null;
      if (problem.llm_config && runtimeConfig) {
        llmTask = await buildJudgeTaskLlm(
          problem.llm_config,
          sub.id,
          problemId,
          sub.user_id,
          runtimeConfig,
        );
      }
      let userLlmTask: JudgeTaskLlm | undefined;
      if (sub.llm_provider_config_id && runtimeConfig) {
        const provider = await getUserLlmProvider(
          sub.user_id,
          sub.llm_provider_config_id,
        );
        if (provider.enabled) {
          userLlmTask = await buildJudgeTaskLlmForProvider(
            provider.id,
            provider.model,
            sub.id,
            problemId,
            sub.user_id,
            runtimeConfig,
          );
        }
      }

      const task: JudgeTask = {
        submission_id: sub.id,
        problem_id: problemId,
        runtime_config: runtimeConfig as NonNullable<typeof runtimeConfig>,
        download_url,
        language: sub.language,
        code: sub.code,
        file_name: sub.file_name ??
          (LANGUAGE_EXT_MAP[sub.language] || "main.txt"),
        rejudge_seq: sub.rejudge_seq,
        ...(llmTask ? { llm: llmTask } : {}),
        ...(userLlmTask ? { user_llm: userLlmTask } : {}),
      };

      await pushJudgeTask(task);
      // 条件更新：结果可能在入队后立即回写，不得覆盖终态。
      await db.update(submissions).set({ status: "judging" }).where(
        and(eq(submissions.id, sub.id), eq(submissions.status, "pending")),
      );
      queued++;
    } catch (err) {
      logger.error("批量重测入队失败", { submission_id: sub.id, err });
      // 入队失败：将状态回退到 error，避免卡在 pending 导致无法重试
      try {
        const errNow = new Date().toISOString();
        await db.update(submissions)
          .set({
            status: "error",
            judge_started_at: null,
            judge_finished_at: errNow,
          })
          .where(eq(submissions.id, sub.id));
      } catch { /* ignore cleanup failure */ }
    }
  }

  await publishSseEvent(Channels.queue, { type: "queue:changed" });

  return {
    total,
    queued,
    skipped: total - queued,
  };
}
