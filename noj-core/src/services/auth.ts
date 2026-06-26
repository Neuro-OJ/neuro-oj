import { and, eq, not, or, sql } from "drizzle-orm";
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
 * 密码强度校验最小长度。
 *
 * OWASP 2025+ 建议密码至少 12 字符，比 8 字符的破解空间大 1000+ 倍。
 * 当前 bcrypt cost 12 下，12 字符的强密码在 GPU 集群上仍需数年才能爆破。
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * 校验密码强度。
 *
 * 规则：
 * 1. 长度 >= 12 字符
 * 2. 至少包含一个小写字母
 * 3. 至少包含一个大写字母
 * 4. 至少包含一个数字
 * 5. 不能与用户名相同（不区分大小写）
 * 6. 不能与邮箱前缀相同
 *
 * 修复 issue 64 评论 §6.5：原校验仅 length >= 8，
 * 弱密码（"12345678"、"password"）可通过。
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
 * @throws {BadRequestError} 密码不符合强度要求
 * @throws {ConflictError} 用户名或邮箱已存在
 */
export async function registerUser(
  input: RegisterInput,
): Promise<UserResponse> {
  // 密码强度校验（issue 64 评论 §6.5）
  validatePasswordStrength(input.password, input.username, input.email);

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
 * @param targetUserId 目标用户 ID
 * @param role 目标角色（"admin" | "user"）
 * @param currentUserId 当前操作用户 ID——禁止管理员撤销自己的权限
 * @throws {NotFoundError} 目标用户不存在
 * @throws {BadRequestError} 非法的角色值 或 操作自己的角色
 */
export async function promoteUser(
  targetUserId: string,
  role: string,
  currentUserId?: string,
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

  // 防止最后一个管理员误操作导致系统无管理员
  if (currentUserId && targetUserId === currentUserId) {
    throw new BadRequestError("不能修改自己的角色");
  }

  // 防止降级最后一个可登录 admin：
  // - 若目标是 admin 且本次操作降级为 user
  // - 且当前系统中仅有 1 个 admin（含目标）
  // 则拒绝，防止系统进入无 admin 状态。
  // 注意：root 系统用户（id='0'，PR #63 引入）虽然 role='admin' 但不可登录，
  // 因此不计入"可登录 admin"统计。
  if (existing[0].role === "admin" && role === "user") {
    const [adminCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "admin"), not(eq(users.id, "0"))));
    const adminCount = Number(adminCountRow?.count ?? 0);
    if (adminCount <= 1) {
      throw new BadRequestError(
        "系统当前仅有 1 个可登录管理员，不能降级；如需调整请先创建新的管理员账户",
      );
    }
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

/**
 * 管理员获取用户列表（分页，排除 root 系统用户）。
 * 返回用户基本信息，不含密码哈希。
 */
export async function listUsers(
  opts: { page: number; perPage: number },
): Promise<
  {
    data: UserResponse[];
    pagination: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
  }
> {
  const db = getDb();
  const offset = (opts.page - 1) * opts.perPage;

  // 排除 root 系统用户（id='0'）
  const excludeRoot = (u: typeof users) => sql`${u.id} <> '0'`;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        created_at: users.created_at,
        updated_at: users.updated_at,
      })
      .from(users)
      .where(excludeRoot(users))
      .orderBy(users.created_at)
      .limit(opts.perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(excludeRoot(users)),
  ]);

  const total = Number(countResult[0]?.count ?? 0);
  const totalPages = Math.ceil(total / opts.perPage);

  return {
    data: rows,
    pagination: {
      page: opts.page,
      per_page: opts.perPage,
      total,
      total_pages: totalPages,
    },
  };
}

/**
 * 确保 root 系统用户存在。
 * 在应用启动时调用，若 users 表中不存在 id='0' 则自动创建。
 * root 用户为 admin 角色，密码随机生成，不可登录，不在用户列表中显示。
 */
export async function ensureRootUser(): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, "0"))
    .limit(1);

  if (existing.length > 0) return;

  const randomPassword = crypto.randomUUID();
  const { hashPassword } = await import("../lib/password.ts");
  const now = new Date().toISOString();

  await db.insert(users)
    .values({
      id: "0",
      username: "root",
      email: "root@noj.local",
      password_hash: await hashPassword(randomPassword),
      role: "admin",
      bio: "系统根用户",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();

  console.log("Root 系统用户 (UID=0) 已创建（或已存在）");
}
