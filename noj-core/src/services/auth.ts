import {
  and,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { roles, userBans, userRoles, users } from "../db/schema.ts";
import { comparePassword, hashPassword } from "../lib/password.ts";
import { getAdminUserIds, isUserAdmin } from "../lib/permissions.ts";
import { signToken } from "../lib/jwt.ts";
import { logAuthEvent } from "./audit-log.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from "../lib/errors.ts";
import type { LoginInput, RegisterInput, UserResponse } from "../types/auth.ts";
import { isBannedIp } from "../lib/cidr.ts";
import { getBannedRanges } from "./banlist.ts";
import { logger } from "../lib/logging.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";

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
function toUserResponse(
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
    must_change_password: row.must_change_password,
    active_ban: options?.activeBan ?? null,
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
  clientIp?: string,
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
    created_at: now,
    updated_at: now,
  });

  // 分配默认角色（is_default=true 的角色）
  const [defaultRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.is_default, true))
    .limit(1);

  if (defaultRole) {
    await db.insert(userRoles).values({
      user_id: id,
      role_id: defaultRole.id,
    }).onConflictDoNothing();
  }

  // PR-2 审计：注册成功
  await logAuthEvent(
    id,
    clientIp ?? "unknown",
    "auth.register",
    {
      user_id: id,
      username: input.username,
      email: input.email,
    },
  );

  return {
    id,
    username: input.username,
    email: input.email,
    is_admin: false,
    must_change_password: false,
    active_ban: null,
    created_at: now,
    updated_at: now,
  };
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

  // 验证密码
  const valid = await comparePassword(input.password, user.password_hash);
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
  })
    .from(userBans)
    .where(and(eq(userBans.user_id, user.id), isNull(userBans.unbanned_at)))
    .limit(1);
  if (activeBan.length > 0) {
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

  // is_admin 实时计算（权限集含 admin:full_access，含继承链）
  const isAdmin = await isUserAdmin(userId);

  return toUserResponse(existing[0], { isAdmin });
}

/**
 * 管理员获取用户列表（分页，排除 root 系统用户）。
 * 返回用户基本信息，不含密码哈希。
 *
 * @param opts.keyword 搜索关键词（匹配 username 或 email，ILIKE 模糊搜索）
 * @param opts.isAdmin 按管理员状态筛选（true | false，admin:full_access 权限含继承链）
 * @param opts.from 注册日期范围起始（ISO 字符串）
 * @param opts.to 注册日期范围截止（ISO 字符串）
 */
export async function listUsers(
  opts: {
    page: number;
    perPage: number;
    keyword?: string;
    isAdmin?: boolean;
    from?: string;
    to?: string;
  },
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

  // 构建筛选条件
  const conditions: SQL[] = [];

  // 排除 root 系统用户（id='0'）
  conditions.push(sql`${users.id} <> '0'`);

  // 按管理员状态筛选（admin:full_access 权限，含继承链）
  if (opts.isAdmin !== undefined) {
    const adminIds = await getAdminUserIds();
    if (opts.isAdmin) {
      conditions.push(inArray(users.id, [...adminIds]));
    } else {
      conditions.push(notInArray(users.id, [...adminIds]));
    }
  }

  // 按关键词搜索（username 或 email ILIKE 模糊匹配）
  if (opts.keyword) {
    const kw = `%${opts.keyword}%`;
    // or() 在传参非空时必返回 SQL 实例（类型层面为 optional）
    conditions.push(or(ilike(users.username, kw), ilike(users.email, kw))!);
  }

  // 按注册日期范围筛选
  if (opts.from) {
    conditions.push(gte(users.created_at, opts.from));
  }
  if (opts.to) {
    conditions.push(lte(users.created_at, opts.to));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        must_change_password: users.must_change_password,
        created_at: users.created_at,
        updated_at: users.updated_at,
        // 活跃封禁信息（LEFT JOIN user_bans）
        ban_reason: userBans.reason,
        ban_until: userBans.banned_until,
      })
      .from(users)
      .leftJoin(
        userBans,
        and(eq(userBans.user_id, users.id), isNull(userBans.unbanned_at)),
      )
      .where(where)
      .orderBy(users.created_at)
      .limit(opts.perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(where),
  ]);

  const roleRows = rows.length === 0 ? [] : await db
    .select({ user_id: userRoles.user_id, role_id: userRoles.role_id })
    .from(userRoles)
    .where(inArray(userRoles.user_id, rows.map((row) => row.id)));
  const roleIdsByUser = new Map<string, string[]>();
  for (const roleRow of roleRows) {
    const roleIds = roleIdsByUser.get(roleRow.user_id) ?? [];
    roleIds.push(roleRow.role_id);
    roleIdsByUser.set(roleRow.user_id, roleIds);
  }

  // 本页用户的管理员状态（admin:full_access 权限，含继承链）
  const allAdminIds = await getAdminUserIds();

  const total = Number(countResult[0]?.count ?? 0);
  const totalPages = Math.ceil(total / opts.perPage);

  // 将 LEFT JOIN 结果映射为 UserResponse
  const data = rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role_ids: roleIdsByUser.get(row.id) ?? [],
    is_admin: allAdminIds.has(row.id),
    must_change_password: row.must_change_password,
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_ban: row.ban_reason !== null
      ? { reason: row.ban_reason!, banned_until: row.ban_until }
      : null,
  }));

  return {
    data,
    pagination: {
      page: opts.page,
      per_page: opts.perPage,
      total,
      total_pages: totalPages,
    },
  };
}

/**
 * 修改当前用户密码（issue #75）。
 *
 * 流程：
 * 1. 查询用户
 * 2. **先**验证旧密码（bcrypt 耗时恒定，挡住密码相等性 oracle）
 * 3. 新密码强度校验
 * 4. 拒绝新密码与旧密码相同（评审修复 M2：必须在 comparePassword 之后，
 *    避免攻击者通过响应时间差异推断旧密码长度/字符）
 * 5. 哈希新密码并 UPDATE，同时置 must_change_password=false
 * 6. 返回最新的 UserResponse
 *
 * 注意：旧 JWT 仍有效至自然过期——前端应在成功后清 Cookie 重登
 * （/api/v1/auth/change-password 路由层会清 cookie + 重新登录获取新 token）。
 *
 * @throws {UnauthorizedError} 用户不存在或旧密码错误
 * @throws {BadRequestError} 新密码强度不足或与旧密码相同
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
  clientIp?: string,
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

  const user = existing[0];

  // 1. 先验证旧密码（bcrypt 始终耗时 ~250ms，挡住 oracle）
  //    评审修复 M2：必须先于"新=旧"检查，使两条路径响应时间一致
  const oldValid = await comparePassword(oldPassword, user.password_hash);
  if (!oldValid) {
    throw new UnauthorizedError("旧密码错误");
  }

  // 2. 新密码强度校验（与注册保持一致）
  validatePasswordStrength(newPassword, user.username, user.email);

  // 3. 拒绝新密码与旧密码相同（issue #75 评审 H5）
  //    必须在 comparePassword 之后，避免攻击者通过响应时间差推断新=旧
  if (oldPassword === newPassword) {
    throw new BadRequestError("新密码不能与旧密码相同");
  }

  // 4. 哈希并 UPDATE
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  await db
    .update(users)
    .set({
      password_hash: newHash,
      must_change_password: false,
      updated_at: now,
    })
    .where(eq(users.id, userId));

  // PR-2 审计：改密成功（事务提交后异步写；写失败不影响主业务）
  await logAuthEvent(
    userId,
    clientIp ?? "unknown",
    "auth.change_password",
    { user_id: userId },
  );

  // 查询用户的 admin 状态（权限集含 admin:full_access，含继承）
  const isAdmin = await isUserAdmin(user.id);

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: isAdmin,
    must_change_password: false,
    active_ban: null,
    created_at: user.created_at,
    updated_at: now,
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
    .where(eq(users.id, ROOT_USER_ID))
    .limit(1);

  if (existing.length > 0) return;

  const randomPassword = crypto.randomUUID();
  const { hashPassword } = await import("../lib/password.ts");
  const now = new Date().toISOString();

  await db.insert(users)
    .values({
      id: ROOT_USER_ID,
      username: "root",
      email: "root@noj.local",
      password_hash: await hashPassword(randomPassword),
      bio: "系统根用户",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();

  logger.info("Root 系统用户 (UID=0) 已创建（或已存在）");
}
