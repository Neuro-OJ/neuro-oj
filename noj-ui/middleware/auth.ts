/**
 * 登录路由守卫。
 * 保护需要登录的页面，未登录用户重定向到 /login。
 *
 * SSR 阶段跳过守卫，由客户端水合后重新执行。
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  if (import.meta.server) return;

  const { loading, isLoggedIn } = useAuth();

  if (loading.value) {
    await Promise.race([
      new Promise<void>((resolve) => {
        const unwatch = watch(loading, (val) => {
          if (!val) {
            unwatch();
            resolve();
          }
        });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  if (!isLoggedIn.value) {
    return navigateTo("/login");
  }
});
