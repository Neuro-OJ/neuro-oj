import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityPosts,
  evaluationResults,
  problems,
  submissions,
  users,
} from "./../../../../shared/db/schema.ts";
// 经 contest 域公开门面（index.ts）导入：域边界门禁要求跨域只能走 index.ts，
// 深路径导入会被 check-domains.ts 判为违规。
import { runningContestExistsForProblem } from "./../../../contest/index.ts";
import type {
  ProfileCommunityStatsRow,
  ProfileMomentRow,
  ProfileRecentSubmissionRow,
  ProfileSolutionRow,
  ProfileSolvedProblemRow,
  ProfileStatsRow,
  ProfileUserRow,
} from "./users-profile-types.ts";

type Db = ReturnType<typeof getDb>;

/** 1. 验证用户存在（同时取基础信息）。 */
export function queryProfileUser(
  db: Db,
  userId: string,
): Promise<ProfileUserRow | undefined> {
  return db.select({
    id: users.id,
    username: users.username,
    bio: users.bio,
    avatar_url: users.avatar_url,
    created_at: users.created_at,
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0]);
}

/** 2. 统计查询：总提交数、通过数、解题数。 */
export function queryProfileStats(
  db: Db,
  userId: string,
): Promise<ProfileStatsRow | undefined> {
  return db.select({
    total_submissions: sql<number>`count(*)`,
    accepted: sql<
      number
    >`count(*) filter (where ${evaluationResults.status} = 'finished' and ${evaluationResults.score} > 0)`,
    solved_count: sql<
      number
    >`count(distinct ${submissions.problem_id}) filter (where ${evaluationResults.status} = 'finished' and ${evaluationResults.score} > 0)`,
  })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(eq(submissions.user_id, userId))
    .then((rows) => rows[0]);
}

/** 3. 已通过题目列表（去重，取首次通过时间）。 */
export function querySolvedProblems(
  db: Db,
  userId: string,
): Promise<ProfileSolvedProblemRow[]> {
  return db.select({
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
        eq(evaluationResults.status, "finished"),
        gt(evaluationResults.score, 0),
      ),
    )
    .where(eq(submissions.user_id, userId))
    .groupBy(submissions.problem_id, problems.title, problems.difficulty)
    .orderBy(sql`min(${submissions.created_at}) DESC`);
}

/** 4. 最近 10 条提交（不含 code 字段）。 */
export function queryRecentSubmissions(
  db: Db,
  userId: string,
): Promise<ProfileRecentSubmissionRow[]> {
  return db.select({
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
}

/**
 * 5. 社区关注/内容统计。
 *
 * **赛期门控**（2026-09-14 评审 High#2）：`solution_count` 此前把进行中竞赛的题解
 * 也计入，即使标题已被 High#1 门控，数量本身仍会泄露"该题有题解"。
 * 计数与列表口径必须一致——否则"数量 3、列表 2 条"本身就是侧信道。
 *
 * @param db 数据库句柄。
 * @param userId 主页用户 id。
 * @param moderator 审核员视图（免赛期门控）。
 */
export function queryProfileCommunityStats(
  db: Db,
  userId: string,
  moderator = false,
): Promise<ProfileCommunityStatsRow | undefined> {
  // 门控谓词只作用于题解计数；动态计数不受竞赛影响
  const solutionGate = moderator
    ? sql`true`
    : sql`NOT ${runningContestExistsForProblem(communityPosts.problem_id)}`;
  return db.select({
    following_count: sql<
      number
    >`(select count(*) from community_follows where follower_id = ${userId})`,
    follower_count: sql<
      number
    >`(select count(*) from community_follows where followee_id = ${userId})`,
    solution_count: sql<
      number
    >`(select count(*) from community_posts where author_id = ${userId} and type = 'solution' and status = 'published' and ${solutionGate})`,
    moment_count: sql<
      number
    >`(select count(*) from community_posts where author_id = ${userId} and type = 'moment' and status = 'published')`,
  }).from(users).where(eq(users.id, userId)).limit(1).then((rows) => rows[0]);
}

/**
 * 6. 最近 10 条已发布题解。
 *
 * **赛期门控**（2026-09-14 评审 High#1）：本路径**匿名可访问**，此前会向任何人
 * 泄露进行中竞赛题目的题解**标题**与内部 id。门控须与社区列表口径一致，
 * 否则此处即为旁路。`moderator`（审核员）免门控，与 `listPosts` 一致。
 *
 * @param db 数据库句柄。
 * @param userId 主页用户 id。
 * @param moderator 审核员视图（免赛期门控）。
 */
export function queryProfileSolutions(
  db: Db,
  userId: string,
  moderator = false,
): Promise<ProfileSolutionRow[]> {
  const conditions = [
    eq(communityPosts.author_id, userId),
    eq(communityPosts.type, "solution"),
    eq(communityPosts.status, "published"),
  ];
  // 直接用 contest 域的共享谓词而非 community 域的 notGatedSolution()：
  // 本查询已固定 type='solution'，无需重复该判断，同时避免 identity → community 反向依赖
  if (!moderator) {
    conditions.push(
      sql`NOT ${runningContestExistsForProblem(communityPosts.problem_id)}`,
    );
  }
  return db.select({
    id: communityPosts.id,
    title: communityPosts.title,
    created_at: communityPosts.created_at,
  })
    .from(communityPosts).where(
      and(...conditions),
    ).orderBy(sql`${communityPosts.created_at} DESC`).limit(10);
}

/** 7. 最近 10 条已发布短动态。 */
export function queryProfileMoments(
  db: Db,
  userId: string,
): Promise<ProfileMomentRow[]> {
  return db.select({
    id: communityPosts.id,
    content: communityPosts.content,
    created_at: communityPosts.created_at,
  })
    .from(communityPosts).where(
      and(
        eq(communityPosts.author_id, userId),
        eq(communityPosts.type, "moment"),
        eq(communityPosts.status, "published"),
      ),
    ).orderBy(sql`${communityPosts.created_at} DESC`).limit(10);
}
