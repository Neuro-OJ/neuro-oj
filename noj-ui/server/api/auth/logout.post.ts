// deleteCookie 由 h3 自动导入

export default defineEventHandler(async (event) => {
  // 清除认证 Cookie
  deleteCookie(event, "noj:token", {
    path: "/",
  });
  deleteCookie(event, "noj:session", {
    path: "/",
  });

  return { success: true };
});
