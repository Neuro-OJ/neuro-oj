/**
 * 不需要登录即可访问的路径白名单（issue #49）。
 * 密码重置相关页面（forgot-password / reset-password）必须可匿名访问。
 */
const PUBLIC_AUTH_PATHS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
]);

/**
 * 登录路由守卫。
 * 保护需要登录的页面，未登录用户重定向到 /login。
 *
 * 白名单（issue #49）：/login、/register、/forgot-password、/reset-password 免守卫。
 *
 * SSR 阶段跳过守卫，由客户端水合后重新执行。
 */
export default defineNuxtRouteMiddleware(async (to, _from) => {
  if (import.meta.server) return;

  if (PUBLIC_AUTH_PATHS.has(to.path)) return;

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
