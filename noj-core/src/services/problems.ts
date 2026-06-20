import { asc, count, eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import { NotFoundError } from "../lib/errors.ts";

export interface ProblemResponse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  judge_image: string;
  judge_command: string;
  support_package_path: string | null;
  time_limit_ms: number;
  memory_limit_mb: number;
  created_at: string;
  updated_at: string;
}

export interface ProblemListResponse {
  items: ProblemResponse[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 将数据库行转换为题目响应。
 */
function toProblemResponse(row: typeof problems.$inferSelect): ProblemResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    difficulty: row.difficulty,
    judge_image: row.judge_image,
    judge_command: row.judge_command,
    support_package_path: row.support_package_path,
    time_limit_ms: row.time_limit_ms,
    memory_limit_mb: row.memory_limit_mb,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 分页获取题目列表。
 */
export async function listProblems(
  page: number = 1,
  limit: number = 20,
): Promise<ProblemListResponse> {
  const db = getDb();
  const offset = (page - 1) * limit;

  // 查询列表
  const items = await db
    .select()
    .from(problems)
    .orderBy(asc(problems.id))
    .limit(limit)
    .offset(offset);

  // 查询总数
  const countResult = await db.select({ count: count() }).from(problems);
  const total = Number(countResult[0]?.count ?? 0);

  return {
    items: items.map(toProblemResponse),
    total,
    page,
    limit,
  };
}

/**
 * 根据 ID 获取题目详情。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function getProblem(id: string): Promise<ProblemResponse> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  return toProblemResponse(existing[0]);
}
