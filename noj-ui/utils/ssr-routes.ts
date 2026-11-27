/**
 * 客户端渲染（`ssr: false`）路由的单一事实来源。
 *
 * 所有关闭 SSR 的页面路径必须登记在此，由 `nuxt.config.ts` 合并进 `routeRules`；
 * 内容页与 SEO 页保持 SSR，禁止在页面 `definePageMeta` 中零散声明 `ssr: false`。
 */
export const CLIENT_ONLY_ROUTES = [
  '/admin',
  '/admin/**',
  '/community/notifications',
  '/community/notifications/*',
  '/community/reports/*',
  '/d/*/classrooms/*/contest-remediation',
  '/d/*/community/manage',
  '/d/*/community/notifications',
  '/d/*/community/notifications/*',
  '/d/*/community/reports/*',
  '/d/*/contests/*/solve/*',
  '/d/*/editor/**',
  '/d/*/members',
  '/d/*/problem-bindings',
  '/d/*/problems/new',
  '/d/*/queue',
  '/d/*/settings',
  '/d/*/settings/announcements',
  '/d/*/settings/community',
  '/d/*/solve/*',
  '/d/*/submission-jobs/**',
  '/d/*/trainings/*/edit',
  '/d/*/trainings/new',
  '/join',
  '/my/submissions/**',
  '/settings',
] as const;

/** 将 `CLIENT_ONLY_ROUTES` 的 `ssr: false` 无损叠加到基础 `routeRules` 上，保留各自的响应头等配置。 */
export function withClientOnlyRouteRules<T extends Record<string, Record<string, unknown>>>(
  baseRules: T,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const path of CLIENT_ONLY_ROUTES) {
    merged[path] = { ssr: false };
  }
  for (const [path, rule] of Object.entries(baseRules)) {
    merged[path] = merged[path] ? { ...merged[path], ...rule } : { ...rule };
  }
  return merged;
}
