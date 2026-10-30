import { partitionClassroomRanking } from "./classroom-contests.ts";
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { contestProblems } from "../../../shared/db/schema.ts";
import { ForbiddenError, NotFoundError } from "../../../shared/base/errors.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { getContestProblems } from "./contest-problems.ts";
import { loadDomainContest } from "./domain-access.ts";
import { resolveDomainContestProblems } from "./domain-problems.ts";
import { computeContestStatus } from "./contests.ts";
import {
  getContestRankingView,
  getContestSettlementStatus,
  getLatestContestRankingSnapshot,
  listContestRankingSnapshots,
  publishContestRankingSnapshot,
} from "./contest-ranking.ts";
import type { ContestType, KaggleRankingRow } from "../types/contests.ts";
import { loadDomainProblemProtection } from "../../access/contest-policy.ts";

/** 赛题从固定版本读取，引用题每次读取实时验证源共享；来源题号保持不变。 */
export async function getDomainContestProblems(
  slug: string,
  reference: string,
  actorId: string,
) {
  const access = await loadDomainContest(slug, reference, actorId);
  const status = computeContestStatus(
    access.contest.start_time,
    access.contest.end_time,
  );
  // 赛题可见性：赛前仅组织者；赛中仅参赛者；**赛后对域内所有人开放**（复盘/补题），
  // 但提交入口仍由 `getDomainContestSubmissionTarget` 的受理窗口与报名门控限制。
  if (!access.organizer && status === "pending") {
    throw new ForbiddenError("开赛后才能读取赛题");
  }
  if (!access.organizer && status === "running" && !access.registered) {
    throw new ForbiddenError("仅参赛者可读取进行中的比赛赛题");
  }
  const db = getDb();
  const selected = await db.select({ problem_id: contestProblems.problem_id })
    .from(contestProblems).where(
      eq(contestProblems.contest_id, access.contest.id),
    );
  if (status === "ended" && !access.organizer) {
    const protection = await loadDomainProblemProtection(
      access.domain.id,
      selected.map((item) => item.problem_id),
      db,
    );
    const contests = [...new Map(
      [...protection.values()].flat()
        .map((ref) => [ref.contestId, ref]),
    ).values()];
    if (contests.length) {
      throw new ForbiddenError(
        "赛题仍受其他比赛保护",
        "CONTEST_PROBLEM_RESTRICTED",
        { contests },
      );
    }
  }
  const sources = await resolveDomainContestProblems(
    db,
    access.domain.id,
    selected.map((p) => p.problem_id),
    access.contest.type as ContestType,
    false,
  );
  const data = await getContestProblems(
    access.contest.id,
    actorId,
    access.organizer,
  );
  return data.map((row) => ({
    ...row,
    reference: sources.references.get(row.problem_id),
    display_id: sources.references.get(row.problem_id)!.display_ref,
    domain_problem_binding_id: sources.bindingIds.get(row.problem_id),
  }));
}

/** 各赛制实时/封榜/正式视图共用引擎，组织权限仅属于比赛所在域。 */
export async function getDomainContestRanking(
  slug: string,
  reference: string,
  actorId: string | null,
  classroomId?: string,
) {
  const access = await loadDomainContest(slug, reference, actorId);
  const result = await getContestRankingView(
    access.contest.id,
    access.contest.type as ContestType,
    access.organizer,
    actorId ?? undefined,
  );
  return {
    ...result,
    ...await partitionClassroomRanking(
      access.contest.id,
      result.rows,
      classroomId,
    ),
  };
}

/** 正式快照读取遵循比赛榜单可见性，后续重测不改写已发布版本。 */
export async function getDomainContestFinalRanking(
  slug: string,
  reference: string,
  actorId: string | null,
  classroomId?: string,
) {
  const access = await loadDomainContest(slug, reference, actorId);
  if (!access.organizer && access.contest.ranking_visibility === "hidden") {
    throw new NotFoundError("竞赛排名不可见");
  }
  if (
    !access.organizer && access.contest.ranking_visibility === "participants" &&
    !access.registered
  ) throw new ForbiddenError("仅参赛者可查看正式成绩");
  const snapshot = await getLatestContestRankingSnapshot(access.contest.id);
  if (!snapshot) throw new NotFoundError("尚未发布正式成绩");
  return {
    data: snapshot.rows as KaggleRankingRow[],
    ...await partitionClassroomRanking(
      access.contest.id,
      snapshot.rows as KaggleRankingRow[],
      classroomId,
    ),
    result_type: "official" as const,
    snapshot: {
      version: snapshot.version,
      note: snapshot.note,
      created_at: snapshot.created_at,
    },
  };
}

/** 结算详情只对当前域比赛组织者开放。 */
export async function getDomainContestSettlement(
  slug: string,
  reference: string,
  actorId: string,
) {
  const access = await loadDomainContest(slug, reference, actorId, {
    manage: true,
  });
  return await getContestSettlementStatus(access.contest.id);
}

/** 正式成绩版本元数据只在组织端展示。 */
export async function getDomainContestSnapshots(
  slug: string,
  reference: string,
  actorId: string,
) {
  const access = await loadDomainContest(slug, reference, actorId, {
    manage: true,
  });
  return await listContestRankingSnapshots(access.contest.id);
}

/** 发布在同一事务重新授权组织者并检查在途评测；失败发布及重新发布均须说明。 */
export async function publishDomainContestRanking(
  slug: string,
  reference: string,
  actorId: string,
  input: { note?: string; allow_failed?: boolean },
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadDomainContest(slug, reference, actorId, {
      executor: tx,
      manage: true,
      write: true,
    });
    const result = await publishContestRankingSnapshot(
      access.contest.id,
      actorId,
      input.note ?? "",
      { allowFailed: input.allow_failed, executor: tx },
    );
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "contest.publish_ranking",
      contest_id: access.contest.id,
      version: result.version,
      note: input.note ?? "",
      allow_failed: input.allow_failed ?? false,
    });
    return result;
  });
}
