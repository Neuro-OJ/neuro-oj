import { cookieMaxAgeFromJwt, parseAuthSession } from '../utils/auth-session.ts';
import { withSecurityHeaders } from '../utils/security-headers.ts';

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
function shouldInterceptAuth(
  event: { path: string; method?: string },
): boolean {
  if (event.method !== 'POST') return false;
  // 必须比较 **pathname**：h3 的 `event.path` 即 `req.url`，**含 query 字符串**，
  // 因此 `endsWith('/api/v1/auth/login')` 会被 `POST /api/v1/auth/login?x=1` 绕过。
  // 后果：登录/改密的 JWT **原样回给 JS**（破坏"JWT 只进 HttpOnly Cookie"的不变量），
  // 且该路径不设置 Cookie → 会话陈旧（2026-09-29 前端审计 U-2）。
  const pathname = toUrlPathname(event.path);
  return (
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/change-password'
  );
}

/**
 * 取 URL 的 pathname（用于**规范化比较**，避免 query/编码路径干扰判定）。
 *
 * 以哨兵 origin 解析相对路径；解析失败时退化为"首段问号截断"，绝不抛错。
 */
function toUrlPathname(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, 'http://noj.internal').pathname;
  } catch {
    const q = pathOrUrl.indexOf('?');
    return q === -1 ? pathOrUrl : pathOrUrl.slice(0, q);
  }
}

/**
 * 生产环境下 Cookie 必须设置 secure 标志（HTTPS-only）。
 * 以 NUXT_NOJ_ENV / NOJ_ENV 为准；未设置时才回退 NODE_ENV。
 * 临时 HTTP 模式通过 NUXT_ALLOW_INSECURE_HTTP 显式关闭 Secure Cookie，避免浏览器
 * 不保存 Cookie 导致“未提供认证令牌”；正式 HTTPS 模式始终保留 Secure Cookie。
 */
function isProductionEnv(): boolean {
  const nojEnv = process.env.NUXT_NOJ_ENV ?? process.env.NOJ_ENV;
  if (nojEnv) return nojEnv === 'production';
  return process.env.NODE_ENV === 'production';
}

function allowsInsecureHttp(): boolean {
  return process.env.NUXT_ALLOW_INSECURE_HTTP === 'true';
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

const HOP_BY_HOP_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
]);

/** 判断是否为 SSE 流式请求：路径以 /events 结尾，或客户端显式要求 text/event-stream。 */
function isSseRequest(event: { path: string; headers: Headers }): boolean {
  if (event.path.endsWith('/events')) return true;
  const accept = event.headers.get('accept') ?? '';
  return accept.includes('text/event-stream');
}

/**
 * SSE 专用转发：直接返回 Web 标准的流式 Response。
 *
 * h3 的 proxyRequest/sendProxy 在 Deno 运行时下通过 event.node.res.write()
 * 转发流式响应，但 Deno 的 Node 兼容层不会在 handler 结束前真正 flush 响应头，
 * 导致 EventSource 一直等不到 open 事件而超时降级为轮询。
 * 这里改用 fetch + Response(body stream)，让 Nitro 按 Web Stream 方式透传 SSE。
 */
async function proxySseRequest(
  event: {
    method: string;
    path: string;
    headers: Headers;
  },
  target: string,
  token: string | undefined,
  clientNetworkHeaders: Record<string, string>,
): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of event.headers.entries()) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' ||
      lower === 'accept-encoding'
    ) {
      continue;
    }
    headers.set(name, value);
  }
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }
  for (const [name, value] of Object.entries(clientNetworkHeaders)) {
    headers.set(name, value);
  }

  const upstream = await fetch(target, {
    method: event.method,
    headers,
    redirect: 'manual',
  });

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'content-length' ||
      lower === 'content-encoding'
    ) {
      continue;
    }
    responseHeaders.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
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

  // 路径白名单：仅允许转发到 noj-core v1 API。
  //
  // **必须先规范化再校验**（2026-09-29 前端审计 U-1，匿名可利用）：
  // `event.path` 携带的是**未归一化**的路径（h3 会解码 `%2e%2e%2f` → `../`），
  // 裸 `startsWith('/api/v1/')` 会放过 `/api/v1/%2e%2e%2f%2e%2e%2fmetrics` 这类输入，
  // 而随后的 `fetch()` 会按 URL 规范归一化 dot-segment，最终打到 noj-core 的**任意路径**
  //（`/metrics`、`/health`、调试路由…），并带上该访客的 Cookie。
  // 用 `new URL()` 归一化（它会同时消解字面 `..` 与 `%2e%2e` 形态），再校验 origin 与前缀。
  const apiBaseOrigin = new URL(config.apiBase).origin;
  let targetUrl: URL;
  try {
    targetUrl = new URL(event.path, apiBaseOrigin);
  } catch {
    return sendError(
      event,
      createError({ statusCode: 404, statusMessage: 'Not Found' }),
    );
  }
  // 纵深防御：`new URL()` **不会**把 `%2e%2e%2f` 归一化（视作字面量），
  // 因此路径里若仍残留**编码形态**的 `.` / `/` / `\`（`%2e`/`%2f`/`%5c`），
  // 无论上游是否已解码，一律拒绝——不给"依赖 Nitro 一定先解码"留假设。
  // 该 API 的合法路径段只有 UUID / display_id / label / 数字，不会用到这些编码。
  const target = /%(2e|2f|5c)/i.test(targetUrl.pathname) ? null : targetUrl.toString();

  if (
    target === null ||
    targetUrl.origin !== apiBaseOrigin ||
    !targetUrl.pathname.startsWith('/api/v1/')
  ) {
    return sendError(
      event,
      createError({ statusCode: 404, statusMessage: 'Not Found' }),
    );
  }

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
          // 与 JWT exp 同步：普通登录随 jwt_expires_in，「记住我」随 jwt_remember_expires_in
          maxAge: cookieMaxAgeFromJwt(jwt),
          // 生产 HTTPS 场景下强制 secure：防止混合内容 / 重定向泄漏 JWT Cookie
          secure: isProductionEnv() && !allowsInsecureHttp(),
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
            avatar_url: user.avatar_url ?? null,
            must_change_password: user.must_change_password ?? false,
            email_verified: user.email_verified ?? true,
            has_local_password: user.has_local_password ?? true,
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

  // SSE 长连接在 Deno 运行时下不能走 h3 proxyRequest（Node res 兼容层不会及时
  // flush 响应头），这里单独用 Web Stream Response 透传。
  if (isSseRequest(event)) {
    const response = await proxySseRequest(
      event,
      target,
      token,
      clientNetworkHeaders,
    );
    return withSecurityHeaders(response);
  }

  try {
    // 注意：h3 的 proxyRequest 会把上游响应（含**状态码**与响应头）直接写入
    // event.node.res 并结束响应，其返回值是 undefined —— 并不是 Response。
    //
    // 曾把它交给 withSecurityHeaders() 包成 new Response(...)，后果是：
    //   1) 状态码被 new Response(undefined, { status: undefined }) 重置为 200，
    //      上游的 401/403/404/429/5xx 全部丢失；
    //   2) 上游的 content-type 等响应头被丢弃（Headers(undefined) 为空）。
    // 该缺陷只在**构建产物**（生产与 CI 使用的 .output/server）上暴露：dev 下
    // Node 兼容层保留了已写入的 statusCode，长期掩盖了问题。实测同一请求
    // 直连 core=404 / dev 代理=404 / 构建产物代理=200。
    //
    // 安全响应头由 server/middleware/security-headers.ts 统一设置（对所有响应生效），
    // 此处无需再包一层；直接返回即可让已写入的状态码生效。
    //
    // 2026-09-12 架构评审 §4.1：**必须显式 redirect: 'manual'**。
    // h3 的 sendProxy 用 ofetch 且把选项透传给 fetch，而 ofetch 不设 redirect 默认值
    // → 平台默认 follow。上游 302（OAuth 授权跳转）会被代理自己跟随，把第三方页面
    // 回吐给浏览器，浏览器永远停留在 /api/v1/auth/oauth/:provider 而进不到回调端点
    // （state 校验与 Set-Cookie 都在回调响应里）→ OAuth 登录 100% 失败。
    // SSE 分支此前已显式设置该语义（proxySseRequest），这里补齐非 SSE 分支。
    await proxyRequest(event, target, {
      fetchOptions: { redirect: 'manual' },
    });
    return;
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
