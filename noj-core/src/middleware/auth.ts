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

/**
 * 管理员中间件——检查当前用户是否为管理员。
 *
 * 需要在 authMiddleware 之后使用，依赖其注入的 userRole 字段。
 * 若用户角色不为 "admin"，返回 403 禁止访问。
 */
export async function adminMiddleware(c: Context, next: Next) {
  if (c.get("userRole") !== "admin") {
    return c.json({ error: "需要管理员权限" }, 403);
  }
  await next();
}
