const FORWARDABLE_HEADERS = new Set([
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
  'www-authenticate',
]);

/**
 * 拦截需要同步设置 noj:token / noj:session Cookie 的认证端点。
 *
 * - POST /api/v1/auth/login：登录
 * - POST /api/v1/auth/change-password：改密成功后服务端会签发新 token，
 *   必须替换 Cookie（旧 token 在后端同时被撤销）；旧实现是让前端调 logout 清 Cookie
 *   再走 /login 重登，对用户不友好。
 */
function shouldInterceptAuth(event: { path: string; method?: string }): boolean {
  if (event.method !== 'POST') return false;
  return (
    event.path.endsWith('/api/v1/auth/login') ||
    event.path.endsWith('/api/v1/auth/change-password')
  );
}

/**
 * 生产环境下 Cookie 必须设置 secure 标志（HTTPS-only）。
 * 通过 NUXT_NOJ_ENV 或 NODE_ENV 检测；都未设置时按开发模式处理（不设 secure）。
 */
function isProductionEnv(): boolean {
  const nojEnv = process.env.NUXT_NOJ_ENV ?? process.env.NOJ_ENV;
  const nodeEnv = process.env.NODE_ENV;
  return nojEnv === 'production' || nodeEnv === 'production';
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();

  // 路径白名单：仅允许转发到 noj-core v1 API
  if (!event.path.startsWith('/api/v1/')) {
    return sendError(
      event,
      createError({ statusCode: 404, statusMessage: 'Not Found' }),
    );
  }

  const target = `${config.apiBase}${event.path}`;

  const cookies = parseCookies(event);
  const token = cookies['noj:token'];

  // ── 拦截登录/改密成功响应，设置 Cookie ──
  // 改密（issue #75 撤销机制）成功后服务端签发新 token，旧 token 被撤销；
  // 前端不感知，由 Nitro 代理同步替换 Cookie，避免「改密后被踢回登录页」的体验。
  if (shouldInterceptAuth(event)) {
    const body = event.path.endsWith('/api/v1/auth/login')
      ? await readBody(event)
      : undefined;

    try {
      const response = await $fetch.raw(target, {
        method: 'POST',
        ...(body !== undefined ? { body } : {}),
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

        const cookieOptions = {
          httpOnly: true,
          sameSite: 'lax' as const,
          path: '/',
          maxAge: 60 * 60 * 24, // 24h，与 JWT_EXPIRES_IN 一致
          // 生产 HTTPS 场景下强制 secure：防止混合内容 / 重定向泄漏 JWT Cookie
          secure: isProductionEnv(),
        };

        // HTTP-only cookie：令牌对 JS 不可见，防 XSS 窃取
        setCookie(event, 'noj:token', jwt, cookieOptions);

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
            ...cookieOptions,
            httpOnly: false,
          },
        );

        // 从响应体移除 token，避免通过 JSON 再次暴露
        delete data.data.token;
      }

      setResponseStatus(event, response.status);
      setHeader(event, 'cache-control', 'no-store, private');
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
