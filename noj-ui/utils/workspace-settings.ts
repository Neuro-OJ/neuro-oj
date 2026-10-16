import type { WorkspaceDetail } from './workspace.ts';
import { workspacePath } from './workspace.ts';

/** 设置导航按当前域能力组合，实例账号设置不放入域管理。 */
export function workspaceSettingsNavigation(domain: WorkspaceDetail) {
  const can = (permission: string) => domain.platform_admin || domain.permissions.includes(permission);
  const base = workspacePath(domain.slug, 'settings');
  return [
    ...(can('domain:settings')
      ? [
        { label: '基本信息', to: base, icon: 'i-lucide-settings' },
        { label: '访问与加入', to: base + '/access', icon: 'i-lucide-door-open' },
      ]
      : []),
    ...(can('domain:members') ? [{ label: '成员管理', to: base + '/members', icon: 'i-lucide-users' }] : []),
    ...(can('domain:invitations') ? [{ label: '邀请管理', to: base + '/invitations', icon: 'i-lucide-mail' }] : []),
    ...(can('domain:limits') ? [{ label: '资源额度', to: base + '/limits', icon: 'i-lucide-gauge' }] : []),
    ...(can('domain:settings')
      ? [
        { label: '轮播管理', to: base + '/carousel', icon: 'i-lucide-gallery-horizontal' },
        { label: '公告管理', to: base + '/announcements', icon: 'i-lucide-megaphone' },
      ]
      : []),
    ...(can('llm:manage')
      ? [
        { label: 'LLM Provider', to: base + '/llm', icon: 'i-lucide-bot' },
        { label: 'LLM 额度', to: base + '/llm/quotas', icon: 'i-lucide-sliders-horizontal' },
        { label: 'LLM 用量', to: base + '/llm/usage', icon: 'i-lucide-bar-chart-3' },
      ]
      : []),
    ...(domain.configuration.features.community && can('community:moderate')
      ? [{ label: '社区设置', to: base + '/community', icon: 'i-lucide-messages-square' }]
      : []),
    ...(can('domain:transfer') || can('domain:archive') || domain.platform_admin
      ? [{ label: '交接与归档', to: base + '/management', icon: 'i-lucide-shield-alert' }]
      : []),
  ];
}
