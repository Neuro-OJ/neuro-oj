import { errorInfo } from './api.ts';
import { isProtectedRoute, problemEndpoint, problemQuery, submissionsQuery } from './routes.ts';
import type { Bootstrap, User } from './types.ts';

export type ServerGet = <T>(url: string, options?: { timeout?: number }) => Promise<T>;

/** SSR 只加载当前路由需要的数据；所有状态只属于这一次请求。 */
export async function loadBootstrap(url: string, hasSession: boolean, get: ServerGet): Promise<Bootstrap> {
  const parsed = new URL(url, 'http://noj.internal');
  const path = parsed.pathname.replace(/^\/react(?=\/|$)/, '') || '/';
  const result: Bootstrap = { url, user: null, resources: {} };
  if (hasSession) {
    try {
      result.user = (await get<{ data: User }>('/api/v1/auth/me', { timeout: 5000 })).data;
    } catch (error) {
      const info = errorInfo(error);
      if (info.status !== 401) result.authError = info;
    }
  }
  if (isProtectedRoute(path) && !result.user) return result;

  const endpoints: string[] = [];
  if (path === '/' || path === '/problems' || path === '/problems/') {
    endpoints.push(path === '/' ? '/api/v1/problems?page=1&limit=6' : problemQuery(parsed.search));
  }
  if (path === '/') {
    endpoints.push(
      '/api/v1/carousel/slides',
      '/api/v1/announcements?per_page=10',
      result.user ? '/api/v1/submissions?per_page=10' : '/api/v1/submissions/public/recent?per_page=10',
    );
  }
  const problem = /^\/(?:problems|editor)\/([^/]+)\/?$/.exec(path);
  if (problem) endpoints.push(problemEndpoint(decodeURIComponent(problem[1]!), parsed.search));
  if (path === '/submissions' || path === '/submissions/') endpoints.push(submissionsQuery(parsed.search));
  const submission = /^\/submissions\/([^/]+)\/?$/.exec(path);
  if (submission) endpoints.push(`/api/v1/submissions/${encodeURIComponent(decodeURIComponent(submission[1]!))}`);

  await Promise.all(endpoints.map(async (endpoint) => {
    try {
      result.resources[endpoint] = { data: await get(endpoint, { timeout: 8000 }) };
    } catch (error) {
      const info = errorInfo(error);
      result.resources[endpoint] = { error: info };
      if (info.status === 404 && (problem || submission)) result.status = 404;
    }
  }));
  return result;
}
