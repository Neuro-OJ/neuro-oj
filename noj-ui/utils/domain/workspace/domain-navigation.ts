import type { WorkspaceSummary } from './workspace.ts';

/** 根入口选择导航目标；明确的业务 URL 不使用此规则。 */
export function initialDomainSlug(
  policy: { access: 'public' | 'authenticated'; default_domain_slug: string },
  available: WorkspaceSummary[],
) {
  return policy.access === 'authenticated' && available.length === 1 ? available[0]!.slug : policy.default_domain_slug;
}

/** 当前域和统一账号一起显示，不另设常驻域切换区域。 */
export function domainIdentityLabel(username: string, slug: string) {
  return `${username}@${slug}`;
}
