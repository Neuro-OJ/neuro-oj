import { and, desc, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { userBans, users } from "../../../../../shared/db/schema.ts";
import { comparePassword } from "../security/password.ts";
import { signToken } from "../security/jwt.ts";
import { logAuthEvent } from "../../../../platform/contracts/cross-module/system_services_audit-log.ts";
import { verifyTfaCodeForUser } from "../tfa.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "../../../../../shared/base/errors.ts";
import type { LoginInput, UserResponse } from "../../types/auth.ts";
import { isBannedIp } from "../../../../../shared/security/cidr.ts";
import { getBannedRanges } from "../banlist.ts";
import { toUserResponse } from "./auth-register.ts";

/** 用户最近一条活跃封禁记录（unbanned_at IS NULL）。 */
export interface ActiveUserBan {
  reason: string;
  banned_until: string | null;
  scope: string;
}

/**
 * 查询用户最近一条活跃封禁记录；无活跃封禁返回 null。
 * 密码登录与 OAuth 登录共用同一口径（取 banned_at 最新的一条）。
 */
export async function getActiveUserBan(
  userId: string,
): Promise<ActiveUserBan | null> {
  const rows = await getDb().select({
    reason: userBans.reason,
    banned_until: userBans.banned_until,
    scope: userBans.scope,
  })
    .from(userBans)
    .where(and(eq(userBans.user_id, userId), isNull(userBans.unbanned_at)))
    .orderBy(desc(userBans.banned_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 判断活跃封禁是否正在阻止用户登录。
 * 只拦 platform 封禁；social 封禁只限制社区发布，不影响登录。
 * 截止时间已过的临时封禁视为失效。
 */
export function isLoginBlockedByBan(ban: ActiveUserBan | null): boolean {
  if (!ban || ban.scope === "social") return false;
  return !ban.banned_until || Date.parse(ban.banned_until) > Date.now();
}

/**
 * 登录路径统一的封禁拦截：被封禁时抛 ForbiddenError(USER_BANNED)。
 * 密码登录与 OAuth 登录共用，保证错误类型、错误码与 details 口径一致。
 *
 * @throws {ForbiddenError} 账号处于生效中的平台封禁
 */
export function assertLoginNotBanned(ban: ActiveUserBan | null): void {
  if (!ban || !isLoginBlockedByBan(ban)) return;
  throw new ForbiddenError("账号已被封禁", "USER_BANNED", {
    reason: ban.reason,
    until: ban.banned_until,
  });
}

/**
 * 用户登录。
 * 通过用户名或邮箱查找用户，验证密码，签发 JWT。
 *
 * 为防用户枚举，不区分"用户不存在"和"密码错误"，统一返回 401。
 * 但**审计日志**（PR-2）区分四种失败原因，便于追溯攻击模式。
 *
 * @throws {UnauthorizedError} 用户名/邮箱不存在或密码错误
 * @throws {ForbiddenError} 账号被封禁（USER_BANNED code）
 */
export async function loginUser(
  input: LoginInput,
  clientIp?: string,
): Promise<{ user: UserResponse; token: string }> {
  const db = getDb();

  // 按用户名或邮箱查找用户
  const existing = await db
    .select()
    .from(users)
    .where(
      or(
        eq(users.username, input.login),
        eq(users.email, input.login),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    // PR-2 审计：用户不存在（撞库信号）
    await logAuthEvent(
      null,
      clientIp ?? "unknown",
      "auth.login_failure",
      {
        reason: "user_not_found",
        login: input.login,
      },
    );
    throw new UnauthorizedError("用户名或密码错误");
  }

  const user = existing[0];

  if (user.deleted_at) {
    await logAuthEvent(user.id, clientIp ?? "unknown", "auth.login_failure", {
      reason: "account_deleted",
      login: input.login,
    });
    throw new UnauthorizedError("用户名或密码错误");
  }

  // 验证密码
  const valid = user.password_hash !== null &&
    await comparePassword(input.password, user.password_hash);
  if (!valid) {
    await logAuthEvent(
      user.id,
      clientIp ?? "unknown",
      "auth.login_failure",
      {
        reason: "wrong_password",
        login: input.login,
      },
    );
    throw new UnauthorizedError("用户名或密码错误");
  }

  // IP 封禁检查：即使 credentials 正确，被 IP-ban 的用户也不得登录
  if (clientIp) {
    const ranges = await getBannedRanges();
    if (isBannedIp(clientIp, ranges)) {
      await logAuthEvent(
        user.id,
        clientIp,
        "auth.login_failure",
        {
          reason: "ip_banned",
          login: input.login,
        },
      );
      throw new UnauthorizedError("用户名或密码错误");
    }
  }

  // 封禁检查（user-ban-table）：查 user_bans 活跃记录
  const activeBan = await getActiveUserBan(user.id);
  if (isLoginBlockedByBan(activeBan)) {
    await logAuthEvent(
      user.id,
      clientIp ?? "unknown",
      "auth.login_failure",
      {
        reason: "user_banned",
        login: input.login,
      },
    );
    assertLoginNotBanned(activeBan);
  }

  // TFA 二次验证：已启用用户必须提供 TOTP 或恢复码。
  if (user.tfa_enabled) {
    if (!input.code) {
      throw new BadRequestError("需要两步验证码", "TFA_REQUIRED");
    }
    const tfaValid = await verifyTfaCodeForUser(
      user.id,
      input.code,
      clientIp ?? "unknown",
    );
    if (!tfaValid) {
      await logAuthEvent(
        user.id,
        clientIp ?? "unknown",
        "auth.login_failure",
        { reason: "wrong_tfa_code", login: input.login },
      );
      throw new UnauthorizedError("验证码输入错误", "TFA_INVALID");
    }
  }

  // 平台角色来自用户行；role claim 仅用于展示/审计，权限判定实时查询数据库。
  const jwtRole = user.role === "admin" ? "admin" : "user";

  // 响应中的 is_admin 展示字段：权限集（含继承）是否含 admin:full_access

  // 签发 JWT（不携带 is_admin claim，权限判定实时查询）
  // 勾选「记住我」时使用长有效期；仅接受严格的 true，防止字符串等被误判
  const token = await signToken({
    sub: user.id,
    role: jwtRole,
    must_change_password: user.must_change_password,
    session_version: user.session_version,
  }, { remember: input.remember === true });

  // PR-2 审计：登录成功
  await logAuthEvent(
    user.id,
    clientIp ?? "unknown",
    "auth.login_success",
    {
      user_id: user.id,
      login: input.login,
      remember: input.remember === true,
    },
  );

  return {
    user: toUserResponse(user, { activeBan }),
    token,
  };
}
