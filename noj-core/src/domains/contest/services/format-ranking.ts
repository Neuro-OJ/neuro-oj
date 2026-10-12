import { eq, sql } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import {
  contestParticipants,
  contestProblems,
  problems,
  problemVersions,
  users,
} from "../../../shared/db/schema.ts";
import { getContest } from "./contests.ts";
import {
  type ContestScoreSubmission,
  scoreContest,
} from "./contest-scoring.ts";
import type { KaggleRankingRow } from "../types/contests.ts";
import type { ProblemContentV1 } from "../../catalog/index.ts";

/** 多赛制按受理候选计算榜单；正式判定优先，重测平台失败保留已有成绩。 */
export async function getFormatRanking(
  contestId: string,
  cutoffTime?: string,
  includeDetails = false,
  executor: Executor = getDb(),
): Promise<KaggleRankingRow[]> {
  const contest = await getContest(contestId, undefined, executor);
  const participants = await executor.select({
    id: users.id,
    username: users.username,
    avatar_url: users.avatar_url,
  }).from(contestParticipants).innerJoin(
    users,
    eq(users.id, contestParticipants.user_id),
  )
    .where(eq(contestParticipants.contest_id, contestId));
  const items = await executor.select({
    item: contestProblems,
    content: problemVersions.content,
    problem_id: problems.id,
  }).from(contestProblems).innerJoin(
    problems,
    eq(problems.id, contestProblems.problem_id),
  )
    .innerJoin(
      problemVersions,
      eq(problemVersions.id, contestProblems.pinned_version_id),
    )
    .where(eq(contestProblems.contest_id, contestId)).orderBy(
      contestProblems.sort_order,
    );
  const rows = unwrapRows<
    ContestScoreSubmission & {
      submitted_version_id: string | null;
      evaluated_version_id: string | null;
      evaluation_status: string | null;
      rejudge_seq: number | null;
    }
  >(
    await executor.execute(sql`
    SELECT s.id, s.user_id, s.problem_id, s.created_at AS received_at,
      s.receipt_sequence::text AS receipt_sequence,
      CASE WHEN formal.id IS NOT NULL THEN 'graded'
        WHEN latest.result_kind = 'platform_error' OR latest.state = 'error' THEN 'platform_error'
        ELSE 'pending' END AS state,
      formal.score, coalesce(formal.accepted, false) AS accepted,
      coalesce(formal.details->'oi'->>'verdict', formal.result_status) AS verdict,
      formal.id AS attempt_id, s.submitted_version_id,
      formal.problem_version_id AS evaluated_version_id, formal.result_status AS evaluation_status,
      formal.sequence AS rejudge_seq
    FROM submissions s
    LEFT JOIN evaluation_attempts formal ON formal.id = s.contest_effective_attempt_id
    LEFT JOIN evaluation_attempts latest ON latest.id = coalesce(s.active_attempt_id, s.latest_attempt_id)
    WHERE s.contest_id = ${contestId}
      AND s.created_at >= ${contest.start_time} AND s.created_at <= ${contest.end_time}
    UNION ALL
    SELECT s.id, s.user_id, s.paper_id, s.created_at, s.receipt_sequence::text,
      CASE WHEN formal.id IS NOT NULL THEN 'graded'
        WHEN latest.result_kind = 'platform_error' OR latest.state = 'error' THEN 'platform_error'
        ELSE 'pending' END,
      formal.score, coalesce(formal.accepted, false), formal.result_status,
      formal.id, s.submitted_version_id, formal.problem_version_id,
      formal.result_status, formal.sequence
    FROM objective_submissions s
    LEFT JOIN evaluation_attempts formal ON formal.id = s.contest_effective_attempt_id
    LEFT JOIN evaluation_attempts latest ON latest.id = coalesce(s.active_attempt_id, s.latest_attempt_id)
    WHERE s.contest_id = ${contestId}
      AND s.created_at >= ${contest.start_time} AND s.created_at <= ${contest.end_time}
  `) as never,
  );
  const bySubmission = new Map(rows.map((r) => [r.id, r]));
  const byUser = new Map(participants.map((p) => [p.id, p]));
  const byProblem = new Map(items.map((p) => [p.problem_id, p.item]));
  const frozenSubmissions = cutoffTime
    ? rows.filter((r) => r.received_at >= cutoffTime)
    : [];
  const frozenProblems = new Set(
    frozenSubmissions.map((r) => JSON.stringify([r.user_id, r.problem_id])),
  );
  const frozenUsers = new Set(frozenSubmissions.map((r) => r.user_id));
  const scores = scoreContest({
    type: contest.type,
    problems: items.map((p) => ({
      id: p.problem_id,
      kind: (p.content as ProblemContentV1).kind,
      max_score: p.item.score,
    })),
    participants: participants.map((p) => p.id),
    submissions: cutoffTime
      ? rows.filter((r) => r.received_at < cutoffTime)
      : rows,
    start_time: contest.start_time,
    end_time: contest.end_time,
    penalty_minutes: contest.config.penalty_minutes,
  });
  return scores.map((row) => ({
    rank: row.rank,
    user_id: row.user_id,
    username: byUser.get(row.user_id)!.username,
    avatar_url: byUser.get(row.user_id)!.avatar_url,
    total_score: row.total_score,
    solved: row.solved,
    penalty_ms: row.penalty_ms,
    pending: row.pending || frozenUsers.has(row.user_id),
    last_submission_at: row.last_improvement_at,
    problem_scores: row.problems.map((cell) => {
      const problem = byProblem.get(cell.problem_id)!;
      const source = cell.submission_id
        ? bySubmission.get(cell.submission_id)
        : null;
      return {
        label: problem.label,
        best_score: cell.score,
        attempts: cell.attempts,
        last_best_at: source?.received_at ?? null,
        pending: cell.pending ||
          frozenProblems.has(JSON.stringify([row.user_id, cell.problem_id])),
        accepted: cell.accepted,
        penalty_ms: cell.penalty_ms,
        ...(includeDetails
          ? {
            submission_id: cell.submission_id,
            effective_attempt_id: cell.attempt_id,
            submitted_version_id: source?.submitted_version_id ?? null,
            evaluated_version_id: source?.evaluated_version_id ?? null,
            evaluation_status: source?.evaluation_status ?? null,
            rejudge_seq: source?.rejudge_seq ?? null,
            pinned_version_id: problem.pinned_version_id,
            policy_revision: problem.effective_policy_revision,
            version_policy: problem.effective_version_mode === "exact"
              ? {
                mode: "exact" as const,
                version_id: problem.required_version_id,
              }
              : { mode: "any" as const },
          }
          : {}),
      };
    }),
  }));
}
