import type { WorkspaceDetail } from './workspace';
import { workspacePath } from './workspace';

/** 导航只表达可进入的功能入口，具体资源和班级授权仍由接口决定。 */
export function workspaceNavigation(domain: WorkspaceDetail) {
  const signedIn = domain.actor_id !== null;
  const can = (permission: string) => domain.permissions.includes(permission);
  const features = domain.configuration.features;
  const entries = [
    { label: '概览', section: '', icon: 'i-lucide-building-2' },
    { label: '题库', section: 'problems', icon: 'i-lucide-book-open' },
    { label: '比赛', section: 'contests', icon: 'i-lucide-trophy' },
  ];
  if (signedIn) entries.push({ label: '我的提交', section: 'submissions', icon: 'i-lucide-code-2' });
  if (signedIn && features.classroom) {
    entries.push({ label: '班级', section: 'classrooms', icon: 'i-lucide-users' });
    if (features.assignment) {
      entries.push({ label: '我的学习', section: 'my-learning', icon: 'i-lucide-graduation-cap' });
      if (can('classroom:create') || can('classroom:manage_any')) {
        entries.push({ label: '教学工作台', section: 'teaching', icon: 'i-lucide-presentation' });
      }
    }
  }
  if (can('llm:manage')) entries.push({ label: 'LLM', section: 'llm', icon: 'i-lucide-bot' });
  if (can('domain:members')) entries.push({ label: '成员', section: 'members', icon: 'i-lucide-user-round-cog' });
  if (can('domain:settings')) entries.push({ label: '设置', section: 'settings', icon: 'i-lucide-settings' });
  return entries.map((entry) => ({ ...entry, to: workspacePath(domain.slug, entry.section) }));
}
