import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityPosts,
  evaluationResults,
  submissions,
  users,
} from "./../../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { resolveProblemIdOrNull } from "./../../../catalog/index.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "./../../types/community.ts";
import { getCommunityConfig } from "./community-config.ts";

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
 * 赛期题解门控谓词：排除「所属题目正在竞赛中」的题解帖子。
 *
 * 采用**相关子查询**而非「先查题目 id 再拼 IN 列表」：
 * - 不产生应用侧扫描，不受题量规模影响（IN 列表方案必须设上限，
 *   上限一旦被超出就会**静默漏掉**应门控的题目——对安全门控这是不可接受的失效模式）；
 * - 时间窗口在 SQL 内实时比较，竞赛结束后自动放行，无需调度任务。
 *
 * 时间格式：`contests.start_time` / `end_time` 是 ISO 8601 **文本**列，
 * 故用 `to_char` 生成同形状串做字典序比较（与 `new Date().toISOString()` 等价）。
 *
 * @returns 可直接 push 进 drizzle conditions 数组的 SQL 片段。
 */
export function notGatedSolution() {
  return sql`NOT (
    ${communityPosts.type} = 'solution'
    AND ${communityPosts.problem_id} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE cp.problem_id = ${communityPosts.problem_id}
        AND c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND c.end_time > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )`;
}
