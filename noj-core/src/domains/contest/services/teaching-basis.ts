import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  contestProblems,
  domains,
  evaluationAttempts,
  problems,
} from "../../../shared/db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { domainProblemReference } from "../../catalog/index.ts";
import { loadDomainContest } from "./domain-access.ts";
import { computeContestStatus } from "./contests.ts";
import {
  getContestRankingView,
  getKaggleRanking,
  getLatestContestRankingSnapshot,
} from "./contest-ranking.ts";
import type {
  ContestConfig,
  ContestType,
  KaggleRankingRow,
} from "../types/contests.ts";

/** 教学只消费获授权的完整成绩依据；正式榜依据冻结尝试，后续重测不改选人依据。 */
export async function loadContestTeachingBasis(
  slug: string,
  id: string,
  actorId: string,
  rankingSource: "live" | "official",
  executor: Executor = getDb(),
) {
  const access = await loadDomainContest(slug, id, actorId, { executor });
  const status = computeContestStatus(
    access.contest.start_time,
    access.contest.end_time,
  );
  if (status === "pending") {
    throw new ConflictError("比赛尚未开始，不能按成绩布置补题");
  }
  let rankings: KaggleRankingRow[], snapshotVersion: number | null = null;
  if (rankingSource === "official") {
    if (status !== "ended") {
      throw new ConflictError("比赛尚未结束，不能使用正式成绩");
    }
    if (!access.organizer && access.contest.ranking_visibility === "hidden") {
      throw new NotFoundError("竞赛排名不可见");
    }
    if (
      !access.organizer &&
      access.contest.ranking_visibility === "participants" && !access.registered
    ) throw new ForbiddenError("仅参赛者可查看正式成绩");
    const snapshot = await getLatestContestRankingSnapshot(
      access.contest.id,
      executor,
    );
    if (!snapshot) throw new NotFoundError("尚未发布正式成绩");
    rankings = snapshot.rows as KaggleRankingRow[];
    snapshotVersion = snapshot.version;
  } else if (rankingSource === "live") {
    const view = await getContestRankingView(
      access.contest.id,
      access.contest.type as ContestType,
      access.organizer,
      actorId,
      executor,
    );
    if (view.view !== "live") {
      throw new ConflictError(
        "封榜或已发布正式榜不能作为完整实时成绩，请选择正式成绩",
      );
    }
    if (
      !access.organizer && access.contest.type === "kaggle" &&
      (access.contest.config as ContestConfig).scoreboard_scope !== "full"
    ) throw new ForbiddenError("本人榜不能用于读取本班其他学生成绩");
    // 先验证对完整榜的访问，再加载同一授权范围内的正式尝试定位；不向教学返回评测详情。
    rankings = await getKaggleRanking(
      access.contest.id,
      undefined,
      true,
      executor,
    );
  } else {
    throw new ConflictError("成绩来源无效");
  }
  const sourceItems = await executor.select({
    item: contestProblems,
    problem: {
      id: problems.id,
      domain_id: domains.id,
      number: problems.number,
    },
    source_slug: domains.slug,
  }).from(contestProblems).innerJoin(
    problems,
    eq(problems.id, contestProblems.problem_id),
  )
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(eq(contestProblems.contest_id, access.contest.id)).orderBy(
      asc(contestProblems.sort_order),
      contestProblems.problem_id,
    );
  const attempts = new Map<
    string,
    { score: number | null; accepted: boolean | null }
  >();
  const ids = [
    ...new Set(
      rankings.flatMap((r) =>
        r.problem_scores.map((p) => p.effective_attempt_id).filter((
          id,
        ): id is string => !!id)
      ),
    ),
  ];
  for (let start = 0; start < ids.length; start += 5000) {
    for (
      const attempt of await executor.select({
        id: evaluationAttempts.id,
        score: evaluationAttempts.score,
        accepted: evaluationAttempts.accepted,
      }).from(evaluationAttempts).where(
        inArray(evaluationAttempts.id, ids.slice(start, start + 5000)),
      )
    ) {
      attempts.set(attempt.id, attempt);
    }
  }
  return {
    source: {
      kind: "contest" as const,
      id: access.contest.id,
      title: access.contest.title,
      revision: access.contest.revision,
      ranking_source: rankingSource,
      snapshot_version: snapshotVersion,
    },
    items: sourceItems.map(({ item, problem, source_slug }) => ({
      id: item.problem_id,
      label: item.label,
      binding_id: item.domain_problem_binding_id,
      reference: domainProblemReference(problem, source_slug, access.domain.id),
    })),
    students: rankings.map((r) => ({
      user_id: r.user_id,
      cells: sourceItems.map(({ item }) => {
        const result = r.problem_scores.find((p) => p.label === item.label);
        const attempt = result?.effective_attempt_id
          ? attempts.get(result.effective_attempt_id)
          : undefined;
        const unstarted = result !== undefined && result.attempts === 0;
        const acmUnsolved = access.contest.type === "acm" &&
          result?.accepted === false && result.pending !== true;
        return {
          item_id: item.problem_id,
          pending: !result || result.pending === true ||
            (!attempt && !unstarted && !acmUnsolved),
          score: attempt?.score ?? (unstarted || acmUnsolved ? 0 : null),
          accepted: attempt?.accepted === true,
        };
      }),
    })),
  };
}
