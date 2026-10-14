import type { WorkspaceDetail } from './workspace.ts';
import { workspaceNavigation } from './workspace-navigation.ts';

/** 首页只引导到当前导航允许的入口；需要加入的账号仍保留概览中的加入表单。 */
export function workspaceHomepagePath(domain: WorkspaceDetail) {
  if (domain.status === 'suspended' || (domain.actor_id && !domain.is_member && !domain.platform_admin)) return null;
  const section = {
    overview: '',
    community: 'community',
    teaching: 'teaching',
    training: 'trainings',
  }[domain.configuration.homepage];
  if (!section) return null;
  return workspaceNavigation(domain).find((entry) => entry.section === section)?.to ?? null;
}
