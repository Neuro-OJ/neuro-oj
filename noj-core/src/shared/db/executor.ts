/**
 * 数据库边界类型。
 *
 * `DbRoot` 只属于应用编排层：它可以开启事务。`DbTx` 是真实
 * Drizzle `transaction` callback 收到的句柄，只能由外层事务传给原子
 * helper。两者故意从项目实际 `getDb()` 类型推导，不能用一个手写的
 * "看起来像数据库" interface 伪造事务。
 *
 * 迁移期间保留 `RootDb`、`Tx`、`Executor` 作为兼容别名。新生产代码禁止
 * 导入 `Executor`；锁、审计/事件登记、配额、投影和多表写入必须使用必填
 * `DbTx`。这些别名将在 P3 收尾时删除。
 */

import type { getDb } from "./connection.ts";

/** 支持开启事务的根连接（`getDb()` 返回值）。 */
export type DbRoot = ReturnType<typeof getDb>;

/** drizzle 事务句柄。 */
export type DbTx = Parameters<Parameters<DbRoot["transaction"]>[0]>[0];

/**
 * @deprecated 仅供尚未迁移的旧域使用。原子 helper 不得接受这个联合类型。
 * 请在应用层使用 `DbRoot.transaction((tx) => fooTx(tx, ...))`。
 */
export type Executor = DbRoot | DbTx;

/** @deprecated 使用 `DbRoot`。 */
export type RootDb = DbRoot;

/** @deprecated 使用 `DbTx`。 */
export type Tx = DbTx;
