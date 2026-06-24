export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const target = `${config.apiBase}${event.path}`;

  const cookies = parseCookies(event);
  const token = cookies["noj:token"];

  // ── 拦截登录成功响应，设置 Cookie ──
  if (event.path.endsWith("/api/v1/auth/login") && event.method === "POST") {
    const body = await readBody(event);

    try {
      const response = await $fetch.raw(target, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });

      const data = response._data as
        | { data?: { token?: string; user?: { id: string; username: string; role: string; email: string } } }
        | undefined;

      if (response.status === 200 && data?.data?.token) {
        const jwt = data.data.token;
        const user = data.data.user!;

        // HTTP-only cookie：令牌对 JS 不可见，防 XSS 窃取
        setCookie(event, "noj:token", jwt, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24, // 24h，与 JWT_EXPIRES_IN 一致
        });

        // 可读 cookie：客户端用于快速判断登录状态
        setCookie(event, "noj:session", JSON.stringify({
          userId: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
        }), {
          httpOnly: false,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24,
        });

        // 从响应体移除 token，避免通过 JSON 再次暴露
        delete data.data.token;
      }

      setResponseStatus(event, response.status);
      return data;
    } catch (err: any) {
      if (err.response) {
        setResponseStatus(event, err.response.status);
        return err.response._data;
      }
      throw err;
    }
  }

  // ── 从 Cookie 注入 Authorization 头到转发请求 ──
  if (token) {
    event.node.req.headers.authorization = `Bearer ${token}`;
  }

  return proxyRequest(event, target);
});
