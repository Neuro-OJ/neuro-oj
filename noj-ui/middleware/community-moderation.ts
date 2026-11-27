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
import { isAdminUser } from '~/utils/auth/isAdminUser';

export default defineNuxtRouteMiddleware(async (to, _from) => {
  // SSR 阶段跳过守卫——页面是客户端渲染，水合后会重新执行
  if (import.meta.server) return;

  const { isLoggedIn, user, ensureAuthReady } = useAuth(to);
  const { api } = useApi(to);

  // 等待认证状态就绪（与 auth/admin 守卫口径一致）
  await ensureAuthReady();

  // 未登录 → 去登录页
  if (!isLoggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
  }

  // 管理员直接放行
  if (isAdminUser(user.value)) return;

  // 非管理员：以社区配置的 moderate 权限（community_moderation:review）判定
  try {
    const res = await api.get<{
      data: { permissions?: Record<string, boolean> };
    }>('/api/v1/community/config', { silent: true, redirectOnUnauthorized: false });
    if (res.data?.permissions?.moderate) return;
  } catch {
    // 后端不可达时按无权限处理
  }
  return navigateTo('/');
});
