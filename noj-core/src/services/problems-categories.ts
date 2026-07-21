/**
 * Problems ↔ Categories 关联维护（PR 拆分 PR-3）。
 *
 * 只放：
 * - syncProblemCategories：先删后插的事务化同步（被 crud / export 复用）
 *
 * 独立的理由：
 * - 与 problems 表无强耦合，单独抽离便于后续拓展批量操作（如批量改分类）
 * - 被 problems-crud.ts（createProblem / updateProblem）与 problems-export.ts
 *   （importOne overwrite 路径）共同依赖
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { categories, problemsCategories } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";

/**
 * 同步题目的分类关联（先删后插）。
 *
 * @throws {BadRequestError} 部分分类 id 不存在
 */
export async function syncProblemCategories(
  problemId: string,
  categoryIds: string[],
): Promise<void> {
  const db = getDb();

  // 验证所有分类 ID 都存在
  const existingCatRows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.id, categoryIds));

  if (existingCatRows.length !== categoryIds.length) {
    throw new BadRequestError("部分分类不存在");
  }

  // 先删后插
  await db
    .delete(problemsCategories)
    .where(eq(problemsCategories.problem_id, problemId));

  if (categoryIds.length > 0) {
    await db.insert(problemsCategories).values(
      categoryIds.map((categoryId) => ({
        problem_id: problemId,
        category_id: categoryId,
      })),
    );
  }
}
