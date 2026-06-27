import type { Context, Next } from "hono";
import { verifyToken } from "../lib/jwt.ts";

/**
 * 强制改密白名单（issue #75）。
 *
 * 当 token.must_change_password=true 时，仅允许访问白名单内路径；
 * 其余路径一律 403 PASSWORD_CHANGE_REQUIRED。
 *
 * 设计：最小白名单——只允许"改密 + 查看自己 + 登出"。
 * 注意：路径必须与 app.ts 挂载前缀组合后的完整路径一致。
 */
export const PASSWORD_CHANGE_WHITELIST: readonly string[] = [
  "/api/v1/auth/change-password",
  "/api/v1/auth/me",
  "/api/v1/auth/logout",
] as const;

/**
 * 认证中间件——验证 JWT Bearer token。
 *
 * 提取 Authorization 头中的 Bearer token，验证签名和有效期，
 * 验证成功后通过 `c.set()` 将用户信息写入请求上下文，
 * 下游处理程序可通过 `c.get("userId")` / `c.get("userRole")` /
 * `c.get("mustChangePassword")` 获取。
 *
 * issue #75：若 token 携带 must_change_password=true 且请求路径
 * 不在白名单内，直接返回 403 PASSWORD_CHANGE_REQUIRED，
 * 不执行 next()。
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "未提供认证令牌" }, 401);
  }

  const token = authHeader.slice(7); // 去掉 "Bearer " 前缀

  try {
    const payload = await verifyToken(token);

    // 强制改密拦截
    if (
      payload.must_change_password === true &&
      !PASSWORD_CHANGE_WHITELIST.includes(c.req.path)
    ) {
      return c.json(
        {
          error: "请先修改密码",
          code: "PASSWORD_CHANGE_REQUIRED",
        },
        403,
      );
    }

    c.set("userId", payload.sub);
    c.set("userRole", payload.role);
    c.set("mustChangePassword", payload.must_change_password ?? false);
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
