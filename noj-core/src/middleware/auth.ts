import type { Context, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.ts";
import { verifyToken } from "../lib/jwt.ts";
import { isJtiRevoked } from "../lib/revokedTokens.ts";
import { getDb } from "../db/connection.ts";
import { userBans } from "../db/schema.ts";
import { getCached } from "../lib/banCache.ts";
import { getClientIp } from "../lib/rate-limit-env.ts";
import { runWithContext } from "../lib/requestContext.ts";
import { ADMIN_FULL_ACCESS, resolvePermissions } from "../lib/permissions.ts";

/**
 * 认证相关 Hono Env 类型（PR-6 抽取）。
 *
 * 统一所有需要认证上下文的路由的 Variables 类型，避免每个文件重复定义：
 * - `AuthEnv`：authMiddleware 注入 userId/userRole/jti（必有）
 * - `OptionalAuthEnv`：optionalAuthMiddleware 注入（可有可无）
 *
 * 路由层用法：
 * ```ts
 * import type { AuthEnv } from "../middleware/auth.ts";
 * const app = new Hono<AuthEnv>();
 * app.get("/me", authMiddleware, (c) => {
 *   const userId = c.get("userId"); // 类型：string（非 undefined）
 * });
 * ```
 */
export interface AuthEnv {
  Variables: {
    userId: string;
    userRole: string;
    mustChangePassword: boolean;
    jti?: string;
  };
}

/** optionalAuthMiddleware 注入（c.get("userId") 可能 undefined） */
export interface OptionalAuthEnv {
  Variables: {
    userId?: string;
    userRole?: string;
    mustChangePassword?: boolean;
    jti?: string;
  };
}

/**
 * 强制改密白名单（issue #75）。
 *
 * 当 token.must_change_password=true 时，仅允许访问白名单内路径；
 * 其余路径一律抛 ForbiddenError(PASSWORD_CHANGE_REQUIRED)。
 *
 * 设计：最小白名单——只允许"改密 + 查看自己 + 登出"。
 * 用户即使在强制改密状态下也应能登出（与 BAN_WHITELIST 设计一致：
 * 被封用户也需能登出）。
 *
 * 注意：路径必须与 app.ts 挂载前缀组合后的完整路径一致。
 */
export const PASSWORD_CHANGE_WHITELIST: readonly string[] = [
  "/api/v1/auth/change-password",
  "/api/v1/auth/me",
  "/api/v1/auth/logout",
] as const;

/**
 * 封禁状态校验白名单（issue #102 / audit NOJ-007）。
 *
 * 安全修复：封禁用户的既有 JWT 对读写请求都必须失效，仅 logout 豁免
 * （被封用户必须能登出）。GET 不再自动放行。
 */
export const BAN_WHITELIST: readonly string[] = [
  "/api/v1/auth/logout",
] as const;

/**
 * 用户 ban 状态（从 users 表读，60s LRU 缓存）。
 */
export interface UserBanState {
  banned: boolean;
  reason: string;
  until: string | null;
}

/**
 * 封禁状态公共校验（authMiddleware 与 optionalAuthMiddleware 共享）。
 *
 * 方法限制：GET/HEAD/OPTIONS 放行（被封用户可浏览、查状态）
 * 白名单：写操作中豁免的路径（如 logout）
 */
async function checkBanStatus(c: Context, userId: string): Promise<void> {
  // NOJ-007：封禁后旧 JWT 对读写均失效，仅 logout 路径豁免。
  if (!BAN_WHITELIST.includes(c.req.path)) {
    const banState = await getUserBanState(userId);
    const stillBanned = banState.banned &&
      (!banState.until || Date.parse(banState.until) > Date.now());
    if (stillBanned) {
      throw new ForbiddenError("账号已被封禁", "USER_BANNED", {
        reason: banState.reason,
        until: banState.until,
      });
    }
  }
}

/**
 * 解析并验证 JWT token，返回 payload 或 null。
 *
 * 共享逻辑：authMiddleware 与 optionalAuthMiddleware 共用。
 * - 从 Authorization header 提取 Bearer token
 * - 调用 verifyToken 验证签名+有效期
 * - 检查 JTI 是否已撤销
 *
 * @param c Hono Context
 * @returns payload（验证通过）或 null（无 token / token 无效）
 */
async function resolveToken(
  c: Context,
): Promise<Awaited<ReturnType<typeof verifyToken>> | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  let payload: Awaited<ReturnType<typeof verifyToken>> | null = null;
  try {
    payload = await verifyToken(token);
  } catch {
    return null;
  }

  if (!payload) return null;

  // 撤销检查
  if (payload.jti && await isJtiRevoked(payload.jti)) {
    return null;
  }

  return payload;
}

/**
 * 可选认证中间件——有 token 则验证并注入用户信息，无 token 则以匿名身份放行。
 *
 * 与 authMiddleware 的区别：
 * - authMiddleware：要求必须登录，未登录直接抛 401
 * - optionalAuthMiddleware：未登录也放行，但 c.get("userId") 为 undefined
 *
 * 适用于公开但支持个性化数据的端点（如公共提交列表、题目列表）。
 * 下游路由通过 `if (!c.get("userId"))` 判断是否匿名。
 */
export async function optionalAuthMiddleware(
  c: Context,
  next: Next,
): Promise<void> {
  const payload = await resolveToken(c);

  if (payload) {
    c.set("userId", payload.sub);
    c.set("userRole", payload.role);
    c.set("mustChangePassword", payload.must_change_password ?? false);
    if (payload.jti) c.set("jti", payload.jti);

    await checkBanStatus(c, payload.sub);
  }
  await next();
}

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
 *
 * issue #102 / audit NOJ-007：扩展封禁校验——从 DB 查 user_bans
 * （60s LRU 缓存），命中且未过期则抛 ForbiddenError（USER_BANNED）；
 * 封禁用户的既有 JWT 对读写请求均不可再用（logout 除外）。
 * `banUser`/`unbanUser` 写操作会调 `invalidateBanCache` 立即失效。
 */
export async function authMiddleware(c: Context, next: Next): Promise<void> {
  // 先检查请求头是否存在（提供精确的错误信息）
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("未提供认证令牌");
  }

  const payload = await resolveToken(c);

  if (!payload) {
    throw new UnauthorizedError("认证令牌无效或已过期");
  }

  // 强制改密拦截
  if (
    payload.must_change_password === true &&
    !PASSWORD_CHANGE_WHITELIST.includes(c.req.path)
  ) {
    throw new ForbiddenError("请先修改密码", "PASSWORD_CHANGE_REQUIRED");
  }

  // 封禁校验
  await checkBanStatus(c, payload.sub);

  c.set("userId", payload.sub);
  c.set("userRole", payload.role);
  c.set("mustChangePassword", payload.must_change_password ?? false);
  if (payload.jti) c.set("jti", payload.jti);
  await next();
}

/**
 * 读取用户 ban 状态（60s LRU 缓存）。
 * 缓存 key: `user:${userId}` → UserBanState
 * 从 user_bans 表查询活跃封禁（unbanned_at IS NULL）。
 */
export function getUserBanState(userId: string): Promise<UserBanState> {
  return getCached(`user:${userId}`, async () => {
    const db = getDb();
    const rows = await db
      .select({
        reason: userBans.reason,
        banned_until: userBans.banned_until,
      })
      .from(userBans)
      .where(and(
        eq(userBans.user_id, userId),
        isNull(userBans.unbanned_at),
      ))
      .limit(1);
    if (rows.length === 0) {
      return { banned: false, reason: "", until: null };
    }
    return {
      banned: true,
      reason: rows[0].reason,
      until: rows[0].banned_until,
    };
  });
}

/**
 * 管理员中间件——检查当前用户是否为管理员。
 *
 * 需要在 authMiddleware 之后使用。基于实时权限查询判断：
 * 权限集（含角色继承链）包含 `admin:full_access` 即视为管理员，
 * 不依赖 JWT claim（JWT 不携带 is_admin）。
 *
 * 注入 RequestContext 到 AsyncLocalStorage（issue #101），使下游 service 层
 * 通过 getRequestContext() 获取 actorId / actorIp / actorRole，
 * 用于审计日志埋点。
 */
export async function adminMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const perms = await resolvePermissions(c);
  if (!perms.has(ADMIN_FULL_ACCESS)) {
    throw new ForbiddenError("需要管理员权限");
  }

  return runWithContext(
    {
      actorId: c.get("userId"),
      actorIp: getClientIp(c),
      actorRole: c.get("userRole"),
    },
    () => next(),
  );
}
