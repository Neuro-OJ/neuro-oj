import type { WorkspaceDetail } from './workspace.ts';
import { workspacePath } from './workspace.ts';

export interface WorkspaceSettingsNavItem {
  label: string;
  to: string;
  icon: string;
  group: '基础政策' | '成员' | '内容' | '模型与额度' | '治理';
}

/** 设置导航按当前域能力组合，保留平级 entries 接口，附带任务 group 元数据供清晰分组展示。 */
export function workspaceSettingsNavigation(domain: WorkspaceDetail): WorkspaceSettingsNavItem[] {
  const can = (permission: string) => domain.platform_admin || domain.permissions.includes(permission);
  const base = workspacePath(domain.slug, 'settings');
  return [
    ...(can('domain:settings')
      ? [
        { label: '基本信息', to: base, icon: 'i-lucide-settings', group: '基础政策' as const },
        { label: '访问与加入', to: base + '/access', icon: 'i-lucide-door-open', group: '基础政策' as const },
      ]
      : []),
    ...(can('domain:members')
      ? [{ label: '成员管理', to: base + '/members', icon: 'i-lucide-users', group: '成员' as const }]
      : []),
    ...(can('domain:invitations')
      ? [{ label: '邀请管理', to: base + '/invitations', icon: 'i-lucide-mail', group: '成员' as const }]
      : []),
    ...(can('domain:limits')
      ? [{ label: '资源额度', to: base + '/limits', icon: 'i-lucide-gauge', group: '模型与额度' as const }]
      : []),
    ...(can('domain:settings')
      ? [
        { label: '轮播管理', to: base + '/carousel', icon: 'i-lucide-gallery-horizontal', group: '内容' as const },
        { label: '公告管理', to: base + '/announcements', icon: 'i-lucide-megaphone', group: '内容' as const },
      ]
      : []),
    ...(can('llm:manage')
      ? [
        { label: 'LLM Provider', to: base + '/llm', icon: 'i-lucide-bot', group: '模型与额度' as const },
        {
          label: 'LLM 额度',
          to: base + '/llm/quotas',
          icon: 'i-lucide-sliders-horizontal',
          group: '模型与额度' as const,
        },
        { label: 'LLM 用量', to: base + '/llm/usage', icon: 'i-lucide-bar-chart-3', group: '模型与额度' as const },
      ]
      : []),
    ...(domain.configuration.features.community && can('community:moderate')
      ? [{ label: '社区设置', to: base + '/community', icon: 'i-lucide-messages-square', group: '内容' as const }]
      : []),
    ...(can('domain:transfer') || can('domain:archive') || domain.platform_admin
      ? [{ label: '交接与归档', to: base + '/management', icon: 'i-lucide-shield-alert', group: '治理' as const }]
      : []),
  ];
}
