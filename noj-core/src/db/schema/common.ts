import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector` 列（用于全文搜索）。
 * Drizzle ORM 0.45.x 不导出原生 tsvector 列类型，使用 customType 注册一个。
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
