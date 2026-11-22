/**
 * 无空间前缀的旧业务入口固定属于 main，不读取用户导航偏好。
 *
 * 这是旧 URL 重定向的唯一规则表：由全局中间件 `default-workspace.global.ts`
 * 在页面 setup 前执行；`pages/[...legacy].vue` 只为旧路径提供可匹配的路由，
 * 规则之外的路径一律 404。静态路径段不区分大小写（与原 Vue Router 页面一致），
 * ID、引用与查询参数保持原样。
 *
 * 全站排行榜（含签到榜）在 `/leaderboard`：v0.11.0 曾把 `/ranking` 301 到域排行榜，
 * 浏览器会缓存该 301，所以换新地址；未缓存的 `/ranking` 仍转到 `/leaderboard`。
 */
export type DefaultWorkspaceDestination = {
  path: string;
  kind?: 'oi' | 'ai' | 'objective';
  query?: Record<string, string>;
} | {
  problemRef: string;
  editor: boolean;
  solve?: boolean;
} | { trainingRef: string };
export function defaultProblemReference(value: string) {
  const number = /^(?:P)?([1-9]\d*)$/.exec(value)?.[1];
  if (number && Number(number) <= 2147483647) return String(Number(number));
  return /^[a-z][a-z0-9-]{0,47}:[1-9]\d*$/.test(value) ? value : null;
}
export function defaultProblemLabel(value: string) {
  return /^(?:P)([1-9]\d*)$/.exec(value)?.[1] ?? value;
}
export function defaultWorkspaceDestination(path: string): DefaultWorkspaceDestination | null {
  path = path.replace(/\/+$/, '') || '/';
  const lower = path.toLowerCase();
  if (lower === '/ranking') return { path: '/leaderboard' };
  const fixed: Record<string, string> = {
    '/problems': 'problems',
    '/trainings': 'trainings',
    '/trainings/mine': 'trainings',
    '/contests': 'contests',
    '/submissions': 'submissions',
    '/my/submissions': 'submissions',
    '/search': 'search',
    '/queue': 'queue',
    '/community': 'community',
    '/my/problems': 'problem-drafts',
    '/admin/problems': 'problem-bindings',
    '/admin/contests': 'contests',
    '/admin/trainings': 'trainings',
    '/admin/submissions': 'submissions',
    '/admin/problem-import': 'problems/new',
    '/admin/problem-versions': 'problem-bindings',
    '/admin/submission-jobs': 'submissions',
    '/admin/llm/providers': 'llm',
    '/admin/llm/usage': 'llm',
  };
  if (fixed[lower]) return { path: `/d/main/${fixed[lower]}` };
  if (lower === '/problems/new' || lower === '/admin/problem-new') return { path: '/d/main/problems/new' };
  if (lower === '/problems/new/bundle') return { path: '/d/main/problems/new', query: { import: '1' } };
  const kind = {
    '/problems/new/oi': 'oi',
    '/admin/problem-new-oi': 'oi',
    '/problems/new/coding': 'ai',
    '/problems/new/objective': 'objective',
  } as const;
  if (lower in kind) return { path: '/d/main/problems/new', kind: kind[lower as keyof typeof kind] };
  const problem = /^\/(?:problems|editor|admin\/problem-edit)\/([^/]+)(\/edit)?\/?$/i.exec(path);
  if (problem) {
    let reference: string;
    try {
      reference = decodeURIComponent(problem[1]!);
    } catch {
      return null;
    }
    return {
      problemRef: reference,
      editor: lower.startsWith('/admin/problem-edit/') || !!problem[2],
      ...(lower.startsWith('/editor/') ? { solve: true } : {}),
    };
  }
  const resource = /^\/(trainings|contests|submissions)\/(.+)$/i.exec(path);
  const post = /^\/community\/posts\/([^/]+)$/i.exec(path);
  if (post) return { path: `/d/main/community/posts/${post[1]}` };
  const kindOf = resource?.[1]?.toLowerCase();
  if (kindOf === 'trainings' && resource![2]?.startsWith('tr-')) return { trainingRef: resource![2] };
  if (resource) return { path: `/d/main/${kindOf}/${resource[2]}` };
  return null;
}
