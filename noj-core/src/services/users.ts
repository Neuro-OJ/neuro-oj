import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { scoreFromDb } from "../types/index.ts";

/**
 * 用户主页响应——聚合统计、已通过题目、最近提交。
 */
export interface UserProfileResponse {
  user: {
    id: string;
    username: string;
    bio: string;
    created_at: string;
  };
  stats: {
    total_submissions: number;
    accepted: number;
    acceptance_rate: number;
    solved_count: number;
  };
  solved_problems: {
    id: string;
    title: string;
    difficulty: string;
    accepted_at: string;
  }[];
  recent_submissions: {
    id: string;
    problem_id: string;
    problem_title: string;
    language: string;
    status: string;
    result_status: string | null;
    score: number | null;
    created_at: string;
  }[];
}

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
export async function getUserProfile(
  userId: string,
): Promise<UserProfileResponse> {
  const db = getDb();

  // 1. 验证用户存在
  const [userRow] = await db
    .select({
      id: users.id,
      username: users.username,
      bio: users.bio,
      created_at: users.created_at,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) {
    throw new NotFoundError("用户不存在");
  }

  // 2. 统计查询：总提交数、Accepted 数、解题数
  const [statsRow] = await db
    .select({
      total_submissions: sql<number>`count(*)`,
      accepted: sql<
        number
      >`count(*) filter (where ${evaluationResults.status} = 'Accepted')`,
      solved_count: sql<
        number
      >`count(distinct ${submissions.problem_id}) filter (where ${evaluationResults.status} = 'Accepted')`,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(eq(submissions.user_id, userId));

  const totalSubmissions = Number(statsRow?.total_submissions ?? 0);
  const accepted = Number(statsRow?.accepted ?? 0);
  const solvedCount = Number(statsRow?.solved_count ?? 0);
  const acceptanceRate = totalSubmissions > 0
    ? Math.round((accepted / totalSubmissions) * 1000) / 1000
    : 0;

  // 3. 已通过题目列表（去重，取首次通过时间）
  const solvedRows = await db
    .select({
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      difficulty: problems.difficulty,
      accepted_at: sql<string>`min(${submissions.created_at})`,
    })
    .from(submissions)
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .innerJoin(
      evaluationResults,
      and(
        eq(evaluationResults.submission_id, submissions.id),
        eq(evaluationResults.status, "Accepted"),
      ),
    )
    .where(eq(submissions.user_id, userId))
    .groupBy(submissions.problem_id, problems.title, problems.difficulty)
    .orderBy(sql`min(${submissions.created_at}) DESC`);

  const solvedProblems = solvedRows.map((row) => ({
    id: row.problem_id,
    title: row.problem_title,
    difficulty: row.difficulty,
    accepted_at: row.accepted_at,
  }));

  // 4. 最近 10 条提交（不含 code 字段）
  const recentRows = await db
    .select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      language: submissions.language,
      status: submissions.status,
      result_status: evaluationResults.status,
      result_score: evaluationResults.score,
      created_at: submissions.created_at,
    })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id))
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(eq(submissions.user_id, userId))
    .orderBy(sql`${submissions.created_at} DESC`)
    .limit(10);

  const recentSubmissions = recentRows.map((row) => ({
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
  };
}

const BIO_MAX_LENGTH = 5000;

/**
 * 更新用户个人简介（bio）。
 *
 * 校验 bio 长度不超过 BIO_MAX_LENGTH（5000 字符），
 * 然后更新 users 表的 bio 字段，返回更新后的用户基本信息。
 *
 * @throws {ValidationError} bio 超长时抛出
 */
export async function updateUserProfile(
  userId: string,
  bio: string,
): Promise<{ id: string; username: string; bio: string }> {
  const db = getDb();

  if (bio.length > BIO_MAX_LENGTH) {
    throw new ValidationError(`bio 长度不能超过 ${BIO_MAX_LENGTH} 字`);
  }

  const [updated] = await db
    .update(users)
    .set({ bio, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      bio: users.bio,
    });

  if (!updated) {
    throw new NotFoundError("用户不存在");
  }

  return updated;
}
