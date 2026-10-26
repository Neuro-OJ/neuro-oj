import { and, eq } from "drizzle-orm";
import { ForbiddenError } from "../../../shared/base/errors.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
} from "../../../shared/db/schema.ts";
import { runningWindowCondition } from "./contest-window.ts";

/** 同域在赛选手不能通过普通练习、自测或作业重新评测赛题。 */
export async function assertDomainPracticeAllowed(
  domainId: string,
  problemId: string,
  userId: string,
  executor: Executor,
) {
  const [running] = await executor.select({ id: contests.id }).from(contests)
    .innerJoin(contestProblems, eq(contestProblems.contest_id, contests.id))
    .innerJoin(
      contestParticipants,
      eq(contestParticipants.contest_id, contests.id),
    )
    .where(and(
      eq(contests.domain_id, domainId),
      eq(contestProblems.problem_id, problemId),
      eq(contestParticipants.user_id, userId),
      runningWindowCondition(contests.start_time, contests.end_time),
    )).limit(1);
  if (running) {
    throw new ForbiddenError(
      "比赛期间请从比赛入口提交此题",
      "CONTEST_PRACTICE_BLOCKED",
    );
  }
}
