import { sql } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "./../../../shared/base/errors.ts";
import { unwrapRows } from "./../../../shared/base/sql-rows.ts";
import type {
  ContestType,
  KaggleProblemScore,
  KaggleRankingRow,
} from "../../../types/contests.ts";
import { getContest, isParticipant } from "./contests.ts";

/**
 * 将可能为数组或 JSON 字符串的值解析为数组（解析失败或类型不符时返回空数组）。
 *
 * @param value 待解析的值
 * @returns 解析后的元素数组
 */
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

/**
 * 类 Kaggle 排名计算。
 *
 * 规则：
 * - 每题取历史最高分（同分取最早）
 * - 总分 = Σ(每题最高分)
 * - 平局按“最后一次严格刷新最高分的提交时间”早者优先；同分提交不算刷新
 * - 前三字段均相同时按 registered_at ASC, user_id ASC 稳定排序
 */
export async function getKaggleRanking(
  contestId: string,
): Promise<KaggleRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== "kaggle") {
    throw new BadRequestError("该竞赛不是类 Kaggle 赛制");
  }
  const db = getDb();
  const result = await db.execute(sql`
    WITH contest_data AS (
      SELECT id, start_time, end_time
      FROM contests
      WHERE id = ${contestId}
    ),
    submission_scores AS (
      SELECT s.id, s.user_id, s.problem_id, s.created_at, er.score
      FROM submissions s
      JOIN evaluation_results er ON er.submission_id = s.id
      JOIN contest_data c ON c.id = s.contest_id
      WHERE s.contest_id = ${contestId}
        AND s.created_at <= c.end_time
      UNION ALL
      SELECT os.id, os.user_id, os.paper_id, os.created_at, os.score
      FROM objective_submissions os
      JOIN contest_data c ON c.id = os.contest_id
      WHERE os.contest_id = ${contestId}
        AND os.created_at <= c.end_time
    ),
    ranked AS (
      SELECT
        id,
        user_id,
        problem_id,
        created_at,
        score,
        MAX(score) OVER (
          PARTITION BY user_id, problem_id
          ORDER BY created_at ASC, id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS prev_max
      FROM submission_scores
    ),
    refresh_times AS (
      SELECT user_id, problem_id, MAX(created_at) AS last_refresh_at
      FROM ranked
      WHERE prev_max IS NULL OR score > prev_max
      GROUP BY user_id, problem_id
    ),
    best_rows AS (
      SELECT
        user_id,
        problem_id,
        created_at,
        score,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, problem_id
          ORDER BY score DESC, created_at ASC, id ASC
        ) AS rn
      FROM submission_scores
    ),
    best_scores AS (
      SELECT
        user_id,
        problem_id,
        score AS best_score,
        created_at AS last_best_at
      FROM best_rows
      WHERE rn = 1
    ),
    attempts AS (
      SELECT user_id, problem_id, COUNT(*)::int AS attempts
      FROM submission_scores
      GROUP BY user_id, problem_id
    ),
    problem_stats AS (
      SELECT
        participant.user_id,
        participant.registered_at,
        cp.problem_id,
        cp.label,
        cp.sort_order,
        COALESCE(bs.best_score, 0)::int AS best_score,
        COALESCE(at.attempts, 0)::int AS attempts,
        bs.last_best_at,
        rt.last_refresh_at
      FROM contest_participants participant
      CROSS JOIN contest_problems cp
      LEFT JOIN best_scores bs
        ON bs.user_id = participant.user_id
        AND bs.problem_id = cp.problem_id
      LEFT JOIN attempts at
        ON at.user_id = participant.user_id
        AND at.problem_id = cp.problem_id
      LEFT JOIN refresh_times rt
        ON rt.user_id = participant.user_id
        AND rt.problem_id = cp.problem_id
      WHERE participant.contest_id = ${contestId}
        AND cp.contest_id = ${contestId}
    ),
    user_totals AS (
      SELECT
        ps.user_id,
        ps.registered_at,
        SUM(ps.best_score)::int AS total_score,
        MAX(ps.last_refresh_at) AS last_submission_at,
        jsonb_agg(
          jsonb_build_object(
            'label', ps.label,
            'best_score', ps.best_score,
            'attempts', ps.attempts,
            'last_best_at', ps.last_best_at
          ) ORDER BY ps.sort_order, ps.label
        ) AS problem_scores
      FROM problem_stats ps
      GROUP BY ps.user_id, ps.registered_at
    )
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          ut.total_score DESC,
          ut.last_submission_at ASC NULLS LAST,
          ut.registered_at ASC,
          ut.user_id ASC
      )::int AS rank,
      ut.user_id,
      u.username,
      u.avatar_url,
      ut.total_score,
      ut.last_submission_at,
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
    last_submission_at: row.last_submission_at === null
      ? null
      : String(row.last_submission_at),
    problem_scores: parseJsonArray<KaggleProblemScore>(row.problem_scores),
  }));
}

/**
 * 获取竞赛排名（类 Kaggle）。
 *
 * 实时榜/最终榜使用同一计算；进行中非管理员仅返回自己的排名。
 */
export async function getContestRanking(
  contestId: string,
  type: ContestType,
  isAdmin = false,
  viewerId?: string,
): Promise<KaggleRankingRow[]> {
  const contest = await getContest(contestId);
  if (contest.type !== type) {
    throw new BadRequestError("排名类型与竞赛赛制不一致");
  }

  const ranking = await getKaggleRanking(contestId);

  if (contest.status === "running" && !isAdmin) {
    if (!viewerId) {
      throw new UnauthorizedError("竞赛进行期间需登录查看排名");
    }
    if (!await isParticipant(contestId, viewerId)) {
      throw new ForbiddenError("仅参赛者可查看进行中的排名");
    }
    return ranking.filter((row) => row.user_id === viewerId);
  }

  return ranking;
}
