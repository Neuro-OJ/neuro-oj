/**
 * 竞赛访问校验：成员 + 题目归属 + 窗口（running/ended 放行，penging 拒绝）。
 *
 * 该函数返回 catalog 域定义的轻量 `ContestAccessInfo`，由提交/读题路径
 * 在调用 `resolveProblemAccess` 时作为竞赛上下文传入。
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contestProblems } from "./../../../shared/db/schema.ts";
import type { ContestAccessInfo } from "./../../catalog/index.ts";
import { computeContestStatus } from "./contests.ts";
import { findContestRow } from "./contest-row.ts";
import { isParticipant } from "./contests.ts";

/**
 * 校验指定用户对竞赛内题目的访问权限。
 *
 * 规则：
 * - 题目必须属于该竞赛；
 * - 用户必须是参赛者；
 * - 竞赛状态为 running 或 ended（赛前拒绝；赛后允许复盘）。
 *
 * 竞赛不存在时按拒绝返回（fail-closed）。
 */
export async function verifyContestAccess(
  userId: string | null,
  contestId: string,
  problemId: string,
): Promise<ContestAccessInfo> {
  let startTime: string;
  let endTime: string;
  try {
    const contest = await findContestRow(contestId);
    startTime = contest.start_time;
    endTime = contest.end_time;
  } catch {
    return { contestId, allowed: false, running: false };
  }

  const db = getDb();
  const [problem] = await db
    .select({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .where(and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ))
    .limit(1);
  if (!problem) {
    return { contestId, allowed: false, running: false };
  }

  const status = computeContestStatus(startTime, endTime);
  const participant = userId !== null && await isParticipant(contestId, userId);
  const allowed = participant && (status === "running" || status === "ended");
  return {
    contestId,
    allowed,
    running: status === "running",
  };
}
