import type { WorkspaceDetail } from './workspace.ts';
import { workspacePath } from './workspace.ts';

/** 设置导航按当前域能力组合，实例账号设置不放入域管理。 */
export function workspaceSettingsNavigation(domain: WorkspaceDetail) {
  const can = (permission: string) => domain.platform_admin || domain.permissions.includes(permission);
  const base = workspacePath(domain.slug, 'settings');
  return [
    ...(can('domain:settings')
      ? [
        { label: '基本设置', to: base, icon: 'i-lucide-settings' },
        { label: '访问与加入', to: base + '#access', icon: 'i-lucide-door-open' },
        { label: '轮播管理', to: base + '/carousel', icon: 'i-lucide-gallery-horizontal' },
        { label: '公告管理', to: base + '/announcements', icon: 'i-lucide-megaphone' },
      ]
      : []),
    ...(can('domain:members')
      ? [{ label: '成员与邀请', to: workspacePath(domain.slug, 'members'), icon: 'i-lucide-users' }]
      : []),
    ...(can('domain:limits') ? [{ label: '资源额度', to: base + '#limits', icon: 'i-lucide-gauge' }] : []),
    ...(can('llm:manage') ? [{ label: 'LLM 配置', to: workspacePath(domain.slug, 'llm'), icon: 'i-lucide-bot' }] : []),
    ...(domain.configuration.features.community && can('community:moderate')
      ? [{ label: '社区管理', to: workspacePath(domain.slug, 'community/manage'), icon: 'i-lucide-messages-square' }]
      : []),
  ];
}
