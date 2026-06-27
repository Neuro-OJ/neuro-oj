export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const target = `${config.apiBase}${event.path}`;

  const cookies = parseCookies(event);
  const token = cookies['noj:token'];

  // ── 拦截登录成功响应，设置 Cookie ──
  if (event.path.endsWith('/api/v1/auth/login') && event.method === 'POST') {
    const body = await readBody(event);

    try {
      const response = await $fetch.raw(target, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      });

      const data = response._data as
        | {
          data?: {
            token?: string;
            user?: {
              id: string;
              username: string;
              role: string;
              email: string;
              must_change_password?: boolean;
            };
          };
        }
        | undefined;

      if (response.status === 200 && data?.data?.token) {
        const jwt = data.data.token;
        const user = data.data.user!;

        // HTTP-only cookie：令牌对 JS 不可见，防 XSS 窃取
        setCookie(event, 'noj:token', jwt, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24, // 24h，与 JWT_EXPIRES_IN 一致
        });

        // 可读 cookie：客户端用于快速判断登录状态
        // 包含 must_change_password（issue #75），前端路由守卫据此强制改密。
        setCookie(
          event,
          'noj:session',
          JSON.stringify({
            userId: user.id,
            username: user.username,
            role: user.role,
            email: user.email,
            must_change_password: user.must_change_password ?? false,
          }),
          {
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24,
          },
        );

        // 从响应体移除 token，避免通过 JSON 再次暴露
        delete data.data.token;
      }

      setResponseStatus(event, response.status);
      return data;
    } catch (err) {
      const e = err as { response?: { status: number; _data: unknown } };
      if (e.response) {
        setResponseStatus(event, e.response.status);
        return e.response._data;
      }
      throw err;
    }
  }

  // ── 从 Cookie 注入 Authorization 头到转发请求 ──
  if (token) {
    event.node.req.headers.authorization = `Bearer ${token}`;
  }

  // ── /api/v1/auth/me：同步刷新 session cookie 中的 must_change_password ──
  // 修改密码成功后，user 状态已变为 must_change_password=false，
  // 前端 fetchUser() 通过这里把新状态写回可读 cookie，
  // 确保水合后或下次导航路由守卫读到最新值。
  if (event.path.endsWith('/api/v1/auth/me') && event.method === 'GET') {
    try {
      const response = await $fetch.raw(target, {
        method: 'GET',
        headers: event.node.req.headers as Record<string, string>,
      });

      const data = response._data as
        | {
          data?: {
            id: string;
            username: string;
            role: string;
            email: string;
            must_change_password?: boolean;
          };
        }
        | undefined;

      if (response.status === 200 && data?.data) {
        const user = data.data;
        setCookie(
          event,
          'noj:session',
          JSON.stringify({
            userId: user.id,
            username: user.username,
            role: user.role,
            email: user.email,
            must_change_password: user.must_change_password ?? false,
          }),
          {
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24,
          },
        );
      }

      setResponseStatus(event, response.status);
      return data;
    } catch (err) {
      const e = err as { response?: { status: number; _data: unknown } };
      if (e.response) {
        setResponseStatus(event, e.response.status);
        return e.response._data;
      }
      throw err;
    }
  }

  return proxyRequest(event, target);
});
