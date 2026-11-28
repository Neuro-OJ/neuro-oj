/**
 * 练习能力值（Best-N Practice Rating）查询服务（issue #810）。
 *
 * 口径与边界：
 * - 纯派生查询：直接基于官方主域（`main` / `DEFAULT_DOMAIN_ID`）公开题库的
 *   有效成绩与题目校准难度实时计算，零写入负担、不侵入提交主链路。
 * - 防刷边界：
 *   1. 仅统计主域已发布且主域绑定可用（`disabled_at IS NULL`）的公开题目；
 *      私有域、教学域、团队域的自建题目完全排除。
 *   2. 仅统计练习提交与已结束比赛的有效成绩；进行中比赛提交与仍处于未结束
 *      公开赛保密保护期的题目一律排除。
 *   3. 零耦合：不依赖知识图谱总开关、不计入签到/评论/点赞/举报、不耦合 LLM 配额。
 */
import { eq, sql } from "drizzle-orm";
import { FULL_SCORE, ROOT_USER_ID } from "../../shared/base/constants.ts";
import { BadRequestError, NotFoundError } from "../../shared/base/errors.ts";
import { unwrapRows } from "../../shared/base/sql-rows.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import { users } from "../../shared/db/schema.ts";
import { unifiedSubmissionSources } from "../../shared/versioning/submission-sources.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../shared/workspace/types.ts";
import {
  endedWindowCondition,
  unendedPublicContestForProblem,
} from "../../modules/contests/index.ts";
import { domainProblemBindingAvailableWhere } from "../../modules/problems/index.ts";
import {
  PRACTICE_RATING_FORMULA_VERSION,
  PRACTICE_RATING_TOP_N,
  type PracticeRatingEntry,
  type PracticeRatingLeaderboard,
  type PracticeRatingLeaderboardRow,
  type UserPracticeRating,
} from "../../shared/api-contracts/features.ts";
import {
  aggregatePracticeRating,
  computeProblemRating,
  OBJECTIVE_QUESTION_SCORE_UNIT,
  resolvePracticeRatingTier,
} from "./formula.ts";

interface EligibleProblemScoreRow {
  problem_id: string;
  number: number;
  title: string;
  difficulty: string;
  effective_difficulty: number;
  is_calibrated: boolean;
  is_objective: boolean;
  submission_mode: string;
  best_score: number;
  full_score: number;
  achieved_at: string;
}

interface LeaderboardSqlRow {
  total: number;
  data: {
    rank: number;
    user_id: string;
    username: string;
    avatar_url: string | null;
    rating: number;
    counted_problems: number;
    top_problem_rating: number;
  }[];
  user_rank: number | null;
  user_rating: number | null;
}

interface SingleUserRankRow {
  rank: number | null;
}

/**
 * 构造官方主域公开题库的有效每题最高分 CTE（单用户与全站榜共用同一口径）。
 *
 * 说明：
 * - `userFilter` 传入时下推到 submissions 过滤，保持单用户查询 O(该用户提交数)；
 * - `full_score` 对普通题固定 `FULL_SCORE`（10000），对客观题套卷取作答版本小题数 × 100；
 * - `problem_rating` 使用 `floor(... + 0.5)::int` 与 TS `computeProblemRating` 严格等价。
 */
function eligibleBestScoresCte(userId?: string) {
  const userClause = userId ? sql`AND s.user_id = ${userId}` : sql``;
  return sql`
    eligible_problems AS (
      SELECT
        p.id AS problem_id,
        p.number,
        p.title,
        p.difficulty,
        p.is_objective,
        p.submission_mode,
        coalesce(
          pd.calibrated,
          CASE p.difficulty
            WHEN 'easy' THEN 25
            WHEN 'hard' THEN 75
            ELSE 50
          END
        )::int AS effective_difficulty,
        (pd.calibrated IS NOT NULL) AS is_calibrated,
        CASE
          WHEN p.is_objective THEN (
            CASE
              WHEN jsonb_typeof(pv.content->'questions') = 'array'
                THEN jsonb_array_length(pv.content->'questions') * ${OBJECTIVE_QUESTION_SCORE_UNIT}
              ELSE 0
            END
          )
          ELSE ${FULL_SCORE}
        END::int AS full_score
      FROM problems p
      JOIN domains d ON d.id = ${DEFAULT_DOMAIN_ID}
        AND d.status <> 'suspended'
        AND d.configuration->>'access' = 'public'
      JOIN domain_problem_bindings b
        ON b.domain_id = ${DEFAULT_DOMAIN_ID}
        AND b.problem_id = p.id
      LEFT JOIN problem_difficulty pd ON pd.problem_id = p.id
      LEFT JOIN problem_versions pv
        ON pv.problem_id = p.id
        AND pv.id = CASE
          WHEN p.effective_version_mode = 'exact' THEN p.required_version_id
          ELSE p.latest_version_id
        END
      WHERE p.domain_id = ${DEFAULT_DOMAIN_ID}
        AND p.latest_version_id IS NOT NULL
        AND ${
    domainProblemBindingAvailableWhere(
      sql`b.id`,
      sql`${DEFAULT_DOMAIN_ID}`,
      { member: false },
    )
  }
        AND NOT (${
    unendedPublicContestForProblem(sql`p.id`, sql`${DEFAULT_DOMAIN_ID}`)
  })
    ),
    best_per_user_problem AS (
      SELECT DISTINCT ON (s.user_id, s.problem_id)
        s.user_id,
        ep.problem_id,
        ep.number,
        ep.title,
        ep.difficulty,
        ep.effective_difficulty,
        ep.is_calibrated,
        ep.is_objective,
        ep.submission_mode,
        a.score::int AS best_score,
        ep.full_score,
        coalesce(a.finished_at, s.created_at) AS achieved_at
      FROM (SELECT * FROM ${unifiedSubmissionSources}) s
      JOIN eligible_problems ep ON ep.problem_id = s.problem_id
      JOIN evaluation_attempts a ON a.id = s.effective_attempt_id
      WHERE ep.full_score > 0
        AND s.is_valid = TRUE
        AND coalesce(s.domain_id, ${DEFAULT_DOMAIN_ID}) = ${DEFAULT_DOMAIN_ID}
        AND a.result_kind = 'graded'
        AND a.score IS NOT NULL
        AND a.score > 0
        ${userClause}
        AND (
          s.contest_id IS NULL OR EXISTS (
            SELECT 1 FROM contests c
            WHERE c.id = s.contest_id
              AND c.domain_id = ${DEFAULT_DOMAIN_ID}
              AND ${endedWindowCondition(sql`c.end_time`)}
          )
        )
      ORDER BY
        s.user_id,
        s.problem_id,
        a.score DESC,
        coalesce(a.finished_at, s.created_at) ASC,
        s.id ASC
    ),
    scored_entries AS (
      SELECT
        b.*,
        round(
          least(
            1.0::numeric,
            greatest(0.0::numeric, b.best_score::numeric / b.full_score::numeric)
          ),
          4
        )::double precision AS score_ratio,
        floor(
          (
            50.0
            + 2.0 * b.effective_difficulty::double precision
            + 0.025 * b.effective_difficulty::double precision * b.effective_difficulty::double precision
          ) * power(
            least(
              1.0::double precision,
              greatest(
                0.0::double precision,
                b.best_score::double precision / b.full_score::double precision
              )
            ),
            1.5
          ) + 0.5
        )::int AS problem_rating
      FROM best_per_user_problem b
    )
  `;
}

/** 构造全站练习能力值排名 CTE（与单用户查询共用 `eligibleBestScoresCte`）。 */
function globalRankedUsersCte() {
  return sql`
    ${eligibleBestScoresCte()},
    user_top_entries AS (
      SELECT
        se.user_id,
        se.problem_rating,
        row_number() OVER (
          PARTITION BY se.user_id
          ORDER BY
            se.problem_rating DESC,
            se.effective_difficulty DESC,
            se.score_ratio DESC,
            se.achieved_at ASC,
            se.problem_id ASC
        )::int AS rn
      FROM scored_entries se
      WHERE se.problem_rating > 0
    ),
    user_totals AS (
      SELECT
        u.id AS user_id,
        u.username,
        u.avatar_url,
        u.created_at,
        sum(t.problem_rating)::int AS rating,
        count(*)::int AS counted_problems,
        max(t.problem_rating)::int AS top_problem_rating
      FROM user_top_entries t
      JOIN users u ON u.id = t.user_id
      WHERE t.rn <= ${PRACTICE_RATING_TOP_N}
        AND u.id <> ${ROOT_USER_ID}
        AND u.deleted_at IS NULL
      GROUP BY u.id, u.username, u.avatar_url, u.created_at
      HAVING sum(t.problem_rating) > 0
    ),
    ranked_users AS (
      SELECT
        row_number() OVER (
          ORDER BY
            rating DESC,
            top_problem_rating DESC,
            counted_problems DESC,
            created_at ASC,
            user_id ASC
        )::int AS rank,
        user_id,
        username,
        avatar_url,
        rating,
        counted_problems,
        top_problem_rating
      FROM user_totals
    )
  `;
}

/** 校验用户存在且未注销。 */
async function assertActiveUser(userId: string, db: DbRoot): Promise<void> {
  const [row] = await db
    .select({ id: users.id, deleted_at: users.deleted_at })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.deleted_at !== null) {
    throw new NotFoundError("用户不存在");
  }
}

/** 查询用户在全站练习能力值榜中的名次；root 或未上榜返回 null。 */
async function queryUserPracticeRatingRank(
  userId: string,
  db: DbRoot,
): Promise<number | null> {
  if (userId === ROOT_USER_ID) return null;
  const result = await db.execute(sql`
    WITH ${globalRankedUsersCte()}
    SELECT rank FROM ranked_users WHERE user_id = ${userId} LIMIT 1
  `);
  const [row] = unwrapRows<SingleUserRankRow>(result as never);
  return row ? Number(row.rank) : null;
}

/**
 * 获取单用户的练习能力值概览与 Top-N 构成明细。
 */
export async function getUserPracticeRating(
  userId: string,
  db: DbRoot = getDb(),
): Promise<UserPracticeRating> {
  await assertActiveUser(userId, db);

  const rawRows = await db.execute(sql`
    WITH ${eligibleBestScoresCte(userId)}
    SELECT
      problem_id,
      number,
      title,
      difficulty,
      effective_difficulty,
      is_calibrated,
      is_objective,
      submission_mode,
      best_score,
      full_score,
      achieved_at
    FROM best_per_user_problem
  `);

  const rows = unwrapRows<EligibleProblemScoreRow>(rawRows as never);
  const candidates = rows.map((row) => {
    const effectiveDifficulty = Number(row.effective_difficulty);
    const bestScore = Number(row.best_score);
    const fullScore = Number(row.full_score);
    const { scoreRatio, problemRating } = computeProblemRating({
      difficulty: effectiveDifficulty,
      score: bestScore,
      fullScore,
    });
    return {
      problem_id: row.problem_id,
      number: Number(row.number),
      display_id: `${DEFAULT_DOMAIN_SLUG}:${Number(row.number)}`,
      title: row.title,
      difficulty: row.difficulty,
      effective_difficulty: effectiveDifficulty,
      is_calibrated: Boolean(row.is_calibrated),
      is_objective: Boolean(row.is_objective),
      submission_mode: row.submission_mode,
      best_score: bestScore,
      full_score: fullScore,
      score_ratio: scoreRatio,
      problem_rating: problemRating,
      achieved_at: row.achieved_at,
    };
  });

  const aggregated = aggregatePracticeRating(candidates, PRACTICE_RATING_TOP_N);
  const entries: PracticeRatingEntry[] = aggregated.topEntries.map((
    item,
    idx,
  ) => ({
    rank: idx + 1,
    ...item,
  }));

  const rank = aggregated.rating > 0
    ? await queryUserPracticeRatingRank(userId, db)
    : null;

  return {
    user_id: userId,
    rating: aggregated.rating,
    tier: aggregated.tier,
    top_n: aggregated.topN,
    counted_problems: aggregated.countedProblems,
    total_scored_problems: aggregated.totalScoredProblems,
    floor_rating: aggregated.floorRating,
    rank,
    entries,
    formula_version: PRACTICE_RATING_FORMULA_VERSION,
  };
}

/**
 * 获取全站练习能力值排行榜（分页，公开只读）。
 */
export async function getPracticeRatingLeaderboard(
  page: number = 1,
  perPage: number = 50,
  currentUserId?: string,
  db: DbRoot = getDb(),
): Promise<PracticeRatingLeaderboard> {
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new BadRequestError("per_page 必须为正整数");
  }
  const size = Math.min(perPage, 100);
  const offset = (page - 1) * size;

  const userRankSelect = currentUserId
    ? sql`(SELECT rank FROM ranked_users WHERE user_id = ${currentUserId} LIMIT 1)`
    : sql`NULL::int`;
  const userRatingSelect = currentUserId
    ? sql`(SELECT rating FROM ranked_users WHERE user_id = ${currentUserId} LIMIT 1)`
    : sql`NULL::int`;

  const result = await db.execute(sql`
    WITH ${globalRankedUsersCte()}
    SELECT
      (SELECT count(*)::int FROM ranked_users) AS total,
      coalesce(
        (
          SELECT json_agg(selected ORDER BY selected.rank)
          FROM (
            SELECT
              rank,
              user_id,
              username,
              avatar_url,
              rating,
              counted_problems,
              top_problem_rating
            FROM ranked_users
            ORDER BY rank
            LIMIT ${size}
            OFFSET ${offset}
          ) selected
        ),
        '[]'::json
      ) AS data,
      ${userRankSelect} AS user_rank,
      ${userRatingSelect} AS user_rating
  `);

  const [row] = unwrapRows<LeaderboardSqlRow>(result as never);
  const data: PracticeRatingLeaderboardRow[] = (row?.data ?? []).map((item) => {
    const rating = Number(item.rating);
    return {
      rank: Number(item.rank),
      user_id: item.user_id,
      username: item.username,
      avatar_url: item.avatar_url ?? null,
      rating,
      tier: resolvePracticeRatingTier(rating),
      counted_problems: Number(item.counted_problems),
      top_problem_rating: Number(item.top_problem_rating),
    };
  });

  return {
    data,
    total: Number(row?.total ?? 0),
    user_rank: row?.user_rank != null ? Number(row.user_rank) : null,
    user_rating: row?.user_rating != null ? Number(row.user_rating) : null,
  };
}
