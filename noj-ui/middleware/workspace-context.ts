import { authCookieNames } from '~/utils/auth-cookies';
/** 域页面先同步统一身份，再建立按用户隔离的数据键；不使用 Cookie 决定域权限。 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (useState('bff:view').value) return;
  const auth = useAuth(to);
  if (useCookie(authCookieNames(useRuntimeConfig().public.authCookiePrefix).session).value) await auth.fetchUser();
});
