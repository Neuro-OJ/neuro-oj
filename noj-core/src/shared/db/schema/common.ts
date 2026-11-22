import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector` 列（用于全文搜索）。
 * Drizzle ORM 0.45.x 不导出原生 tsvector 列类型，使用 customType 注册一个。
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * 生成带前缀的 public_id 列（如 `ct-`、`sub-`）。
 * 统一各表的短 ID 默认值写法，避免重复 SQL 片段。
 */
export function publicIdColumn(prefix: string) {
  return text("public_id").notNull().default(
    sql`${sql.raw(`'${prefix}-'`)} || substr(md5(random()::text), 1, 8)`,
  );
}

/**
 * 生成双列复合主键（多对多关联表通用）。
 * 用法：`...manyToManyPk([table.a, table.b])`
 */
export function manyToManyPk<C extends [AnyPgColumn, AnyPgColumn]>(
  columns: C,
) {
  return { pk: primaryKey({ columns }) };
}
