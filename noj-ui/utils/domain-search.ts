import type { SearchItem } from './search-types.ts';
import type { DomainProblemReference } from './domain-problems.ts';
import { workspacePath, workspaceProblemPath } from './workspace.ts';
/** 来源信息由搜索接口实时投影，不借旧索引数字猜测使用域本地题号。 */
export function domainSearchReference(item: SearchItem) {
  return item.entity_type === 'problem' ? item.metadata.reference as DomainProblemReference | undefined : undefined;
}
/** 搜索结果定位继续保留请求的使用域。 */
export function domainSearchHref(slug: string, item: SearchItem): string | undefined {
  if (item.entity_type === 'contest') return workspacePath(slug, `contests/${item.entity_id}`);
  if (item.entity_type === 'submission') return workspacePath(slug, `submissions/${item.entity_id}`);
  if (item.entity_type === 'announcement') {
    return workspacePath(slug, `announcements/${item.metadata.public_id || item.entity_id}`);
  }
  const reference = domainSearchReference(item);
  if (reference) return workspaceProblemPath(slug, reference.display_ref);
}
