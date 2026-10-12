/**
 * 单条 / 整题重测入口适配层（Handbook §4.3）。
 *
 * 这两个函数是**兼容入口**：既有管理端按钮仍在用它们，但它们不再自行派发任务，
 * 而是调用统一任务受理服务 `acceptRejudgeJob`：
 *
 * - 目标固定为 `submitted`（不可变的提交时版本，不用"最近评测版本"）；
 * - 单条：`scope = selected`，默认 `submitted` 目标；
 * - 整题：`scope = problem`，**没有 500 条总量限制**（后台分批执行）；
 * - 受理后由批任务 worker 派发（版本内容为唯一配置来源），本层不再修改提交状态、
 *   不再预先递增 `rejudge_seq`、不再直接推送 MQ。
 *
 * 审计沿用 `submissions.rejudge`，保证管理操作的可追溯性不因入口统一而丢失。
 */

import { getLogger } from "@logtape/logtape";
import { getDb } from "./../../../../shared/db/connection.ts";
import { problems } from "./../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { logAudit } from "./../../../system/index.ts";
import {
  type AcceptJobResult,
  acceptRejudgeJob,
  getRejudgeJob,
} from "./../versioning/rejudge-jobs.ts";

const logger = getLogger(["noj", "submission"]);

/** 兼容入口每次调用生成独立幂等键（等价于"这次点击是一次新任务"）。 */
function legacyIdempotencyKey(): string {
  return `legacy-rejudge-${crypto.randomUUID()}`;
}

/**
 * 单条重测（兼容入口）。
 *
 * @param id 提交 ID（普通提交）
 * @returns 受理结果（任务 ID、状态、条目数）
 */
export async function rejudgeSubmission(
  id: string,
  actorId = "0",
): Promise<AcceptJobResult> {
  const accepted = await acceptRejudgeJob(
    actorId,
    {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id }],
      },
      target: { mode: "submitted" },
    },
    legacyIdempotencyKey(),
  );

  await logAudit(
    "submissions.rejudge",
    { action: "submissions.rejudge", submission_id: id },
    { type: "submission", id },
  );
  logger.info("单条重测已受理", { submission_id: id, job_id: accepted.job_id });
  return accepted;
}

/**
 * 整题批量重测（兼容入口）。
 *
 * 受理时固定提交集合；之后产生的新提交不进入本批任务。空集合返回已完成、
 * 总数为 0 的任务（与统一契约一致）。
 *
 * @param problemId 题目 ID
 * @returns 受理结果（任务 ID、状态、条目数）
 */
export async function rejudgeProblemSubmissions(
  problemId: string,
  actorId = "0",
): Promise<AcceptJobResult> {
  const accepted = await acceptRejudgeJob(
    actorId,
    {
      kind: "rejudge",
      scope: { type: "problem", problem_id: problemId },
      target: { mode: "submitted" },
    },
    legacyIdempotencyKey(),
  );

  const db = getDb();
  const [problem] = await db.select({
    title: problems.title,
    type: problems.type,
    number: problems.number,
  }).from(problems).where(eq(problems.id, problemId)).limit(1);

  await logAudit(
    "submissions.rejudge",
    {
      action: "submissions.rejudge",
      problem_id: problemId,
      count: accepted.total_items,
    },
    { type: "problem", id: problemId },
  );
  logger.info("整题重测已受理", {
    problem_id: problemId,
    display_id: problem ? `${problem.type}${problem.number}` : undefined,
    job_id: accepted.job_id,
    total_items: accepted.total_items,
  });
  return accepted;
}

/** 读取任务详情（管理端轮询进度用；非本次受理返回 null）。 */
export { getRejudgeJob };
