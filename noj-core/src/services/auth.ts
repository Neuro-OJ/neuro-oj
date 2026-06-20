import { eq, or } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { users } from "../db/schema.ts";
import { comparePassword, hashPassword } from "../lib/password.ts";
import { signToken } from "../lib/jwt.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../lib/errors.ts";
import type { LoginInput, RegisterInput, UserResponse } from "../types/auth.ts";

/**
 * 将数据库行转换为公开的用户响应。
 * 排除 password_hash 等敏感字段。
 */
function toUserResponse(row: typeof users.$inferSelect): UserResponse {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 注册新用户。
 * 检查用户名和邮箱的唯一性，密码使用 bcrypt 哈希后存储。
 *
 * @throws {ConflictError} 用户名或邮箱已存在
 */
export async function registerUser(
  input: RegisterInput,
): Promise<UserResponse> {
  const db = getDb();

  // 检查用户名是否已存在
  const existingUsername = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);

  if (existingUsername.length > 0) {
    throw new ConflictError("用户名已存在");
  }

  // 检查邮箱是否已注册
  const existingEmail = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existingEmail.length > 0) {
    throw new ConflictError("邮箱已被注册");
  }

  // 哈希密码
  const passwordHash = await hashPassword(input.password);

  // 创建用户
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    username: input.username,
    email: input.email,
    password_hash: passwordHash,
    role: "user",
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    username: input.username,
    email: input.email,
    role: "user",
    created_at: now,
    updated_at: now,
  };
}

/**
 * 用户登录。
 * 通过用户名或邮箱查找用户，验证密码，签发 JWT。
 *
 * 为防用户枚举，不区分"用户不存在"和"密码错误"，统一返回 401。
 *
 * @throws {UnauthorizedError} 用户名/邮箱不存在或密码错误
 */
export async function loginUser(
  input: LoginInput,
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
    throw new UnauthorizedError("用户名或密码错误");
  }

  const user = existing[0];

  // 验证密码
  const valid = await comparePassword(input.password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError("用户名或密码错误");
  }

  // 签发 JWT
  const token = await signToken({ sub: user.id, role: user.role });

  return {
    user: toUserResponse(user),
    token,
  };
}

/**
 * 根据用户 ID 获取用户信息。
 *
 * @throws {UnauthorizedError} 用户不存在
 */
export async function getUserProfile(
  userId: string,
): Promise<UserResponse> {
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (existing.length === 0) {
    throw new UnauthorizedError("用户不存在");
  }

  return toUserResponse(existing[0]);
}

/**
 * 管理员提升/降级用户角色。
 * 仅允许在 "admin" 和 "user" 之间切换。
 *
 * @throws {NotFoundError} 目标用户不存在
 * @throws {BadRequestError} 非法的角色值
 */
export async function promoteUser(
  targetUserId: string,
  role: string,
): Promise<UserResponse> {
  const db = getDb();

  if (role !== "admin" && role !== "user") {
    throw new BadRequestError("角色值非法，仅允许 admin 或 user");
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }

  const now = new Date().toISOString();
  await db
    .update(users)
    .set({ role, updated_at: now })
    .where(eq(users.id, targetUserId));

  return {
    id: existing[0].id,
    username: existing[0].username,
    email: existing[0].email,
    role,
    created_at: existing[0].created_at,
    updated_at: now,
  };
}
