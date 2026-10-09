import { and, eq, type SQL, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityPosts,
  evaluationResults,
  problems,
  submissions,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  endedWindowCondition,
  unendedPublicContestForProblem,
} from "./../../../contest/index.ts";
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

/** 个人主页查看者上下文（用于公开赛题目隐藏判定，审计 VULN-07）。 */
export interface ProfileViewerContext {
  /** 查看者 id；匿名/缺省视为非特权 */
  viewerId?: string;
  /** 查看者是否管理员 */
  isAdmin?: boolean;
}

/**
 * 生成"公开赛题目行隐藏"条件；特权场景返回 `null`（不过滤）。
 *
 * 特权 = 管理员、主页本人（看自己的解题记录本就无害）、该题 owner。
 * 其余查看者（含匿名访客与普通登录用户）看不到被尚未结束公开赛收编的题目行。
 * 判据复用 contest 域单一真相源；`viewer` 缺省按非特权处理（fail-closed）。
 */
function contestSecrecyCondition(
  viewer: ProfileViewerContext,
  profileUserId: string,
): SQL | null {
  if (viewer.isAdmin) return null;
  if (viewer.viewerId !== undefined && viewer.viewerId === profileUserId) {
    return null;
  }
  // 赛中数据隔离（决策 3 / DL-02）：非特权查看者彻底排除未结束竞赛提交与受保密公开赛收编的题目
  return sql`(
    (
      ${submissions.contest_id} IS NULL OR EXISTS (
        SELECT 1 FROM contests c_sec
        WHERE c_sec.id = ${submissions.contest_id}
          AND c_sec.affect_global_ranking = TRUE
          AND ${endedWindowCondition(sql`c_sec.end_time`)}
      )
    )
    AND (
      NOT (${unendedPublicContestForProblem(submissions.problem_id)})
      OR ${problems.owner_id} = ${viewer.viewerId ?? null}
    )
  )`;
}

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
  viewer: ProfileViewerContext = {},
): Promise<ProfileStatsRow | undefined> {
  // 计数必须与列表（{@link querySolvedProblems} / {@link queryRecentSubmissions}）
  // **同口径**（面 1.4 审计 F-04a）：否则"solved_count=5 而列表只有 4 行"这一差额本身
  // 就泄露"存在一道被未结束公开赛收编的题目且该用户已通过"，比直接显示该行更隐蔽。
  // 特权查看者（管理员 / 主页本人 / 题目 owner）不受过滤——与列表行为一致。
  const secrecy = contestSecrecyCondition(viewer, userId);
  return db.select({
    total_submissions: sql<number>`count(*)::int`,
    // 通过口径：读有效成绩投影（版本化后由唯一投影服务维护；存量由 0103 回填）
    accepted: sql<
      number
    >`count(*) filter (where ${submissions.is_accepted})::int`,
    solved_count: sql<
      number
    >`count(distinct ${submissions.problem_id}) filter (where ${submissions.is_accepted})::int`,
  })
    .from(submissions)
    // 关联 problems 以复用 `contestSecrecyCondition`（其题目 owner 分支需要该列）；
    // problem_id 为 NOT NULL 外键，inner join 不会丢行。
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .where(
      secrecy
        ? and(eq(submissions.user_id, userId), secrecy)
        : eq(submissions.user_id, userId),
    )
    .then((rows) => rows[0]);
}

/**
 * 3. 已通过题目列表（去重，取首次通过时间）。
 *
 * **公开赛题目隐藏（审计 VULN-07）**：本路径匿名可访问，此前会把"某人已通过某道
 * 正在保密中的公开赛题目"连题目标题一起展示出来——等于让场外人员实时读到赛题
 * 存在性与解题进度。非特权查看者（非管理员、非主页本人、非该题 owner）看不到
 * 这类行；`viewer` 缺省视为非特权（fail-closed）。
 */
export function querySolvedProblems(
  db: Db,
  userId: string,
  viewer: ProfileViewerContext = {},
): Promise<ProfileSolvedProblemRow[]> {
  const secrecy = contestSecrecyCondition(viewer, userId);
  return db.select({
    problem_id: submissions.problem_id,
    problem_title: problems.title,
    difficulty: problems.difficulty,
    accepted_at: sql<string>`min(${submissions.created_at})`,
    // 特权查看者（管理员 / 主页本人 / 题目 owner）才可能看到这类行，
    // 标记出来供前端做"已被公开赛收编"的视觉提示（审计 VULN-07）
    is_contest_hidden: sql<boolean>`${
      unendedPublicContestForProblem(submissions.problem_id)
    }`
      .as("is_contest_hidden"),
  })
    .from(submissions)
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .where(
      secrecy
        ? and(
          eq(submissions.user_id, userId),
          eq(submissions.is_accepted, true),
          secrecy,
        )
        : and(
          eq(submissions.user_id, userId),
          eq(submissions.is_accepted, true),
        ),
    )
    .groupBy(submissions.problem_id, problems.title, problems.difficulty)
    .orderBy(sql`min(${submissions.created_at}) DESC`);
}

/**
 * 4. 最近 10 条提交（不含 code 字段）。
 *
 * 同 {@link querySolvedProblems}：非特权查看者看不到归属于未结束公开赛的题目提交
 * （否则"最近提交"列表会实时暴露赛题标题与评测状态）。
 */
export function queryRecentSubmissions(
  db: Db,
  userId: string,
  viewer: ProfileViewerContext = {},
): Promise<ProfileRecentSubmissionRow[]> {
  const secrecy = contestSecrecyCondition(viewer, userId);
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
    .where(
      secrecy
        ? and(eq(submissions.user_id, userId), secrecy)
        : eq(submissions.user_id, userId),
    )
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
  // 口径必须是 **unended**（含 pending 赛前筹备期），不能用 running：
  // 个人主页匿名可读，用 running 会让"已被未开始公开赛收编"的题解在赛前就可见
  //（面 1.4 审计 F-01）。
  const solutionGate = moderator
    ? sql`true`
    : sql`NOT ${unendedPublicContestForProblem(communityPosts.problem_id)}`;
  return db.select({
    following_count: sql<
      number
    >`(select count(*) from community_follows where follower_id = ${userId})::int`,
    follower_count: sql<
      number
    >`(select count(*) from community_follows where followee_id = ${userId})::int`,
    solution_count: sql<
      number
    >`(select count(*) from community_posts where author_id = ${userId} and type = 'solution' and status = 'published' and ${solutionGate})::int`,
    moment_count: sql<
      number
    >`(select count(*) from community_posts where author_id = ${userId} and type = 'moment' and status = 'published')::int`,
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
  // 口径与 `queryProfileCommunityStats` 一致：**unended**（含 pending），
  // 否则"计数 3、列表 2 条"本身就是侧信道，且赛前窗口会漏（面 1.4 审计 F-01）。
  if (!moderator) {
    conditions.push(
      sql`NOT ${unendedPublicContestForProblem(communityPosts.problem_id)}`,
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
