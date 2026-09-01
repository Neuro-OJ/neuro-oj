import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../../db/schema.ts";
import { NotFoundError } from "../../../../lib/errors.ts";
import type {
  CommunityConfig,
  CommunityPostStatus,
  CommunityPostType,
} from "../../../../types/community.ts";
import { getCommunityConfig } from "./community-config.ts";

export function featureForType(type: CommunityPostType): keyof CommunityConfig {
  return type === "solution"
    ? "solutions_enabled"
    : type === "discussion"
    ? "discussions_enabled"
    : "moments_enabled";
}

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
export async function resolveProblemId(
  reference: string,
): Promise<string | null> {
  const db = getDb();
  // 按 problems.id 主键查找（UUID 或旧 seed 的数字 id）
  const findByPk = async (id: string): Promise<string | null> => {
    const row = await db.select({ id: problems.id }).from(problems)
      .where(eq(problems.id, id)).limit(1);
    return row[0]?.id ?? null;
  };
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(reference)) {
    return findByPk(reference);
  }
  const match = reference.match(/^([UuPp])(\d+)$/);
  if (match) {
    const row = await db.select({ id: problems.id }).from(problems).where(and(
      eq(problems.type, match[1].toUpperCase()),
      eq(problems.number, parseInt(match[2], 10)),
    )).limit(1);
    return row[0]?.id ?? null;
  }
  // 纯数字：先按 PK 查找（旧 seed 数据 1001/1002/1003 以数字为 id），再按 type=P+number 兜底
  if (/^\d+$/.test(reference)) {
    const byPk = await findByPk(reference);
    if (byPk) return byPk;
    const fallback = await db.select({ id: problems.id }).from(problems)
      .where(and(
        eq(problems.type, "P"),
        eq(problems.number, parseInt(reference, 10)),
      )).limit(1);
    return fallback[0]?.id ?? null;
  }
  // 兜底：其余格式按 PK 尝试
  return findByPk(reference);
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
