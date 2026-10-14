/** 域页面先同步统一身份，再建立按用户隔离的数据键；不使用 Cookie 决定域权限。 */
export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuth();
  if (useCookie('noj:session').value) await auth.fetchUser();
});
