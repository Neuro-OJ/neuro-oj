/**
 * SQL 行数组统一访问工具（PR-5 抽取）。
 *
 * 背景：Drizzle 的 `db.execute(sql\`...\`)` 在不同 driver 下返回结构不同：
 * - **postgres.js**：返回 `RowList<Row[]>`（含 affectedRows 等字段，类 array-like）
 * - **PGlite**：返回 `{ rows: Record<string, unknown>[], ... }` 对象
 *
 * 严格说两者都不完全匹配签名 `T[] | { rows: T[] }`，所以 PR-5 抽取后
 * 调用方仍需 `as never` 在两种 driver 间二选一。本 helper 接受这个语义漂移
 * （Drizzle 双 driver 静态类型无法统一），通过 `as never` 把"我知道这里
 * 不安全但动态判断已做"的意图传达给后续 reviewer。
 *
 * 原代码每处都重复 `"rows" in result ? result.rows : result as unknown as ...` 模式，
 * 既冗长又容易出错。集中到本模块，避免后续 SQL 调用反复引入 `as unknown as`。
 *
 * ## 已知局限
 *
 * - postgres.js 实际返回 `RowList<Row[]>` 包含 `affectedRows` / `count` 等元数据字段
 *   （不在 `T[]` 签名内）。`as never` 把"我们知道这不是真 T[]"的意图显式化
 * - PGlite 与 postgres.js 的具体返回类型由 Drizzle 内部推断，跨版本可能变化
 * - 真正"完全类型安全"的方案需要 Drizzle 官方支持泛型 RowList<T>，目前没有
 *
 * 如果未来 Drizzle 提供稳定的 `db.execute<T>(sql): Promise<RowList<T>>` API，
 * 可删除本 helper。
 */

import { logger } from "./logging.ts";

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
  // PR-5 评审修订：fallback 不再静默返空数组
  // 真实场景：程序员误传 null / 错误结构 / 拼写错误 → "为什么榜单空了"难定位
  // 改为 console.warn + 返空，至少让监控可见
  logger.warn("unwrapRows 未知 result 形态，返空数组", {
    type: typeof result,
    shape: result && typeof result === "object" && "rows" in result
      ? "hasRowsKey"
      : "noRowsKey",
  });
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
