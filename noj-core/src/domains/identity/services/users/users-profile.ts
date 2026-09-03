import { getDb } from "./../../../../shared/db/connection.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { scoreFromDb } from "../../../submission/index.ts";
import type { UserProfileResponse } from "./users-profile-types.ts";
import {
  queryProfileCommunityStats,
  queryProfileMoments,
  queryProfileSolutions,
  queryProfileStats,
  queryProfileUser,
  queryRecentSubmissions,
  querySolvedProblems,
} from "./users-profile-queries.ts";

/** 用户主页聚合响应类型（用户信息、统计、已通过题目、最近提交、社区数据等）。 */
export type { UserProfileResponse } from "./users-profile-types.ts";

/**
 * 获取用户主页聚合数据。
 *
 * 执行 3 次独立查询：
 * 1. 统计聚合（total_submissions, accepted, acceptance_rate, solved_count）
 * 2. 已通过题目列表（去重，按首次通过时间排序）
 * 3. 最近 10 条提交（不含 code 字段）
 *
 * @throws {NotFoundError} 用户不存在
 */
export async function getUserProfileAggregate(
  userId: string,
): Promise<UserProfileResponse> {
  const db = getDb();

  // PR-4：7 个独立 query 改为 Promise.all 并行执行
  // 原串行：~600ms（最慢 query × 7 + 网络 RTT 累加）
  // 并行后：~150ms（最慢那一个 + RTT），约 4x 提速
  const [
    userRow,
    statsRow,
    solvedRows,
    recentRows,
    communityStats,
    solutions,
    moments,
  ] = await Promise.all([
    queryProfileUser(db, userId),
    queryProfileStats(db, userId),
    querySolvedProblems(db, userId),
    queryRecentSubmissions(db, userId),
    queryProfileCommunityStats(db, userId),
    queryProfileSolutions(db, userId),
    queryProfileMoments(db, userId),
  ]);

  if (!userRow) {
    throw new NotFoundError("用户不存在");
  }

  const totalSubmissions = Number(statsRow?.total_submissions ?? 0);
  const accepted = Number(statsRow?.accepted ?? 0);
  const solvedCount = Number(statsRow?.solved_count ?? 0);
  const acceptanceRate = totalSubmissions > 0
    ? Math.round((accepted / totalSubmissions) * 1000) / 1000
    : 0;

  type SolvedProblemRow = {
    problem_id: string;
    problem_title: string;
    difficulty: string;
    accepted_at: string;
  };
  type RecentSubmissionRow = {
    id: string;
    problem_id: string;
    problem_title: string | null;
    language: string;
    status: string;
    result_status: string | null;
    result_score: number | null;
    created_at: string;
  };

  const solvedProblems = solvedRows.map((row: SolvedProblemRow) => ({
    id: row.problem_id,
    title: row.problem_title,
    difficulty: row.difficulty,
    accepted_at: row.accepted_at,
  }));

  const recentSubmissions = recentRows.map((row: RecentSubmissionRow) => ({
    id: row.id,
    problem_id: row.problem_id,
    problem_title: row.problem_title ?? "",
    language: row.language,
    status: row.status,
    result_status: row.result_status ?? null,
    score: row.result_score != null ? scoreFromDb(row.result_score) : null,
    created_at: row.created_at,
  }));

  return {
    user: {
      id: userRow.id,
      username: userRow.username,
      bio: userRow.bio,
      avatar_url: userRow.avatar_url ?? null,
      created_at: userRow.created_at,
    },
    stats: {
      total_submissions: totalSubmissions,
      accepted,
      acceptance_rate: acceptanceRate,
      solved_count: solvedCount,
    },
    solved_problems: solvedProblems,
    recent_submissions: recentSubmissions,
    community_stats: {
      following_count: Number(communityStats?.following_count ?? 0),
      follower_count: Number(communityStats?.follower_count ?? 0),
      solution_count: Number(communityStats?.solution_count ?? 0),
      moment_count: Number(communityStats?.moment_count ?? 0),
    },
    solutions: solutions.map(
      (item: { id: string; title: string | null; created_at: string }) => ({
        ...item,
        title: item.title ?? "",
      }),
    ),
    moments,
  };
}
