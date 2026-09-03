import { and, eq, gt } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  evaluationResults,
  submissions,
  users,
} from "./../../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { resolveProblemIdOrNull } from "../../../../lib/problem-resolve.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "../../../../types/community.ts";
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
