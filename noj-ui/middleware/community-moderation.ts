/**
 * 社区管理路由守卫。
 *
 * 管理员（is_admin / role=admin）直接放行；
 * 非管理员需具备社区审核权限（community_moderation:review，
 * 通过 /community/config 返回的 permissions.moderate 判定）。
 *
 * - 未登录 → 重定向到 /login
 * - 无审核权限 → 重定向到 /（静默拦截，不给错误提示）
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  // SSR 阶段跳过守卫——页面是客户端渲染，水合后会重新执行
  if (import.meta.server) return;

  const { loading, isLoggedIn, user } = useAuth();

  // 等待认证状态就绪，加 5s 超时防止后端不可达时页面卡死
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

  // 未登录 → 去登录页
  if (!isLoggedIn.value) {
    return navigateTo('/login');
  }

  // 管理员直接放行（isAdmin 字段优先，向后兼容 role 字段）
  const isAdmin = (user.value as Record<string, unknown>)?.is_admin ??
    (user.value?.role === 'admin');
  if (isAdmin) return;

  // 非管理员：以社区配置的 moderate 权限（community_moderation:review）判定
  try {
    const res = await $fetch<{
      data: { permissions?: Record<string, boolean> };
    }>('/api/v1/community/config');
    if (res.data?.permissions?.moderate) return;
  } catch {
    // 后端不可达时按无权限处理
  }
  return navigateTo('/');
});
