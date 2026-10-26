/**
 * 竞赛访问校验：成员 + 题目归属 + 窗口（running/ended 放行，penging 拒绝）。
 *
 * 该函数返回 catalog 域定义的轻量 `ContestAccessInfo`，由提交/读题路径
 * 在调用 `resolveProblemAccess` 时作为竞赛上下文传入。
 */
import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domains,
} from "../../../shared/db/schema.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import type { ContestAccessInfo } from "../contracts/read.ts";
import { computeContestStatus } from "./contests.ts";
import { isParticipant } from "./contests.ts";
import type { ContestType } from "../types/contests.ts";

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
  options: { domainId?: string; executor?: Executor } = {},
): Promise<ContestAccessInfo> {
  let startTime: string;
  let endTime: string;
  let type: ContestType;
  let organizer: boolean;
  let resolvedContestId = contestId;
  try {
    const db = options.executor ?? getDb();
    const [contest] = await db.select().from(contests).where(or(
      eq(contests.id, contestId),
      eq(contests.public_id, contestId),
    )).limit(1);
    if (!contest) return { contestId, allowed: false, running: false };
    resolvedContestId = contest.id;
    if (
      (contest.domain_id ?? DEFAULT_DOMAIN_ID) !==
        (options.domainId ?? DEFAULT_DOMAIN_ID)
    ) {
      return { contestId: resolvedContestId, allowed: false, running: false };
    }
    startTime = contest.start_time;
    endTime = contest.end_time;
    type = contest.type as ContestType;
    {
      const [domain] = await db.select({ slug: domains.slug }).from(domains)
        .where(eq(domains.id, contest.domain_id ?? DEFAULT_DOMAIN_ID));
      if (!domain) {
        return { contestId: resolvedContestId, allowed: false, running: false };
      }
      const workspace = await loadWorkspace(domain.slug, userId, {
        executor: db,
      });
      organizer = workspace.platformAdmin ||
        workspace.context.domainPermissions.has("contest:manage") ||
        userId === contest.created_by &&
          workspace.context.domainPermissions.has("contest:manage_own");
      if (!workspace.membership && !workspace.platformAdmin) {
        return { contestId: resolvedContestId, allowed: false, running: false };
      }
    }
  } catch (error) {
    if (
      error instanceof NotFoundError || error instanceof ForbiddenError ||
      error instanceof UnauthorizedError
    ) return { contestId: resolvedContestId, allowed: false, running: false };
    throw error;
  }

  const db = options.executor ?? getDb();
  const [problem] = await db
    .select({
      problem_id: contestProblems.problem_id,
      pinned_version_id: contestProblems.pinned_version_id,
    })
    .from(contestProblems)
    .where(and(
      eq(contestProblems.contest_id, resolvedContestId),
      eq(contestProblems.problem_id, problemId),
    ))
    .limit(1);
  if (!problem) {
    return { contestId: resolvedContestId, allowed: false, running: false };
  }

  const status = computeContestStatus(startTime, endTime);
  const participant = userId !== null &&
    await isParticipant(resolvedContestId, userId, db);
  const allowed = participant && (status === "running" || status === "ended");
  return {
    contestId: resolvedContestId,
    allowed,
    running: status === "running",
    type,
    organizer,
    // 竞赛固定作答版本：竞赛题面/小题目按它展示（否则展示最新版、判卷固定版）。
    pinnedVersionId: problem.pinned_version_id ?? null,
  };
}
