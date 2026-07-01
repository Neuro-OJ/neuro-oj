import type { Context, Next } from "hono";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.ts";
import { verifyToken } from "../lib/jwt.ts";

/**
 * 强制改密白名单（issue #75）。
 *
 * 当 token.must_change_password=true 时，仅允许访问白名单内路径；
 * 其余路径一律抛 ForbiddenError(PASSWORD_CHANGE_REQUIRED)。
 *
 * 设计：最小白名单——只允许"改密 + 查看自己"。
 *
 * 评审修复 M5（issue #75 评审 Sp7）：移除 `/api/v1/auth/logout`。
 * 原 logout 端点是 no-op stub；实际登出由 noj-ui Nitro 代理处理。
 * 强制改密状态下用户不需要走后端 logout（Nitro 本地清 Cookie），
 * 把 logout 移出白名单可缩小攻击面。
 *
 * 注意：路径必须与 app.ts 挂载前缀组合后的完整路径一致。
 */
export const PASSWORD_CHANGE_WHITELIST: readonly string[] = [
  "/api/v1/auth/change-password",
  "/api/v1/auth/me",
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
 * 不在白名单内，抛 ForbiddenError（PASSWORD_CHANGE_REQUIRED），
 * 由 app.ts onError 统一处理（评审修复 M1）。
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("未提供认证令牌");
  }

  const token = authHeader.slice(7); // 去掉 "Bearer " 前缀

  let payload;
  try {
    payload = await verifyToken(token);
  } catch {
    throw new UnauthorizedError("认证令牌无效或已过期");
  }

  // 强制改密拦截（评审修复 M1：抛 ForbiddenError 而非 c.json）
  if (
    payload.must_change_password === true &&
    !PASSWORD_CHANGE_WHITELIST.includes(c.req.path)
  ) {
    throw new ForbiddenError("请先修改密码", "PASSWORD_CHANGE_REQUIRED");
  }

  c.set("userId", payload.sub);
  c.set("userRole", payload.role);
  c.set("mustChangePassword", payload.must_change_password ?? false);
  await next();
}

/**
 * 管理员中间件——检查当前用户是否为管理员。
 *
 * 需要在 authMiddleware 之后使用，依赖其注入的 userRole 字段。
 * 若用户角色不为 "admin"，抛 ForbiddenError 由 app.ts onError 统一处理。
 */
export async function adminMiddleware(c: Context, next: Next) {
  if (c.get("userRole") !== "admin") {
    throw new ForbiddenError("需要管理员权限");
  }
  await next();
}
