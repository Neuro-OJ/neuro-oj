import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityPosts,
  evaluationResults,
  submissions,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { resolveProblemIdOrNull } from "./../../../catalog/index.ts";
import {
  hasUnendedPublicContest,
  unendedPublicContestForProblem,
} from "./../../../contest/index.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "./../../types/community.ts";
import { getCommunityConfig } from "./community-config.ts";

/**
 * 赛时社区全局静默（决策 1 · 方案 A · N-01）的单一入口。
 *
 * 公开赛未结束（含 pending 筹备期）时，普通用户禁止一切可向全场广播文本的社区写入：
 * 新建讨论/动态、编辑讨论/动态、发表评论、编辑评论。此前只拦了新建帖子，
 * 评论与编辑旧帖仍可向全场广播完整解法。审核员免静默，用于官方说明与治理。
 *
 * @param moderator 是否为审核员。
 * @throws {ForbiddenError} 存在未结束公开赛且非审核员时抛出（code=CONTEST_SILENCE）。
 */
export async function assertNotContestSilenced(
  moderator: boolean,
): Promise<void> {
  if (moderator) return;
  if (await hasUnendedPublicContest()) {
    throw new ForbiddenError(
      "比赛期间全站暂停公开发布讨论、动态与评论，参赛提问请使用赛中答疑",
      "CONTEST_SILENCE",
    );
  }
}

/**
 * 根据帖子类型返回对应的功能开关配置项。
 * @param type 帖子类型：solution / discussion / moment。
 * @returns 对应的 CommunityConfig 功能开关键。
 */
export function featureForType(type: CommunityPostType): keyof CommunityConfig {
  return type === "solution"
    ? "solutions_enabled"
    : type === "discussion"
    ? "discussions_enabled"
    : "moments_enabled";
}

/**
 * 计算用户的发布状态：新用户审核期（new_user_review_hours）内返回 pending，否则 published。
 * @param authorId 作者用户 UUID。
 * @returns 发布状态：pending 或 published。
 * @throws {NotFoundError} 用户不存在时抛出。
 */
export async function publicationStatus(
  authorId: string,
): Promise<CommunityPostStatus> {
  const reviewHours = getCommunityConfig().new_user_review_hours;
  if (reviewHours <= 0) return "published";
  const db = getDb();
  const row = await db.select({ created_at: users.created_at }).from(users)
    .where(eq(users.id, authorId)).limit(1);
  if (!row[0]) throw new NotFoundError("用户不存在");
  return Date.parse(row[0].created_at) + reviewHours * 3600_000 > Date.now()
    ? "pending"
    : "published";
}

/**
 * 解析题目引用为 problems.id（UUID）。
 * 支持 UUID、display_id（P1001 / U42）、纯数字（兼容旧 seed 数据 1001/1002/1003）。
 * 题目不存在时返回 null。
 */
export function resolveProblemId(
  reference: string,
): Promise<string | null> {
  return resolveProblemIdOrNull(reference);
}

/** 查询用户是否已通过指定题目（finished 且 score>0，供门槛判定与题解发布入口使用）。 */
export async function hasAcceptedSolution(
  authorId: string,
  problemId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ id: submissions.id }).from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(
      eq(submissions.user_id, authorId),
      eq(submissions.problem_id, problemId),
      eq(evaluationResults.status, "finished"),
      gt(evaluationResults.score, 0),
    )).limit(1);
  return !!rows[0];
}

/**
 * 公开赛保密读取门控谓词：排除「所属题目归属于尚未结束的公开赛」的**题解与讨论帖**。
 *
 * 采用**相关子查询**而非「先查题目 id 再拼 IN 列表」：
 * - 不产生应用侧扫描，不受题量规模影响（IN 列表方案必须设上限，
 *   上限一旦被超出就会**静默漏掉**应门控的题目——对安全门控这是不可接受的失效模式）；
 * - 时间窗口在 SQL 内实时比较，竞赛结束后自动放行，无需调度任务。
 *
 * 判定**不在本文件内手写**：委托 contest 域的权威谓词
 * `unendedPublicContestForProblem`（审计 §4.1 单一真相源）。此前的实现在两处发生
 * 口径漂移（2026-09-28 审计 VULN-02）：
 * 1. 只覆盖 `type = 'solution'`，**漏掉 `discussion`**；
 * 2. 只查 `running` 窗口（`start <= now < end`），于是公开赛**赛前筹备期
 *    （pending，已挂题但未开赛）完全放行**——正是最需要保密的阶段。
 *
 * @returns 可直接 push 进 drizzle conditions 数组的 SQL 片段。
 */
export function notGatedContestContent(): SQL {
  return sql`NOT (
    ${communityPosts.type} IN ('solution', 'discussion')
    AND ${communityPosts.problem_id} IS NOT NULL
    AND ${unendedPublicContestForProblem(communityPosts.problem_id)}
  )`;
}
