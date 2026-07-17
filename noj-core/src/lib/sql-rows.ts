/**
 * SQL 行数组统一访问工具（PR-5 抽取）。
 *
 * 背景：Drizzle 的 `db.execute(sql\`...\`)` 在不同 driver 下返回结构不同：
 * - **postgres.js**：返回 array-like（Record<string, unknown>[]），可直接 .map()、.length
 * - **PGlite**：返回 `{ rows: Record<string, unknown>[], ... }` 对象
 *
 * 原代码每处都重复 `"rows" in result ? result.rows : result as unknown as ...` 模式，
 * 既冗长又容易出错。集中到本模块，避免后续 SQL 调用反复引入 `as unknown as`。
 */

/**
 * 解包 db.execute(sql\`...\`) 的返回值为行数组。
 *
 * 自动识别 PGlite 的 `{ rows: T[] }` 形态与 postgres.js 的 array-like 形态，
 * 统一返回 `T[]`。
 *
 * @example
 * ```ts
 * const result = await db.execute(sql`SELECT * FROM users`);
 * const rows = unwrapRows<{ id: string }>(result);
 * for (const row of rows) console.log(row.id);
 * ```
 */
export function unwrapRows<T>(result: T[] | { rows: T[] }): T[] {
  if (Array.isArray(result)) return result;
  if (
    result && typeof result === "object" && "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  // 防御性 fallback：未知形态视为空（调用方可处理 0 行场景）
  return [];
}

/**
 * 解包 db.execute(sql\`...\`) 的返回值，取第一行。
 *
 * 等价于 `unwrapRows(result)[0]`，但命名更明确。
 * 无行时返回 undefined（不抛错，与原代码的 `rows[0]?.field ?? default` 模式一致）。
 */
export function unwrapFirstRow<T>(
  result: T[] | { rows: T[] },
): T | undefined {
  return unwrapRows(result)[0];
}

/**
 * Drizzle SELECT 子句中嵌入的 PostgreSQL `count(*)` 返回 string（PGlite）
 * 或 number（postgres.js）。本函数统一转为 number。
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
