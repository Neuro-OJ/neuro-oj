import { parseAuthSession } from '../utils/auth-session.ts';

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

/**
 * NOJ-215：把客户端网络信息安全地透传到 noj-core。
 *
 * 不能直接信任浏览器传入的 X-Forwarded-For / X-Real-IP：
 * - 直接暴露 UI 时攻击者可伪造这些头，使 core 误以为来自任意 IP；
 * - 因此这里把当前 TCP 对端追加到 XFF 末尾，让 core 从右往左解析时
 *   优先得到真实 socket IP，同时保留上游代理已写入的 XFF。
 * 如果 UI 前面有受信 edge，edge 写入的 XFF 会被保留，core 仍能取到真实客户端 IP。
 */
function normalizeIp(ip?: string | null): string | undefined {
  if (!ip) return undefined;
  let value = ip.trim();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value.startsWith('[') && value.includes(']')) {
    value = value.slice(1, value.indexOf(']'));
  }
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  return value || undefined;
}

function getClientNetworkHeaders(event: {
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    };
  };
  headers: Headers;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const peerIp = normalizeIp(event.node.req.socket?.remoteAddress);
  const existingXff = event.headers.get('x-forwarded-for')?.trim() ?? '';

  if (existingXff && peerIp) {
    // 总是把当前 TCP 对端放到最右，确保 core 从右往左解析时先看到真实 socket IP，
    // 防止攻击者在 XFF 里夹带任意 IP 来伪造来源。
    out['x-forwarded-for'] = `${existingXff}, ${peerIp}`;
  } else if (peerIp) {
    out['x-forwarded-for'] = peerIp;
  } else if (existingXff) {
    out['x-forwarded-for'] = existingXff;
  }

  if (peerIp) out['x-real-ip'] = peerIp;

  const ua = event.headers.get('user-agent');
  if (ua) out['user-agent'] = ua;
  return out;
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
  const clientNetworkHeaders = getClientNetworkHeaders(event);

  // ── 拦截登录/改密成功响应，设置 Cookie ──
  // 改密（issue #75 撤销机制）成功后服务端签发新 token，旧 token 被撤销；
  // 前端不感知，由 Nitro 代理同步替换 Cookie，避免「改密后被踢回登录页」的体验。
  if (shouldInterceptAuth(event)) {
    const body = await readBody(event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...clientNetworkHeaders,
    };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await $fetch.raw(target, {
        method: 'POST',
        body,
        headers,
      });

      const data = response._data as
        | { data?: { token?: unknown; user?: unknown } }
        | undefined;

      if (response.status === 200) {
        const session = parseAuthSession(data);
        if (!session) {
          // 不记录上游响应，避免把 JWT 或用户字段写入日志。
          console.error('[auth-proxy] 认证响应缺少有效 token/user');
          setResponseStatus(event, 500);
          setHeader(event, 'cache-control', 'no-store, private');
          return { error: '认证服务响应格式无效' };
        }

        const { token: jwt, user } = session;

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
        // 包含 is_admin（RBAC），供前端 admin 路由守卫判断。
        setCookie(
          event,
          'noj:session',
          JSON.stringify({
            userId: user.id,
            username: user.username,
            role: user.role ?? (user.is_admin ? 'admin' : 'user'),
            email: user.email,
            must_change_password: user.must_change_password ?? false,
            // is_admin 由核心 API 按 admin:full_access 权限计算，不再根据角色名猜测。
            is_admin: user.is_admin,
            tfa_enabled: user.tfa_enabled ?? false,
          }),
          {
            ...cookieOptions,
            httpOnly: false,
          },
        );

        // 从响应体移除 token，避免通过 JSON 再次暴露
        if (data?.data) delete data.data.token;
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
  // NOJ-215：透传客户端 IP/UA（proxyRequest 会沿用 event.node.req.headers）。
  for (const [name, value] of Object.entries(clientNetworkHeaders)) {
    event.node.req.headers[name] = value;
  }

  try {
    return await proxyRequest(event, target);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (import.meta.dev) {
      console.error('[api-proxy] 上游请求失败', {
        method: event.method,
        path: event.path,
        target,
        message: error.message,
        cause: error.cause,
      });
    }
    throw err;
  }
});
