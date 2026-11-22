/**
 * SQL 行数组统一访问工具（PR-5 抽取）。
 *
 * 背景：Drizzle 的 `db.execute(sql\`...\`)` 返回 postgres.js 的 RowList。
 * RowList 是带少量元数据的数组，因此运行时按数组读取即可；调用方仍可能
 * 需要 `as never` 绕过 Drizzle 当前版本的 RowList 泛型限制。
 *
 * 原代码每处都重复 `"rows" in result ? result.rows : result as unknown as ...` 模式，
 * 既冗长又容易出错。集中到本模块，避免后续 SQL 调用反复引入 `as unknown as`。
 *
 * postgres.js 实际返回 `RowList<Row[]>` 包含 `affectedRows` / `count` 等元数据字段
 * （不在 `T[]` 签名内）。`as never` 把"我们知道这不是真 T[]"的意图显式化。
 *
 * 如果未来 Drizzle 提供稳定的 `db.execute<T>(sql): Promise<RowList<T>>` API，
 * 可删除本 helper。
 */

/**
 * 解包 db.execute(sql\`...\`) 的返回值为行数组。
 *
 * postgres.js 的 RowList 在运行时就是数组，统一返回 `T[]`。
 *
 * @example
 * ```ts
 * const result = await db.execute(sql`SELECT * FROM users`);
 * const rows = unwrapRows<{ id: string }>(result);
 * for (const row of rows) console.log(row.id);
 * ```
 */
export function unwrapRows<T>(result: T[]): T[] {
  return result;
}

/**
 * 解包 db.execute(sql\`...\`) 的返回值，取第一行。
 *
 * 等价于 `unwrapRows(result)[0]`，但命名更明确。
 * 无行时返回 undefined（不抛错，与原代码的 `rows[0]?.field ?? default` 模式一致）。
 */
export function unwrapFirstRow<T>(
  result: T[],
): T | undefined {
  return unwrapRows(result)[0];
}

/**
 * Drizzle SELECT 子句中嵌入的 PostgreSQL `count(*)` 可能返回 string 或 number。
 * 本函数统一转为 number。
 *
 * @example
 * ```ts
 * const [row] = await db.select({ total: sql<number>\`count(*)\` }).from(...);
 * const total = countToNumber(row?.total);
 * ```
 */
export function countToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}
