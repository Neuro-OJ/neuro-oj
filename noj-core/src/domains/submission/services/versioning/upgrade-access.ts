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

/**
 * 同一条目重试只占用一次竞赛提交预算。管理员操作仍保留源用户身份。
 *
 * **预算口径分工（2026-10-11 复审问题 9）**：
 * - 本函数负责"操作者授权 + 原用户当前可提交资格（读题权限/赛期/竞赛提交限额）"；
 * - 普通提交额度（每用户 60s/120 次）由派发路径在**创建副本的同一事务内**调用
 *   `consumeSubmissionQuotaForUpgrade(source.user_id, item.id)` 单独占用，
 *   管理员代升级也扣**原用户**预算；额度不足返回延期信号（不抛异常），
 *   由调用方回滚事务并延期条目。两者互不替代。
 */
export async function assertUpgradeAccess(
  item: ClaimedJobItem,
  source: DispatchSource,
  context: JobUpgradeContext,
): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, item.job_id),
  );
  const actorPerms = job
    ? await getUserPermissions(job.actor_id)
    : new Set<string>();
  // 操作者授权：本人，或管理员/有重测权限者代原用户执行（§4.4）
  const actorCanOperate = actorPerms.has("admin:full_access") ||
    actorPerms.has("submission:rejudge");
  if (!job || (job.actor_id !== source.user_id && !actorCanOperate)) {
    throw new AppError("无权升级该提交", 403, "UPGRADE_FORBIDDEN");
  }
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, source.problem_id),
  );
  if (!problem) throw new AppError("题目不存在", 404, "SOURCE_DELETED");
  // **原用户的正常提交资格**与操作者授权分开评估：管理员代升级不能把自己的
  // 管理员可见性"借"给原用户，否则等于绕过正常可访问性检查（#42）。
  const sourcePerms = job.actor_id === source.user_id
    ? actorPerms
    : await getUserPermissions(source.user_id);
  const sourceIsAdmin = sourcePerms.has("admin:full_access");
  const contestId = context === "source_contest" ? source.contest_id : null;
  if (context === "source_contest" && !contestId) {
    throw new AppError("源提交没有竞赛上下文", 409, "CONTEST_CONTEXT_REQUIRED");
  }
  const contestAccess = contestId
    ? await verifyContestAccess(source.user_id, contestId, source.problem_id)
    : null;
  const access = await evaluateProblemAccess(problem, {
    viewerId: source.user_id,
    isAdmin: sourceIsAdmin,
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
