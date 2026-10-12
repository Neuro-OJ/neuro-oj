/**
 * 数据库执行器类型（根连接或事务句柄）。
 *
 * 写入服务普遍需要「既可独立调用、也可参与调用方事务」：
 * ```ts
 * export async function doWrite(input: X, executor?: Executor) {
 *   const db = executor ?? getDb();
 *   ...
 * }
 * ```
 * 手写 `Parameters<...>` 推导会散落各处且容易写错，故集中在此。
 */

import type { getDb } from "./connection.ts";

/** 支持开启事务的根连接（`getDb()` 返回值）。 */
export type RootDb = ReturnType<typeof getDb>;

/** drizzle 事务句柄。 */
export type Tx = Parameters<Parameters<RootDb["transaction"]>[0]>[0];

/** 根连接或事务句柄。 */
export type Executor = RootDb | Tx;
