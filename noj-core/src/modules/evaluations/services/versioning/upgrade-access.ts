/** 升级以当前域授权执行，新提交仍归原用户并复用比赛受理预算。 */
import { AppError } from "../../../../shared/base/errors.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../domains/workspace/index.ts";
import {
  assertContestSubmissionLimit,
  verifyContestAccess,
} from "../../../contests/index.ts";
import { resolveSubmissionVersion } from "./submission-version.ts";
import type { ClaimedJobItem } from "./job-worker.ts";
import type { DispatchSource, JobUpgradeContext } from "./dispatch-job-item.ts";
import { assertDomainJobExecution } from "./domain-job-access.ts";

/** 账号及域频率预算在创建副本的事务内消费，比赛预算以条目 ID 幂等。 */
export async function assertUpgradeAccess(
  item: ClaimedJobItem,
  source: DispatchSource,
  context: JobUpgradeContext,
): Promise<void> {
  await assertDomainJobExecution(item, source, "upgrade");
  if (context !== "source_contest") return;
  if (!source.contest_id) {
    throw new AppError("源提交没有竞赛上下文", 409, "CONTEST_CONTEXT_REQUIRED");
  }
  const contest = await verifyContestAccess(
    source.user_id,
    source.contest_id,
    source.problem_id,
    { domainId: source.domain_id ?? DEFAULT_DOMAIN_ID },
  );
  if (!contest.allowed || !contest.running) {
    throw new AppError("升级时已无比赛提交权限", 403, "UPGRADE_ACCESS_DENIED");
  }
  await resolveSubmissionVersion(source.problem_id, {
    contestId: source.contest_id,
    requestedVersionId: item.target_version_id,
  });
  if (!item.attempt_id) {
    await assertContestSubmissionLimit(
      source.contest_id,
      source.user_id,
      source.problem_id,
      item.id,
    );
  }
}
