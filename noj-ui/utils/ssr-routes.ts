/** 仅包含既有客户端页面；内容页保持 SSR。 */
export const CLIENT_ONLY_ROUTES = [
  '/admin',
  '/admin/**',
  '/community/notifications',
  '/community/notifications/*',
  '/community/reports/*',
  '/d/*/community/manage',
  '/d/*/community/notifications',
  '/d/*/community/notifications/*',
  '/d/*/community/reports/*',
  '/d/*/contests/*/solve/*',
  '/d/*/queue',
  '/d/*/settings/announcements',
  '/d/*/settings/community',
  '/d/*/solve/*',
  '/settings',
] as const;
