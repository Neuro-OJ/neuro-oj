import { bigint, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * 查询投影 revision 表（Handbook §3.5）——归 query 域所有。
 *
 * 每个作用域一行：`global`、`problem:<id>`、`contest:<id>`。
 * - `data_revision`：判定替换与策略切换在业务事务中递增，是缓存键的一部分；
 * - `materialized_revision`：用户榜单物化视图（或等价投影）覆盖到的 revision。
 *
 * 读路径据此判断视图是否落后：落后时使用内联查询路径，不能把旧视图标为最新。
 */
export const queryProjectionRevisions = pgTable(
  "query_projection_revisions",
  {
    /** 作用域键，例如 `global` / `problem:<uuid>` / `contest:<uuid>`。 */
    scope_key: text("scope_key").primaryKey(),
    data_revision: bigint("data_revision", { mode: "number" }).notNull()
      .default(0),
    materialized_revision: bigint("materialized_revision", { mode: "number" })
      .notNull().default(0),
  },
  (table) => ({
    /** data_revision 单调不回退；物化 revision 不得超过数据 revision。 */
    revisionCheck: check(
      "query_projection_revisions_revision_check",
      sql`${table.data_revision} >= 0 AND ${table.materialized_revision} >= 0 AND ${table.materialized_revision} <= ${table.data_revision}`,
    ),
    /** 刷新扫描：按 data_revision 降序找落后作用域。 */
    laggingIdx: index("idx_query_projection_revisions_lagging").on(
      table.data_revision,
      table.materialized_revision,
    ),
  }),
);
