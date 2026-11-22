import { ForbiddenError } from "../../../shared/base/errors.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { loadPublicContestSecrecy } from "../../access/contest-policy.ts";

/** 普通练习、自测和作业遵守本域赛题保护，报名和管理身份均不豁免。 */
export async function assertDomainPracticeAllowed(
  domainId: string,
  problemId: string,
  _userId: string,
  executor: Executor = getDb(),
) {
  const protection = await loadPublicContestSecrecy(
    problemId,
    executor,
    domainId,
  );
  if (protection.length) {
    throw new ForbiddenError(
      "此题受比赛保护，请从比赛入口提交",
      "CONTEST_PROBLEM_RESTRICTED",
      { contests: protection },
    );
  }
}
