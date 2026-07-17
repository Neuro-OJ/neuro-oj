// deleteCookie 由 h3 自动导入

/**
 * 本地注销端点（issue #75 JWT 撤销机制）。
 *
 * 流程：
 * 1. 读取 noj:token Cookie
 * 2. 调用后端 /api/v1/auth/logout 撤销 token（写入 Redis 黑名单）
 *    - 即使后端调用失败（网络/服务异常），也要清除本地 Cookie 避免用户无法登出
 * 3. 清除本地 noj:token / noj:session Cookie
 *
 * 必须在清 Cookie 前先通知后端，否则用户「点登出 → Cookie 已清 → 再访问
 * 受保护页面时被中间件挡」之间存在 token 仍有效的窗口期（攻击者可劫持）。
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const cookies = parseCookies(event);
  const token = cookies["noj:token"];

  // 1. 通知后端撤销该 token（fail-open：失败时也要清本地 Cookie）
  if (token) {
    try {
      await $fetch(`${config.apiBase}/api/v1/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.warn("[logout] 后端撤销失败，继续清本地 Cookie:", err);
    }
  }

  // 2. 清除本地 Cookie
  deleteCookie(event, "noj:token", {
    path: "/",
  });
  deleteCookie(event, "noj:session", {
    path: "/",
  });

  return { success: true };
});
