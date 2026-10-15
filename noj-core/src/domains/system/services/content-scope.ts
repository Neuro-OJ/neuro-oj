import { eq, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** 由域入口授权后传入；未提供时服务只操作实例内容。 */
export interface ContentScope {
  domainId: string;
}

/** 管理操作精确匹配归属，域公开读取才合并实例内容。 */
export function contentScopeWhere(
  column: AnyPgColumn,
  scope?: ContentScope,
  includeInstance = false,
) {
  if (!scope) return isNull(column);
  const own = eq(column, scope.domainId);
  return includeInstance ? or(isNull(column), own)! : own;
}

/** 用于列表来源标签，不让前端根据当前域猜测归属。 */
export function contentSource(domainId: string | null) {
  return domainId === null ? "instance" as const : "domain" as const;
}
