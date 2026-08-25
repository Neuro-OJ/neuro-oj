/**
 * noj-llm-gateway 内部管理 API 鉴权中间件。
 */
import type { MiddlewareHandler } from "hono";

/** 校验 `Authorization: Bearer <token>` 与服务间密钥一致，否则返回 401。 */
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
