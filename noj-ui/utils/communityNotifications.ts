/**
 * 判断是否需要加载社区通知未读数。
 *
 * 未读数接口只允许登录用户访问，公共布局不得为匿名用户发起请求。
 */
export function shouldLoadCommunityUnreadCount(
  user: unknown,
  communityEnabled: boolean | undefined,
): boolean {
  return Boolean(user) && communityEnabled === true;
}

/**
 * 未读数属于后台状态探测：认证失效时只清零角标，不应把公共页面跳转到登录页。
 */
export const COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS = {
  silent: true,
  redirectOnUnauthorized: false,
} as const;
