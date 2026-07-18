import type { Context, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.ts";
import { verifyToken } from "../lib/jwt.ts";
import { isJtiRevoked } from "../lib/revokedTokens.ts";
import { getDb } from "../db/connection.ts";
import { userBans } from "../db/schema.ts";
import { getCached } from "../lib/banCache.ts";
import { getClientIp } from "../lib/rateLimitEnv.ts";
import { runWithContext } from "../lib/requestContext.ts";

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
  "/api/v1/auth/logout",
] as const;

/**
 * 封禁状态校验白名单（issue #102 / ban-status-endpoint）。
 *
 * 与 `banlistMiddleware` 统一采用"方法限制 + 最小白名单"策略：
 * - GET/HEAD/OPTIONS → 直接放行（被封用户可浏览、查 ban-status）
 * - POST/PUT/PATCH/DELETE → 检查封禁状态（白名单路径豁免）
 *
 * 白名单仅保留 logout——被封用户必须能登出。
 * login 不需要白名单（login 路由不经过 authMiddleware）；
 * /me 不需要白名单（GET 方法限制自动放行）。
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
  if (
    c.req.method !== "GET" && c.req.method !== "HEAD" &&
    c.req.method !== "OPTIONS" &&
    !BAN_WHITELIST.includes(c.req.path)
  ) {
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
 * 可选认证中间件——有 token 则验证并注入用户信息，无 token 则以匿名身份放行。
 *
 * 与 authMiddleware 的区别：
 * - authMiddleware：要求必须登录，未登录直接抛 401
 * - optionalAuthMiddleware：未登录也放行，但 c.get("userId") 为 undefined
 *
 * 适用于公开但支持个性化数据的端点（如公共提交列表、题目列表）。
 * 下游路由通过 `if (!c.get("userId"))` 判断是否匿名。
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    let payload: Awaited<ReturnType<typeof verifyToken>> | null = null;
    try {
      payload = await verifyToken(token);
    } catch {
      // token 无效或过期：以匿名身份放行
    }

    if (payload) {
      // 撤销检查（issue #75 JWT 撤销机制）：
      // 已被主动撤销的 jti（/logout、/change-password）即使签名有效也视作无效。
      // Redis 不可用时 isJtiRevoked 抛 ServiceUnavailableError，
      // 让 Hono onError 统一返 503（fail-closed）。
      if (payload.jti && await isJtiRevoked(payload.jti)) {
        payload = null;
      }
    }

    if (payload) {
      c.set("userId", payload.sub);
      c.set("userRole", payload.role);
      c.set("mustChangePassword", payload.must_change_password ?? false);
      if (payload.jti) c.set("jti", payload.jti);

      await checkBanStatus(c, payload.sub);
    }
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
 * issue #102：扩展封禁校验——从 DB 查 users.banned/banned_reason/banned_until
 * （60s LRU 缓存），命中且未过期则抛 ForbiddenError（USER_BANNED）。
 * `banUser`/`unbanUser` 写操作会调 `invalidateBanCache` 立即失效。
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

  // 撤销检查（issue #75 JWT 撤销机制）：
  // /logout、/change-password 等场景主动写入 Redis 黑名单。
  // 即使签名 + iss + aud + exp 均有效，被撤销的 jti 也视作无效。
  // fail-closed：isJtiRevoked 抛 ServiceUnavailableError 时由 onError 返 503。
  if (payload.jti && await isJtiRevoked(payload.jti)) {
    throw new UnauthorizedError("认证令牌已失效");
  }

  // 强制改密拦截（评审修复 M1：抛 ForbiddenError 而非 c.json）
  if (
    payload.must_change_password === true &&
    !PASSWORD_CHANGE_WHITELIST.includes(c.req.path)
  ) {
    throw new ForbiddenError("请先修改密码", "PASSWORD_CHANGE_REQUIRED");
  }

  // 封禁校验（与 optionalAuthMiddleware 共享 checkBanStatus）
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
export async function getUserBanState(userId: string): Promise<UserBanState> {
  return await getCached(`user:${userId}`, async () => {
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
 * 需要在 authMiddleware 之后使用，依赖其注入的 userRole 字段。
 * 若用户角色不为 "admin"，抛 ForbiddenError 由 app.ts onError 统一处理。
 *
 * 注入 RequestContext 到 AsyncLocalStorage（issue #101），使下游 service 层
 * 通过 getRequestContext() 获取 actorId / actorIp / actorRole，
 * 用于审计日志埋点。
 */
export async function adminMiddleware(c: Context, next: Next) {
  const userRole = c.get("userRole");
  if (userRole !== "admin") {
    throw new ForbiddenError("需要管理员权限");
  }

  return await runWithContext(
    {
      actorId: c.get("userId"),
      actorIp: getClientIp(c),
      actorRole: userRole,
    },
    () => next(),
  );
}
