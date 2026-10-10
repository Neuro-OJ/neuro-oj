/** 批任务的持久化执行分配：领取者、提交副本与尝试的关联必须在入队前原子提交。 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  submissionJobItems,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import { assertStorageObjectBindable } from "../../../system/index.ts";
import { resolveSubmissionVersion } from "./submission-version.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";
import { createAttempt } from "./attempts.ts";
import { lockProjectionHosts } from "./projection.ts";
import type { ClaimedJobItem } from "./job-worker.ts";
import type { DispatchSource, JobUpgradeContext } from "./dispatch-job-item.ts";
import type { Executor } from "../../../../shared/db/executor.ts";

/** 读取任务的操作者（管理员代原用户升级时用于记录 actor）。 */
async function jobActorId(
  executor: Executor,
  jobId: string,
): Promise<string | null> {
  const [job] = await executor.select({ actor_id: submissionJobs.actor_id })
    .from(submissionJobs).where(eq(submissionJobs.id, jobId)).limit(1);
  return job?.actor_id ?? null;
}

/** 重试复用原尝试和升级副本；租约已经换主的执行者不能创建任何副作用。 */
export async function ensureJobAttempt(input: {
  item: ClaimedJobItem;
  owner: string;
  source: DispatchSource;
  content: Exclude<ProblemContentV1, { kind: "objective" }>;
  kind: "rejudge" | "upgrade";
  context?: JobUpgradeContext;
}): Promise<typeof evaluationAttempts.$inferSelect> {
  const { item, owner, source, content, kind } = input;
  return await getDb().transaction(async (tx) => {
    const contestId = kind === "upgrade" && input.context !== "source_contest"
      ? null
      : source.contest_id;
    await lockProjectionHosts(tx, {
      kind: "submission",
      id: source.id,
      problem_id: source.problem_id,
      contest_id: contestId,
    });
    // 在锁内复查源，两个任务争抢同一提交时只允许一个创建在途尝试。
    const [original] = await tx.select().from(submissions).where(
      eq(submissions.id, source.id),
    ).for("update");
    if (!original) throw new AppError("源提交已删除", 409, "SOURCE_DELETED");
    const [claimed] = await tx.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, item.id),
    ).for("update");
    if (
      !claimed || claimed.status !== "preparing" ||
      claimed.lease_owner !== owner || !claimed.lease_until ||
      claimed.lease_until <= new Date().toISOString()
    ) {
      throw new AppError("任务条目租约已失效", 409, "JOB_LEASE_LOST");
    }
    if (claimed.attempt_id) {
      const [attempt] = await tx.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, claimed.attempt_id),
      );
      if (!attempt || attempt.problem_version_id !== item.target_version_id) {
        throw new AppError("尝试关联已失效", 409, "JOB_ATTEMPT_MISSING");
      }
      return attempt;
    }
    if (original.active_attempt_id) {
      throw new AppError("源提交正在评测", 409, "SOURCE_JUDGING");
    }
    let destinationId = source.id;
    if (kind === "upgrade") {
      if (contestId) {
        await resolveSubmissionVersion(source.problem_id, {
          contestId,
          requestedVersionId: item.target_version_id,
        }, tx);
      }
      if (source.artifact_storage_url) {
        await assertStorageObjectBindable(source.artifact_storage_url, tx);
      }
      destinationId = crypto.randomUUID();
      await tx.insert(submissions).values({
        id: destinationId,
        public_id: generatePublicId("sub"),
        user_id: source.user_id,
        problem_id: source.problem_id,
        contest_id: contestId,
        language: source.language,
        code: source.code,
        file_name: source.file_name,
        artifact_storage_url: source.artifact_storage_url,
        status: "pending",
        submitted_version_id: item.target_version_id,
        version_origin: "known",
        upgraded_from_id: source.id,
        created_at: new Date().toISOString(),
      });
    }
    const attempt = await createAttempt({
      source: {
        kind: "submission",
        id: destinationId,
        problem_id: source.problem_id,
        contest_id: contestId,
      },
      problemVersionId: item.target_version_id,
      source_kind: kind,
      taskSnapshot: {
        language: source.language,
        problem_version_id: item.target_version_id,
        runtime_config: content.runtime_config,
        batch_job_id: item.job_id,
      },
      // §4.4：管理员可代原用户升级；新提交归**原用户**，操作者 actor 记录在尝试上。
      createdBy: await jobActorId(tx, item.job_id),
      executor: tx,
    });
    await tx.update(submissionJobItems).set({
      attempt_id: attempt.id,
      ...(kind === "upgrade" ? { result_submission_id: destinationId } : {}),
    }).where(eq(submissionJobItems.id, item.id));
    const [stored] = await tx.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, attempt.id),
    );
    return stored;
  });
}
