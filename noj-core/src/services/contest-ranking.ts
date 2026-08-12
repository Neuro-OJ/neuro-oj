import { sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "../lib/errors.ts";
import { unwrapRows } from "../lib/sql-rows.ts";
import type {
  ContestType,
  IcpcProblemDetail,
  IcpcRankingRow,
  IoiProblemScore,
  IoiRankingRow,
} from "../types/contests.ts";
import { getContest, isParticipant } from "./contests.ts";

interface IcpcRankingOptions {
  submissionCutoff?: string | null;
  penaltyMinutes?: number;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function getIcpcRanking(
  contestId: string,
  options: IcpcRankingOptions = {},
): Promise<IcpcRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== "icpc") {
    throw new BadRequestError("该竞赛不是 ICPC 赛制");
  }
  const config = contest.config as Record<string, unknown>;
  const penaltyMinutes = options.penaltyMinutes ??
    Number(config.penalty_minutes ?? 20);
  const cutoff = options.submissionCutoff ?? null;
  const db = getDb();
  const result = await db.execute(sql`
    WITH contest_data AS (
      SELECT id, start_time, end_time
      FROM contests
      WHERE id = ${contestId}
    ),
    evaluated_submissions AS (
      SELECT s.id, s.user_id, s.problem_id, s.created_at, er.status
      FROM submissions s
      JOIN evaluation_results er ON er.submission_id = s.id
      JOIN contest_data c ON c.id = s.contest_id
      WHERE s.contest_id = ${contestId}
        AND s.created_at <= c.end_time
        AND (${cutoff}::text IS NULL OR s.created_at <= ${cutoff})
      UNION ALL
      -- 客观题提交：满分卷映射 Accepted，非满分映射 WrongAnswer
      SELECT os.id, os.user_id, os.paper_id, os.created_at,
        CASE WHEN os.score >= 10000 THEN 'Accepted' ELSE 'WrongAnswer' END AS status
      FROM objective_submissions os
      JOIN contest_data c ON c.id = os.contest_id
      WHERE os.contest_id = ${contestId}
        AND os.created_at <= c.end_time
        AND (${cutoff}::text IS NULL OR os.created_at <= ${cutoff})
    ),
    first_accepts AS (
      SELECT user_id, problem_id, MIN(created_at) AS first_ac_at
      FROM evaluated_submissions
      WHERE status = 'Accepted'
      GROUP BY user_id, problem_id
    ),
    problem_stats AS (
      SELECT
        participant.user_id,
        participant.registered_at,
        cp.problem_id,
        cp.label,
        cp.sort_order,
        fa.first_ac_at,
        COUNT(es.id) FILTER (
          WHERE es.status <> 'Accepted'
            AND (fa.first_ac_at IS NULL OR es.created_at < fa.first_ac_at)
        )::int AS failed_attempts,
        CASE WHEN fa.first_ac_at IS NULL THEN NULL ELSE
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
              fa.first_ac_at::timestamptz - c.start_time::timestamptz
            )) / 60)::int
          )
        END AS solve_time_minutes
      FROM contest_participants participant
      JOIN contest_data c ON TRUE
      CROSS JOIN contest_problems cp
      LEFT JOIN first_accepts fa
        ON fa.user_id = participant.user_id
        AND fa.problem_id = cp.problem_id
      LEFT JOIN evaluated_submissions es
        ON es.user_id = participant.user_id
        AND es.problem_id = cp.problem_id
      WHERE participant.contest_id = ${contestId}
        AND cp.contest_id = ${contestId}
      GROUP BY
        participant.user_id,
        participant.registered_at,
        cp.problem_id,
        cp.label,
        cp.sort_order,
        fa.first_ac_at,
        c.start_time
    ),
    user_totals AS (
      SELECT
        ps.user_id,
        ps.registered_at,
        COUNT(*) FILTER (WHERE ps.first_ac_at IS NOT NULL)::int AS solved,
        COALESCE(SUM(
          CASE WHEN ps.first_ac_at IS NULL THEN 0
          ELSE ps.solve_time_minutes + ${penaltyMinutes} * ps.failed_attempts END
        ), 0)::int AS penalty,
        MAX(ps.first_ac_at) AS last_ac_time,
        jsonb_agg(
          jsonb_build_object(
            'label', ps.label,
            'solved', ps.first_ac_at IS NOT NULL,
            'attempts', ps.failed_attempts,
            'solve_time_minutes', ps.solve_time_minutes
          ) ORDER BY ps.sort_order, ps.label
        ) AS problem_details
      FROM problem_stats ps
      GROUP BY ps.user_id, ps.registered_at
    )
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          ut.solved DESC,
          ut.penalty ASC,
          ut.last_ac_time ASC NULLS LAST,
          ut.registered_at ASC,
          ut.user_id ASC
      )::int AS rank,
      ut.user_id,
      u.username,
      u.avatar_url,
      ut.solved,
      ut.penalty,
      ut.last_ac_time,
      ut.problem_details
    FROM user_totals ut
    JOIN users u ON u.id = ut.user_id
    ORDER BY rank
  `);

  return unwrapRows<Record<string, unknown>>(result as never).map((row) => ({
    rank: Number(row.rank),
    user_id: row.user_id as string,
    username: row.username as string,
    avatar_url: (row.avatar_url as string | null) ?? null,
    solved: Number(row.solved),
    penalty: Number(row.penalty),
    last_ac_time: row.last_ac_time === null ? null : String(row.last_ac_time),
    problem_details: parseJsonArray<IcpcProblemDetail>(row.problem_details),
  }));
}

export async function getIoiRanking(
  contestId: string,
): Promise<IoiRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== "ioi" && contest.type !== "oi") {
    throw new BadRequestError("该竞赛不是 IOI/OI 赛制");
  }
  const db = getDb();
  const result = await db.execute(sql`
    WITH contest_data AS (
      SELECT id, start_time, end_time
      FROM contests
      WHERE id = ${contestId}
    ),
    evaluated_submissions AS (
      SELECT
        s.id,
        s.user_id,
        s.problem_id,
        s.created_at,
        er.score,
        ROW_NUMBER() OVER (
          PARTITION BY s.user_id, s.problem_id
          ORDER BY er.score DESC, s.created_at ASC, s.id ASC
        ) AS score_order,
        COUNT(*) OVER (
          PARTITION BY s.user_id, s.problem_id
        )::int AS attempts
      FROM submissions s
      JOIN evaluation_results er ON er.submission_id = s.id
      JOIN contest_data c ON c.id = s.contest_id
      WHERE s.contest_id = ${contestId}
        AND s.created_at <= c.end_time
      UNION ALL
      -- 客观题提交：score 同为 ×100 整数，直接参与总分
      SELECT
        os.id,
        os.user_id,
        os.paper_id,
        os.created_at,
        os.score,
        ROW_NUMBER() OVER (
          PARTITION BY os.user_id, os.paper_id
          ORDER BY os.score DESC, os.created_at ASC, os.id ASC
        ) AS score_order,
        COUNT(*) OVER (
          PARTITION BY os.user_id, os.paper_id
        )::int AS attempts
      FROM objective_submissions os
      JOIN contest_data c ON c.id = os.contest_id
      WHERE os.contest_id = ${contestId}
        AND os.created_at <= c.end_time
    ),
    best_scores AS (
      SELECT user_id, problem_id, created_at, score, attempts
      FROM evaluated_submissions
      WHERE score_order = 1
    ),
    problem_scores AS (
      SELECT
        participant.user_id,
        participant.registered_at,
        cp.problem_id,
        cp.label,
        cp.sort_order,
        COALESCE(bs.score, 0)::int AS best_score,
        COALESCE(bs.attempts, 0)::int AS attempts,
        CASE WHEN bs.created_at IS NULL THEN 0 ELSE
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
              bs.created_at::timestamptz - c.start_time::timestamptz
            )))::int
          )
        END AS score_time_seconds
      FROM contest_participants participant
      JOIN contest_data c ON TRUE
      CROSS JOIN contest_problems cp
      LEFT JOIN best_scores bs
        ON bs.user_id = participant.user_id
        AND bs.problem_id = cp.problem_id
      WHERE participant.contest_id = ${contestId}
        AND cp.contest_id = ${contestId}
    ),
    user_totals AS (
      SELECT
        ps.user_id,
        ps.registered_at,
        SUM(ps.best_score)::int AS total_score,
        SUM(ps.score_time_seconds)::int AS total_time_seconds,
        jsonb_agg(
          jsonb_build_object(
            'label', ps.label,
            'best_score', ps.best_score,
            'attempts', ps.attempts
          ) ORDER BY ps.sort_order, ps.label
        ) AS problem_scores
      FROM problem_scores ps
      GROUP BY ps.user_id, ps.registered_at
    )
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          ut.total_score DESC,
          ut.total_time_seconds ASC,
          ut.registered_at ASC,
          ut.user_id ASC
      )::int AS rank,
      ut.user_id,
      u.username,
      u.avatar_url,
      ut.total_score,
      ut.total_time_seconds,
      ut.problem_scores
    FROM user_totals ut
    JOIN users u ON u.id = ut.user_id
    ORDER BY rank
  `);

  return unwrapRows<Record<string, unknown>>(result as never).map((row) => ({
    rank: Number(row.rank),
    user_id: row.user_id as string,
    username: row.username as string,
    avatar_url: (row.avatar_url as string | null) ?? null,
    total_score: Number(row.total_score),
    total_time_seconds: Number(row.total_time_seconds),
    problem_scores: parseJsonArray<IoiProblemScore>(row.problem_scores),
  }));
}

export async function getContestRanking(
  contestId: string,
  type: ContestType,
  isAdmin = false,
  viewerId?: string,
): Promise<IcpcRankingRow[] | IoiRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== type) {
    throw new BadRequestError("排名类型与竞赛赛制不一致");
  }

  if (type === "oi" && contest.status === "running" && !isAdmin) {
    if (!viewerId) {
      throw new UnauthorizedError("OI 竞赛进行期间需登录查看排名");
    }
    if (!await isParticipant(contestId, viewerId)) {
      throw new ForbiddenError("仅参赛者可查看进行中的 OI 排名");
    }
    const ranking = await getIoiRanking(contestId);
    return ranking.filter((row) => row.user_id === viewerId);
  }

  if (type !== "icpc") {
    return getIoiRanking(contestId);
  }

  const config = contest.config as Record<string, unknown>;
  const freezeTime = typeof config.freeze_time === "string"
    ? config.freeze_time
    : null;
  const unfreezeAfterEnd = config.unfreeze_after_end !== false;
  const isFrozen = !isAdmin && freezeTime !== null &&
    Date.now() >= Date.parse(freezeTime) &&
    !(contest.status === "ended" && unfreezeAfterEnd);
  if (!isFrozen) {
    return getIcpcRanking(contestId);
  }

  const frozen = await getIcpcRanking(contestId, {
    submissionCutoff: freezeTime,
  });
  if (!viewerId || !await isParticipant(contestId, viewerId)) {
    return frozen;
  }

  const live = await getIcpcRanking(contestId);
  const ownLiveRow = live.find((row) => row.user_id === viewerId);
  if (!ownLiveRow) return frozen;
  return frozen.map((row) =>
    row.user_id === viewerId ? { ...ownLiveRow, rank: row.rank } : row
  );
}
