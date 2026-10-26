import { workspacePath } from './workspace.ts';

/** null 表示账号通知/私信举报；内容社区始终有明确使用域。 */
export function communityApiPath(slug: string | null, suffix = '') {
  const root = slug === null ? '/api/v1/community' : `/api/v1/domains/${encodeURIComponent(slug)}/community`;
  return suffix ? `${root}/${suffix}` : root;
}

export function communityPath(slug: string | null, suffix = '') {
  const root = slug === null ? '/community' : workspacePath(slug, 'community');
  return suffix ? `${root}/${suffix}` : root;
}

export function communityScopeKey(slug: string | null, actorId: string | null) {
  return `community:${slug ?? 'account'}:${actorId ?? 'guest'}`;
}
