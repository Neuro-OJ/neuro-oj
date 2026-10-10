/**
 * 客观题按目标版本快照重判（Handbook §6.4、§5.7）。
 *
 * 批量重测/升级任务里的客观题条目不经过 Judge/MQ：判卷是纯函数，直接在服务端
 * 按**目标版本的小题快照**重判，并走与首次提交完全相同的尝试 + 投影写入链路。
 *
 * 规则：
 * - 按稳定 `key` 匹配原始答案；新增小题按未作答、删除小题不计分；
 * - 答案形式与目标题型不兼容按未作答；
 * - 原始 `answers` 永不改写；
 * - 详情记录匹配状态（`match` / `reason_code`），但入库前仍然剥离标准答案。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { objectiveSubmissions } from "../../../../shared/db/schema.ts";
import { FULL_SCORE } from "../../../../shared/base/constants.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import {
  applyAttemptResult,
  createAttempt,
} from "./../../../submission/index.ts";
import type { ObjectiveAnswerValue } from "../../types/objective.ts";
import { listVersionQuestions } from "./objective-drafts.ts";
import {
  regradeAgainstSnapshot,
  type RegradeDetail,
} from "./objective-regrade.ts";

/** 客观题重判输入。 */
export interface ObjectiveRegradeJobInput {
  /** 客观题提交 ID（`objective_submissions.id`）。 */
  submissionId: string;
  /** 目标版本 ID（已在受理事务中固定）。 */
  targetVersionId: string;
  /** 批任务类别：重测或升级。 */
  jobKind: "rejudge" | "upgrade";
}

/** 客观题重判结果。 */
export interface ObjectiveRegradeJobResult {
  attempt_id: string;
  score: number;
  accepted: boolean;
}

/** 入库前剥离标准答案（与首次提交同一口径：任何读路径都不可能泄露答案）。 */
function stripExpectedForStorage(
  details: Record<string, RegradeDetail>,
): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const [key, detail] of Object.entries(details)) {
    stored[key] = {
      correct: detail.correct,
      given: detail.given,
      match: detail.match,
      ...(detail.reason_code ? { reason_code: detail.reason_code } : {}),
    };
  }
  return stored;
}

/**
 * 按目标版本快照重判一条客观题提交，并把结果写入统一的尝试与有效成绩投影。
 *
 * @throws {NotFoundError} 提交或版本不存在
 */
export async function rejudgeObjectiveSubmissionForJob(
  input: ObjectiveRegradeJobInput,
): Promise<ObjectiveRegradeJobResult> {
  const db = getDb();
  const [row] = await db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, input.submissionId),
  ).limit(1);
  if (!row) throw new NotFoundError("客观题提交不存在");

  const questions = await listVersionQuestions(input.targetVersionId);
  const regrade = regradeAgainstSnapshot(
    (row.answers ?? {}) as Record<string, ObjectiveAnswerValue[]>,
    questions,
  );

  const accepted = regrade.score >= FULL_SCORE;
  const details = stripExpectedForStorage(regrade.details);
  const attempt = await createAttempt({
    source: {
      kind: "objective",
      id: row.id,
      problem_id: row.paper_id,
      contest_id: row.contest_id,
    },
    problemVersionId: input.targetVersionId,
    source_kind: input.jobKind === "upgrade" ? "upgrade" : "rejudge",
    taskSnapshot: {
      kind: "objective",
      problem_version_id: input.targetVersionId,
      total_count: regrade.total_count,
      matched_count: regrade.matched_count,
      missing_count: regrade.missing_count,
      incompatible_count: regrade.incompatible_count,
    },
  });

  await db.transaction(async (tx) => {
    const outcome = await applyAttemptResult({
      attemptId: attempt.id,
      resultKind: "graded",
      resultStatus: "finished",
      score: regrade.score,
      accepted,
      details,
    }, tx);
    if (outcome.applied !== "graded") {
      throw new Error(`客观题重判结果未生效：${outcome.applied}`);
    }
    // 提交行的 `score`/`details` 是"最近一次 graded 执行"的投影（与
    // `latest_attempt_id` 同源）；多版本差异由有效成绩指针表达（§3.2）。
    await tx.update(objectiveSubmissions).set({
      score: regrade.score,
      details: details as never,
      status: "finished",
    }).where(eq(objectiveSubmissions.id, row.id));
  });

  return { attempt_id: attempt.id, score: regrade.score, accepted };
}
