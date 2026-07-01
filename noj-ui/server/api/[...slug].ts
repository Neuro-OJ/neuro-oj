const FORWARDABLE_HEADERS = new Set([
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
  "www-authenticate",
]);

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();

  // 路径白名单：仅允许转发到 noj-core v1 API
  if (!event.path.startsWith("/api/v1/")) {
    return sendError(
      event,
      createError({ statusCode: 404, statusMessage: "Not Found" }),
    );
  }

  const target = `${config.apiBase}${event.path}`;

  const cookies = parseCookies(event);
  const token = cookies['noj:token'];

  // ── 拦截登录成功响应，设置 Cookie ──
  // 严格遵循 noj-ui/AGENTS.md:163：仅拦截 POST /api/v1/auth/login。
  // 修改密码（issue #75）流程由前端 useAuth.changePassword() 在成功后
  // 调用 logout() 清空 Cookie，再跳 /login 重新登录——不需要在 /me
  // 拦截处同步 must_change_password 状态。
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
      setHeader(event, "cache-control", "no-store, private");
      return data;
    } catch (err) {
      const e = err as {
        response?: {
          status: number;
          _data: unknown;
          headers?: Record<string, string>;
        };
      };
      if (e.response) {
        setResponseStatus(event, e.response.status);
        if (e.response.headers) {
          for (const [name, value] of Object.entries(e.response.headers)) {
            if (FORWARDABLE_HEADERS.has(name.toLowerCase())) {
              setHeader(event, name, value);
            }
          }
        }
        return e.response._data;
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
