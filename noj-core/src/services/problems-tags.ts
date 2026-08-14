/**
 * Problems ↔ Tags 关联维护（issue #223，取代原 problems-categories.ts）。
 *
 * 只放：
 * - validateProblemTagIds：写库前的标签校验（存在性 + 客观题 kind 规则）
 * - syncProblemTags：先删后插的事务化同步（被 crud / import 复用）
 *
 * 校验规则：
 * - 全部 tag 必须已存在（否则 400）
 * - 客观题（is_objective=true）禁止关联算法标签（客观题系统无「通过」概念）
 *
 * 半写入防护：create/update 路径在写题目行**之前**调用 validateProblemTagIds，
 * 使校验失败（400）不产生孤儿题目或已提交字段（syncProblemTags 内部仍重复校验兜底）。
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problemTags, tags } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";

/**
 * 写库前校验标签集合（去重后）：
 * - 全部存在（否则 400「部分标签不存在」）
 * - 客观题禁止算法标签（否则 400）
 *
 * 返回去重后的标签 id 列表（供 syncProblemTags 使用，避免重复 id 误判/重复插入）。
 */
export async function validateProblemTagIds(
  tagIds: string[],
  isObjective: boolean,
): Promise<string[]> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return [];

  const db = getDb();
  const existingTagRows = await db
    .select({ id: tags.id, kind: tags.kind })
    .from(tags)
    .where(inArray(tags.id, unique));

  if (existingTagRows.length !== unique.length) {
    throw new BadRequestError("部分标签不存在");
  }

  // 客观题禁止算法标签：无「通过」概念，门控无法定义
  if (isObjective && existingTagRows.some((t) => t.kind === "algorithm")) {
    throw new BadRequestError("客观题不能关联算法标签");
  }

  return unique;
}

/**
 * 同步题目的标签关联（先删后插，全量替换语义）。
 * 调用方应先经 validateProblemTagIds 预校验；本函数内部再次校验兜底
 * （校验失败时可能已产生题目行写入——预校验是主要的 400 拦截点）。
 *
 * @param isObjective 客观题套卷标记：true 时拒绝算法标签
 * @throws {BadRequestError} 部分标签 id 不存在，或客观题关联了算法标签
 */
export async function syncProblemTags(
  problemId: string,
  tagIds: string[],
  isObjective = false,
): Promise<void> {
  const db = getDb();

  // 去重 + 校验（失败时抛 400）
  const unique = await validateProblemTagIds(tagIds, isObjective);

  // 先删后插
  await db.delete(problemTags)
    .where(eq(problemTags.problem_id, problemId));

  if (unique.length > 0) {
    await db.insert(problemTags).values(
      unique.map((tagId) => ({
        problem_id: problemId,
        tag_id: tagId,
      })),
    );
  }
}
