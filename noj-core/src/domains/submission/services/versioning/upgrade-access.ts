/** 升级创建的是新提交，不能借原提交绕过当前读题权限、竞赛窗口或限额。 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems, submissionJobs } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { evaluateProblemAccess } from "../../../catalog/index.ts";
import {
  assertContestSubmissionLimit,
  verifyContestAccess,
} from "../../../contest/index.ts";
import { getUserPermissions } from "../../../identity/index.ts";
import { resolveSubmissionVersion } from "./submission-version.ts";
import type { ClaimedJobItem } from "./job-worker.ts";
import type { DispatchSource, JobUpgradeContext } from "./dispatch-job-item.ts";

/** 同一条目重试只占用一次竞赛提交预算。管理员操作仍保留源用户身份。 */
export async function assertUpgradeAccess(
  item: ClaimedJobItem,
  source: DispatchSource,
  context: JobUpgradeContext,
): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, item.job_id),
  );
  const perms = job
    ? await getUserPermissions(job.actor_id)
    : new Set<string>();
  const isAdmin = perms.has("admin:full_access") ||
    perms.has("submission:rejudge");
  if (!job || (job.actor_id !== source.user_id && !isAdmin)) {
    throw new AppError("无权升级该提交", 403, "UPGRADE_FORBIDDEN");
  }
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, source.problem_id),
  );
  if (!problem) throw new AppError("题目不存在", 404, "SOURCE_DELETED");
  const contestId = context === "source_contest" ? source.contest_id : null;
  if (context === "source_contest" && !contestId) {
    throw new AppError("源提交没有竞赛上下文", 409, "CONTEST_CONTEXT_REQUIRED");
  }
  const contestAccess = contestId
    ? await verifyContestAccess(source.user_id, contestId, source.problem_id)
    : null;
  const access = await evaluateProblemAccess(problem, {
    viewerId: source.user_id,
    isAdmin,
    contestAccess,
  });
  if (
    !access.result.allowed ||
    (contestId && (!contestAccess?.allowed || !contestAccess.running))
  ) {
    throw new AppError(
      "升级时已无提交权限或竞赛已结束",
      403,
      "UPGRADE_ACCESS_DENIED",
    );
  }
  if (contestId) {
    await resolveSubmissionVersion(source.problem_id, {
      contestId,
      requestedVersionId: item.target_version_id,
    });
    if (!item.attempt_id) {
      await assertContestSubmissionLimit(
        contestId,
        source.user_id,
        source.problem_id,
        item.id,
      );
    }
  }
}
