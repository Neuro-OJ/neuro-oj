import type { WorkspaceDetail } from './workspace.ts';
import { workspacePath } from './workspace.ts';

/** 导航只表达可进入的功能入口，具体资源和班级授权仍由接口决定。 */
export function workspaceNavigation(domain: WorkspaceDetail) {
  const signedIn = domain.actor_id !== null;
  const features = domain.configuration.features;
  const entries = [
    { label: '首页', section: '', icon: 'i-lucide-home' },
    { label: '题库', section: 'problems', icon: 'i-lucide-book-open' },
    { label: '题单', section: 'trainings', icon: 'i-lucide-list-ordered' },
    { label: '比赛', section: 'contests', icon: 'i-lucide-trophy' },
    ...(features.community ? [{ label: '社区', section: 'community', icon: 'i-lucide-messages-square' }] : []),
    ...(features.analytics
      ? [{ label: '排行榜', section: 'rankings', icon: 'i-lucide-chart-no-axes-column-increasing' }]
      : []),
    { label: '搜索', section: 'search', icon: 'i-lucide-search' },
  ];
  if (signedIn) {
    entries.push({ label: '提交', section: 'submissions', icon: 'i-lucide-code-2' });
    entries.push({ label: '评测队列', section: 'queue', icon: 'i-lucide-activity' });
  }
  if (signedIn && features.classroom) {
    entries.push({ label: '班级研练', section: 'classrooms', icon: 'i-lucide-graduation-cap' });
  }
  return entries.map((entry) => ({ ...entry, to: workspacePath(domain.slug, entry.section) }));
}
