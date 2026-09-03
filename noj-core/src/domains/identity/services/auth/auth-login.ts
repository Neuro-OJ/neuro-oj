import { and, desc, eq, isNull, or } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  roles,
  userBans,
  userRoles,
  users,
} from "./../../../../shared/db/schema.ts";
import { comparePassword } from "./../security/password.ts";
import { isUserAdmin } from "./../security/permissions.ts";
import { signToken } from "./../security/jwt.ts";
import { logAuthEvent } from "../../../system/index.ts";
import { verifyTfaCodeForUser } from "../tfa.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "./../../../../shared/base/errors.ts";
import type { LoginInput, UserResponse } from "./../../types/auth.ts";
import { isBannedIp } from "./../../../../shared/security/cidr.ts";
import { getBannedRanges } from "../banlist.ts";
import { toUserResponse } from "./auth-register.ts";

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
  const activeBan = await db.select({
    reason: userBans.reason,
    banned_until: userBans.banned_until,
    scope: userBans.scope,
  })
    .from(userBans)
    .where(and(eq(userBans.user_id, user.id), isNull(userBans.unbanned_at)))
    .orderBy(desc(userBans.banned_at))
    .limit(1);
  if (activeBan.length > 0 && activeBan[0].scope !== "social") {
    const stillBanned = !activeBan[0].banned_until ||
      Date.parse(activeBan[0].banned_until) > Date.now();
    if (stillBanned) {
      await logAuthEvent(
        user.id,
        clientIp ?? "unknown",
        "auth.login_failure",
        {
          reason: "user_banned",
          login: input.login,
        },
      );
      throw new ForbiddenError("账号已被封禁", "USER_BANNED", {
        reason: activeBan[0].reason,
        until: activeBan[0].banned_until,
      });
    }
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

  // 查询用户角色（从 RBAC 表；role claim 仅用于展示/审计，权限判定实时查询权限集）
  const roleRows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(eq(userRoles.user_id, user.id));

  const jwtRole = roleRows.find((r) => r.name === "admin")?.name ??
    roleRows.find((r) => r.name === "user")?.name ??
    "user";

  // 响应中的 is_admin 展示字段：权限集（含继承）是否含 admin:full_access
  const isAdmin = await isUserAdmin(user.id);

  // 签发 JWT（不携带 is_admin claim，权限判定实时查询）
  const token = await signToken({
    sub: user.id,
    role: jwtRole,
    must_change_password: user.must_change_password,
  });

  // PR-2 审计：登录成功
  await logAuthEvent(
    user.id,
    clientIp ?? "unknown",
    "auth.login_success",
    {
      user_id: user.id,
      login: input.login,
    },
  );

  return {
    user: toUserResponse(user, { activeBan: activeBan[0] ?? null, isAdmin }),
    token,
  };
}
