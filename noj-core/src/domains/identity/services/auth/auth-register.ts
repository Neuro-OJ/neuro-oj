import { eq, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { roles, userRoles, users } from "../../../../db/schema.ts";
import { hashPassword } from "../../../../lib/password.ts";
import { logAuthEvent } from "../../../system/index.ts";
import { BadRequestError, ConflictError } from "../../../../lib/errors.ts";
import type { RegisterInput, UserResponse } from "../../../../types/auth.ts";
import { ROOT_USER_ID } from "../../../../lib/constants.ts";

/**
 * 注册首个真实用户时使用的事务级锁键。
 *
 * 只有在当前数据库还没有真实用户时才会尝试获取该锁；拿到锁后会再次
 * 检查用户数量，避免两个并发注册请求同时成为管理员。
 */
const FIRST_USER_ADMIN_LOCK_KEY = 20260829;

/**
 * 密码强度校验最小长度。
 *
 * 当前认证策略统一要求至少 8 字符，并作为路由预检与注册、改密、重置密码
 * 强度校验的共同基准；其余规则（大小写 + 数字 + 不能与用户/邮箱前缀相同）
 * 仍提供基本的强度保证。
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 校验密码强度。
 *
 * 规则：
 * 1. 长度 >= 8 字符
 * 2. 至少包含一个小写字母
 * 3. 至少包含一个大写字母
 * 4. 至少包含一个数字
 * 5. 不能与用户名相同（不区分大小写）
 * 6. 不能与邮箱前缀相同
 *
 * @throws {BadRequestError} 不符合任一规则
 */
export function validatePasswordStrength(
  password: string,
  username: string,
  email: string,
): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `密码长度不足（当前 ${password.length} 字符，至少需要 ${MIN_PASSWORD_LENGTH} 字符）`,
    );
  }
  if (!/[a-z]/.test(password)) {
    throw new BadRequestError("密码必须包含至少一个小写字母");
  }
  if (!/[A-Z]/.test(password)) {
    throw new BadRequestError("密码必须包含至少一个大写字母");
  }
  if (!/[0-9]/.test(password)) {
    throw new BadRequestError("密码必须包含至少一个数字");
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    throw new BadRequestError("密码不能与用户名相同");
  }
  const emailPrefix = email.split("@")[0]?.toLowerCase() ?? "";
  if (emailPrefix && password.toLowerCase() === emailPrefix) {
    throw new BadRequestError("密码不能与邮箱前缀相同");
  }
}

/**
 * 将数据库行转换为公开的用户响应。
 * 排除 password_hash 等敏感字段。
 */
export function toUserResponse(
  row: typeof users.$inferSelect,
  options?: {
    activeBan?: { reason: string; banned_until: string | null } | null;
    isAdmin?: boolean;
  },
): UserResponse {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    is_admin: options?.isAdmin ?? false,
    has_local_password: row.password_hash !== null,
    must_change_password: row.must_change_password,
    active_ban: options?.activeBan ?? null,
    avatar_url: row.avatar_url ?? null,
    tfa_enabled: row.tfa_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 将数据库唯一约束冲突转换为用户可理解的业务错误。
 *
 * PostgreSQL 通常把 code/constraint 直接放在错误对象上，PGlite
 * 可能把它们放在 cause 中；两种结构都需要兼容。无法识别具体约束时
 * 仍返回 409，但不向客户端暴露数据库错误详情。
 */
function conflictFromUniqueViolation(err: unknown): ConflictError | null {
  if (!err || typeof err !== "object") return null;

  const error = err as Record<string, unknown>;
  const cause = error.cause && typeof error.cause === "object"
    ? error.cause as Record<string, unknown>
    : undefined;
  const code = error.code ?? cause?.code;
  if (code !== "23505") return null;

  const constraint = String(
    error.constraint ?? error.constraint_name ??
      cause?.constraint ?? cause?.constraint_name ?? "",
  );
  if (constraint.includes("username")) {
    return new ConflictError("用户名已存在");
  }
  if (constraint.includes("email")) {
    return new ConflictError("邮箱已被注册");
  }

  return new ConflictError("用户名或邮箱已存在");
}

/**
 * 注册新用户。
 * 检查用户名和邮箱的唯一性，密码使用 bcrypt 哈希后存储。
 *
 * @throws {BadRequestError} 密码不符合强度要求
 * @throws {ConflictError} 用户名或邮箱已存在
 */
export async function registerUser(
  input: RegisterInput,
  clientIp?: string,
): Promise<UserResponse> {
  // 密码强度校验（issue 64 评论 §6.5）
  validatePasswordStrength(input.password, input.username, input.email);

  const db = getDb();

  // 哈希密码
  const passwordHash = await hashPassword(input.password);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let isFirstRealUser = false;

  await db.transaction(async (tx) => {
    // 检查用户名是否已存在
    const existingUsername = await tx
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);

    if (existingUsername.length > 0) {
      throw new ConflictError("用户名已存在");
    }

    // 检查邮箱是否已注册
    const existingEmail = await tx
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (existingEmail.length > 0) {
      throw new ConflictError("邮箱已被注册");
    }

    // 快速路径：已有真实用户时不必获取全局注册锁。
    let realUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(ne(users.id, ROOT_USER_ID))
      .limit(1);

    if (realUsers.length === 0) {
      // 慢速路径：锁住“首个用户”判断，再次查询以处理并发注册。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${FIRST_USER_ADMIN_LOCK_KEY})`,
      );
      realUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(ne(users.id, ROOT_USER_ID))
        .limit(1);
      isFirstRealUser = realUsers.length === 0;
    }

    await tx.insert(users).values({
      id,
      username: input.username,
      email: input.email,
      password_hash: passwordHash,
      created_at: now,
      updated_at: now,
    });

    const roleName = isFirstRealUser ? "admin" : "user";
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, roleName))
      .limit(1);

    if (!role) {
      throw new Error(`注册所需角色不存在：${roleName}`);
    }

    await tx.insert(userRoles).values({
      user_id: id,
      role_id: role.id,
    }).onConflictDoNothing();
  }).catch((err) => {
    const conflict = conflictFromUniqueViolation(err);
    if (conflict) throw conflict;
    throw err;
  });

  // PR-2 审计：注册成功
  await logAuthEvent(
    id,
    clientIp ?? "unknown",
    "auth.register",
    {
      user_id: id,
      username: input.username,
      email: input.email,
      is_admin: isFirstRealUser,
    },
  );

  return {
    id,
    username: input.username,
    email: input.email,
    is_admin: isFirstRealUser,
    has_local_password: true,
    must_change_password: false,
    active_ban: null,
    avatar_url: null,
    tfa_enabled: false,
    created_at: now,
    updated_at: now,
  };
}
