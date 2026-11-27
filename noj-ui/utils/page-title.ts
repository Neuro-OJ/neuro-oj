const SITE_NAME = 'Neuro OJ';

interface TitleRule {
  match: string;
  key?: string;
  label?: string;
}

const ROOT_TITLE_RULES: TitleRule[] = [
  { match: '/login', key: 'auth.login' },
  { match: '/register', key: 'auth.register' },
  { match: '/forgot-password', label: '找回密码' },
  { match: '/reset-password', label: '重置密码' },
  { match: '/change-password', label: '修改密码' },
  { match: '/set-password', label: '设置密码' },
  { match: '/verify-email', key: 'verify.title' },
  { match: '/settings', label: '账号设置' },
  { match: '/workspaces', key: 'breadcrumb.workspaces' },
  { match: '/join', key: 'breadcrumb.invitation' },
  { match: '/my/submissions', key: 'breadcrumb.mySubmissions' },
  { match: '/users', label: '用户主页' },
  { match: '/problems', key: 'problem.title' },
  { match: '/submissions', key: 'submission.title' },
  { match: '/contests', key: 'contest.title' },
  { match: '/community', key: 'nav.community' },
  { match: '/announcements', key: 'nav.announcements' },
  { match: '/notifications', key: 'breadcrumb.notifications' },
  { match: '/leaderboard', key: 'nav.ranking' },
  { match: '/about', key: 'nav.about' },
  { match: '/data-policy', key: 'breadcrumb.dataPolicy' },
  { match: '/legal/privacy', key: 'breadcrumb.privacyPolicy' },
  { match: '/legal/terms', key: 'breadcrumb.termsOfService' },
  { match: '/', key: 'nav.home' },
];

const WORKSPACE_SECTION_TITLES: Record<string, { key?: string; label?: string }> = {
  problems: { key: 'problem.title' },
  solve: { label: '在线作答' },
  editor: { label: '题目编辑器' },
  'problem-drafts': { key: 'breadcrumb.problemDrafts' },
  'problem-bindings': { label: '题目绑定' },
  submissions: { key: 'submission.title' },
  'objective-submissions': { key: 'breadcrumb.objectiveHistory' },
  'submission-jobs': { key: 'breadcrumb.submissionJob' },
  'self-tests': { key: 'breadcrumb.selfTest' },
  queue: { key: 'nav.queue' },
  contests: { key: 'contest.title' },
  trainings: { key: 'nav.trainings' },
  classrooms: { key: 'breadcrumb.classrooms' },
  assignments: { label: '作业' },
  community: { key: 'nav.community' },
  announcements: { key: 'nav.announcements' },
  notifications: { key: 'breadcrumb.notifications' },
  rankings: { key: 'nav.ranking' },
  search: { key: 'nav.search' },
  knowledge: { key: 'breadcrumb.knowledgeMastery' },
  llm: { key: 'breadcrumb.llm' },
  members: { key: 'breadcrumb.members' },
  settings: { key: 'breadcrumb.settings' },
};

const ADMIN_SECTION_TITLES: Record<string, string> = {
  users: '用户管理',
  settings: '系统设置',
  'audit-logs': '审计日志',
  community: '社区管理',
  reports: '举报处理',
  announcements: '公告管理',
  blacklist: 'IP 黑名单',
  'judge-images': '评测镜像',
  tags: '标签管理',
  knowledge: '知识图谱管理',
  legal: '合规与隐私',
  instance: '实例治理',
  llm: 'LLM 额度管理',
};

function normalizePath(rawPath: string): string {
  const withoutQuery = rawPath.split(/[?#]/, 1)[0] ?? '/';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery || '/';
}

function formatRuleTitle(rule: { key?: string; label?: string }, t: (key: string) => string): string {
  const text = rule.label ?? (rule.key ? t(rule.key) : '');
  return text ? `${text} - ${SITE_NAME}` : SITE_NAME;
}

/**
 * 按路由路径生成描述性页面兜底 `<title>`（WCAG 2.4.2）。
 *
 * 页面自身若调用 `useHead`/`useSeoMeta` 会自动覆盖此兜底值；
 * 覆盖顶层页面、`/d/:slug/*` 多域空间与 `/admin/*` 管理后台，避免未显式声明标题的页面退化为统一站点名。
 */
export function resolvePageTitle(rawPath: string, t: (key: string) => string): string {
  const path = normalizePath(rawPath);

  // 1. 多域工作空间：/d/:slug/...
  if (path.startsWith('/d/')) {
    const segments = path.split('/').filter(Boolean); // ['d', slug, section?, ...]
    const section = segments[2];
    if (!section) return `${t('nav.home')} - ${SITE_NAME}`;
    const mapped = WORKSPACE_SECTION_TITLES[section];
    return mapped ? formatRuleTitle(mapped, t) : SITE_NAME;
  }

  // 2. 实例管理后台：/admin/...
  if (path === '/admin' || path.startsWith('/admin/')) {
    const segments = path.split('/').filter(Boolean); // ['admin', section?, ...]
    const section = segments[1];
    if (!section) return `管理后台 - ${SITE_NAME}`;
    const label = ADMIN_SECTION_TITLES[section];
    return label ? `${label} - 管理后台 - ${SITE_NAME}` : `管理后台 - ${SITE_NAME}`;
  }

  // 3. 顶层页面：精确匹配优先，其次前缀匹配
  const exact = ROOT_TITLE_RULES.find((r) => r.match === path);
  if (exact) return formatRuleTitle(exact, t);
  const byPrefix = ROOT_TITLE_RULES.find((r) =>
    r.match !== '/' && (path === r.match || path.startsWith(`${r.match}/`))
  );
  return byPrefix ? formatRuleTitle(byPrefix, t) : SITE_NAME;
}
