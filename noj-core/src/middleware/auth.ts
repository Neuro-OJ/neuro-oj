import type { Context, Next } from "hono";
import { verifyToken } from "../lib/jwt.ts";

/**
 * 认证中间件——验证 JWT Bearer token。
 *
 * 提取 Authorization 头中的 Bearer token，验证签名和有效期，
 * 验证成功后通过 `c.set()` 将用户信息写入请求上下文，
 * 下游处理程序可通过 `c.get("userId")` 和 `c.get("userRole")` 获取。
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "未提供认证令牌" }, 401);
  }

  const token = authHeader.slice(7); // 去掉 "Bearer " 前缀

  try {
    const payload = await verifyToken(token);
    c.set("userId", payload.sub);
    c.set("userRole", payload.role);
    await next();
  } catch {
    return c.json({ error: "认证令牌无效或已过期" }, 401);
  }
}
