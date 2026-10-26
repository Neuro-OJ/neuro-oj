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
import type { DbTx, Executor } from "../../../../../shared/db/executor.ts";
import {
  lockProjectionHosts,
  lockProjectionSource,
} from "../../versioning/projection.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import {
  objectiveSubmissions,
  submissionJobItems,
} from "../../../../../shared/db/schema.ts";
import { FULL_SCORE } from "../../../../../shared/base/constants.ts";
import { AppError, NotFoundError } from "../../../../../shared/base/errors.ts";
import type { SystemActor } from "../../../../access/contracts/actor.ts";
import {
  applyAttemptResultTx,
  createEvaluationAttemptTx,
  type EvaluationWriteActor,
} from "../../versioning/tx-contracts.ts";
import type { ObjectiveAnswerValue } from "../../../../problems/types/objective.ts";
import { getProblemVersionSnapshot } from "../../../../problems/contracts/read.ts";
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
  jobItemId?: string;
  leaseOwner?: string;
}

/** 客观题重判结果。 */
export interface ObjectiveRegradeJobResult {
  attempt_id: string;
  score: number;
  accepted: boolean;
}

/**
 * 客观题重判的原子事务入口。
 *
 * worker/application 必须先持有外层 DbTx，并显式提供 UserActor 或
 * SystemActor(background_task)；本函数不会根据 optional executor 自行开事务。
 */
export async function rejudgeObjectiveSubmissionForJobTx(
  tx: DbTx,
  actor: EvaluationWriteActor,
  input: ObjectiveRegradeJobInput,
): Promise<ObjectiveRegradeJobResult> {
  const db = tx;
  const [row] = await db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, input.submissionId),
  ).limit(1);
  if (!row) throw new NotFoundError("客观题提交不存在");

  await lockProjectionHosts(db, {
    kind: "objective",
    id: row.id,
    problem_id: row.paper_id,
    contest_id: row.contest_id,
  });
  await lockProjectionSource(db, {
    kind: "objective",
    id: row.id,
    problem_id: row.paper_id,
  });
  if (input.jobItemId) {
    const [item] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, input.jobItemId),
    ).for("update");
    if (
      !item || item.status !== "preparing" ||
      item.lease_owner !== input.leaseOwner || !item.lease_until ||
      item.lease_until <= new Date().toISOString()
    ) throw new AppError("任务租约已失效", 409, "JOB_LEASE_LOST");
  }
  const version = await getProblemVersionSnapshot(
    row.paper_id,
    input.targetVersionId,
    db,
  );
  if (!version || version.content.kind !== "objective") {
    throw new NotFoundError("客观题目标版本不存在");
  }
  const questions = version.content.questions;
  const regrade = regradeAgainstSnapshot(
    (row.answers ?? {}) as Record<string, ObjectiveAnswerValue[]>,
    questions,
  );

  const accepted = regrade.score >= FULL_SCORE;
  const details = stripExpectedForStorage(regrade.details);
  const attempt = await createEvaluationAttemptTx(tx, actor, {
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

  if (input.jobItemId) {
    await db.update(submissionJobItems).set({ attempt_id: attempt.id }).where(
      eq(submissionJobItems.id, input.jobItemId),
    );
  }
  const outcome = await applyAttemptResultTx(tx, actor, {
    attemptId: attempt.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: regrade.score,
    accepted,
    details,
  });
  if (outcome.applied !== "graded") {
    throw new Error(`客观题重判结果未生效：${outcome.applied}`);
  }
  // 提交行的 `score`/`details` 是最近一次 graded 执行的投影；有效成绩指针
  // 保留多版本差异，不能在这里把原始 answers 重写成目标版本题面。
  await tx.update(objectiveSubmissions).set({
    score: regrade.score,
    details: details as never,
    status: "finished",
  }).where(eq(objectiveSubmissions.id, row.id));

  return { attempt_id: attempt.id, score: regrade.score, accepted };
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
  executor?: Executor,
): Promise<ObjectiveRegradeJobResult> {
  const actor: SystemActor = { kind: "system", purpose: "background_task" };
  if (!executor) {
    return await getDb().transaction((tx) =>
      rejudgeObjectiveSubmissionForJobTx(tx, actor, input)
    );
  }
  // 旧 domain caller 的兼容路径只保留在迁移期；所有新 caller 应直接调用
  // rejudgeObjectiveSubmissionForJobTx 并把外层 DbTx/actor 传入。
  if ("transaction" in executor) {
    return await executor.transaction((tx) =>
      rejudgeObjectiveSubmissionForJobTx(tx, actor, input)
    );
  }
  return rejudgeObjectiveSubmissionForJobTx(executor, actor, input);
}
