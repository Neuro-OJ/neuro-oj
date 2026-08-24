/**
 * noj-llm-gateway 内部管理 API 鉴权中间件。
 */
import type { MiddlewareHandler } from "hono";

export function requireServiceToken(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || token !== expected) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
