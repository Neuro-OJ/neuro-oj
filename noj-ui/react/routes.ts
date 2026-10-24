export const REACT_BASE = '/react';

/** 迁移期间只有这些路径归 React 所有，其余入口完整导航到现有前端。 */
export function isReactRoute(path: string): boolean {
  return /^\/(?:login|problems(?:\/[^/]+)?|editor\/[^/]+|submissions(?:\/[^/]+)?)?\/?$/.test(path);
}

export function isProtectedRoute(path: string): boolean {
  return path.startsWith('/editor/') || path === '/submissions' || path === '/submissions/';
}

/** 登录回跳只能落在同源绝对路径，禁止协议相对地址、反斜线与控制字符。 */
export function safeRedirect(value: string | null, fallback = '/react'): string {
  if (
    !value || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) return fallback;
  return value;
}

export function problemQuery(search: string, home = false): string {
  const incoming = new URLSearchParams(search);
  const result = new URLSearchParams({
    page: String(positiveInteger(incoming.get('page'))),
    limit: home ? '5' : '20',
  });
  for (const key of ['keyword', 'difficulty', 'judge_type', 'judge_backend', 'tag', 'type', 'number']) {
    const value = incoming.get(key);
    if (value) result.set(key, value);
  }
  return `/api/v1/problems?${result}`;
}

export function submissionsQuery(search: string): string {
  const incoming = new URLSearchParams(search);
  const result = new URLSearchParams({ page: String(positiveInteger(incoming.get('page'))), per_page: '20' });
  for (
    const key of ['problem_id', 'problem_search', 'submission_id', 'language', 'status', 'version_origin', 'valid_only']
  ) {
    const value = incoming.get(key);
    if (value) result.set(key, value);
  }
  return `/api/v1/submissions?${result}`;
}

export function positiveInteger(value: string | null): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

export function problemEndpoint(id: string, search: string): string {
  const version = new URLSearchParams(search).get('version_id');
  return `/api/v1/problems/${encodeURIComponent(id)}${version ? `?version_id=${encodeURIComponent(version)}` : ''}`;
}

/** 草稿按账号、题目、作答版本和语言隔离，避免历史版/切换账号互相覆盖。 */
export function draftKey(userId: string, problemId: string, versionId: string, language: string): string {
  return `noj:react:draft:${userId}:${problemId}:${versionId}:${language}`;
}

export function isTerminal(status: string): boolean {
  return ['finished', 'error', 'cancelled', 'canceled'].includes(status);
}
