import type { Context, Next } from "hono";

/**
 * 应用直连时使用的基础安全响应头。
 *
 * HSTS 不在这里设置：noj-core 只提供 HTTP API，TLS 由受信任的边缘层终止。
 * CSP 也由页面层（Nitro 或边缘 Nginx）负责，避免 API 响应与页面策略混淆。
 */
export const CORE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** 为 core API 设置直连部署所需的基础安全响应头。 */
export async function securityHeaders(c: Context, next: Next) {
  for (const [name, value] of Object.entries(CORE_SECURITY_HEADERS)) {
    c.header(name, value);
  }
  await next();
}
