/** 无空间前缀的旧业务入口固定属于 main，不读取用户导航偏好。 */
export type DefaultWorkspaceDestination = { path: string; kind?: 'oi' | 'ai' | 'objective' } | {
  problemRef: string;
  editor: boolean;
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
  const fixed: Record<string, string> = {
    '/problems': 'problems',
    '/trainings': 'trainings',
    '/trainings/mine': 'trainings',
    '/contests': 'contests',
    '/submissions': 'submissions',
    '/ranking': 'rankings',
    '/my/problems': 'problem-drafts',
    '/admin/problem-versions': 'problem-bindings',
    '/admin/submission-jobs': 'submissions',
  };
  if (fixed[path]) return { path: `/d/main/${fixed[path]}` };
  if (path === '/problems/new' || path === '/admin/problem-new') return { path: '/d/main/problems/new' };
  const kind = {
    '/problems/new/oi': 'oi',
    '/admin/problem-new-oi': 'oi',
    '/problems/new/coding': 'ai',
    '/problems/new/objective': 'objective',
  } as const;
  if (path in kind) return { path: '/d/main/problems/new', kind: kind[path as keyof typeof kind] };
  const problem = /^\/(?:problems|editor|admin\/problem-edit)\/([^/]+)(\/edit)?\/?$/.exec(path);
  if (problem) {
    let reference: string;
    try {
      reference = decodeURIComponent(problem[1]!);
    } catch {
      return null;
    }
    return {
      problemRef: reference,
      editor: path.startsWith('/admin/problem-edit/') || !!problem[2],
    };
  }
  const resource = /^\/(trainings|contests|submissions)\/(.+)$/.exec(path);
  if (resource?.[1] === 'trainings' && resource[2]?.startsWith('tr-')) return { trainingRef: resource[2] };
  if (resource) return { path: `/d/main/${resource[1]}/${resource[2]}` };
  return null;
}
