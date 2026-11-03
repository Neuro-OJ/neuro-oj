import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { parsePlatformRole } from "../../../../shared/access/roles.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import { enqueueSearchIndexTaskTx } from "../../../application/search-tasks.ts";
import { validatePasswordStrength } from "./auth/auth-register.ts";
import { hashTemporaryPassword, passwordUpdate } from "./security/password.ts";

/** 仅在操作响应中返回的初始凭据，不写入日志或持久存储。 */
export interface InitialCredential {
  id: string;
  username: string;
  email: string;
  password: string;
}

/** 批量导入行号从 1 开始，不包含 CSV 表头。 */
export interface AccountRowError {
  row: number;
  reason: string;
}

function invalidRows(errors: AccountRowError[]): never {
  throw new BadRequestError(
    "账号校验失败，整批未写入",
    "ACCOUNT_IMPORT_INVALID",
    { errors },
  );
}

/** 生成含大小写及数字的临时密码，使用密码学安全随机源。 */
function temporaryPassword(username: string, email: string): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const password = "Aa7!" +
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (
      password.toLowerCase() !== username.toLowerCase() &&
      password.toLowerCase() !== email.split("@")[0].toLowerCase()
    ) {
      return password;
    }
  }
}

/**
 * 管理员单建和批量导入共用的原子开号流程。
 * 先完整校验，再计算哈希；并发唯一约束冲突也使整个事务回滚。
 * role 只接受单值 user/admin；缺省与公开注册一样分配 user。
 */
export async function createAdminAccounts(
  input: unknown,
  role?: unknown,
): Promise<InitialCredential[]> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 500) {
    throw new BadRequestError("users 必须为包含 1-500 行的数组");
  }
  // 角色是单值平台角色；数组、未知值或旧角色 ID 一律 400。
  const platformRole = role === undefined ? "user" : parsePlatformRole(role);
  const errors: AccountRowError[] = [];
  const names = new Map<string, number>();
  const emails = new Map<string, number>();
  const prepared: InitialCredential[] = [];
  const sourceRows: number[] = [];
  for (const [index, value] of input.entries()) {
    const row = index + 1;
    const fail = (reason: string) => errors.push({ row, reason });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("账号必须为对象");
      continue;
    }
    const { username, email: suppliedEmail, password: suppliedPassword } =
      value;
    if (
      typeof username !== "string" || !/^[a-zA-Z0-9_]{3,30}$/.test(username)
    ) {
      fail("用户名仅允许字母、数字和下划线，长度 3-30");
    }
    if (suppliedEmail !== undefined && typeof suppliedEmail !== "string") {
      fail("邮箱必须为字符串");
    }
    if (
      suppliedPassword !== undefined && typeof suppliedPassword !== "string"
    ) fail("密码必须为字符串");
    if (
      typeof username !== "string" ||
      (suppliedEmail !== undefined && typeof suppliedEmail !== "string") ||
      (suppliedPassword !== undefined && typeof suppliedPassword !== "string")
    ) continue;
    const email = suppliedEmail ||
      `${username}.${
        crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      }@users.noj.invalid`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("邮箱格式不正确");
    if (names.has(username)) fail(`用户名与第 ${names.get(username)} 行重复`);
    if (emails.has(email)) fail(`邮箱与第 ${emails.get(email)} 行重复`);
    names.set(username, names.get(username) ?? row);
    emails.set(email, emails.get(email) ?? row);
    const password = suppliedPassword || temporaryPassword(username, email);
    try {
      validatePasswordStrength(password, username, email);
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
      fail(error.message);
    }
    prepared.push({ id: crypto.randomUUID(), username, email, password });
    sourceRows.push(row);
  }

  const db = getDb();
  if (prepared.length) {
    const existing = await db.select({
      username: users.username,
      email: users.email,
    }).from(users).where(or(
      inArray(users.username, prepared.map((item) => item.username)),
      inArray(users.email, prepared.map((item) => item.email)),
    ));
    for (const user of existing) {
      for (const [index, value] of prepared.entries()) {
        if (value.username === user.username) {
          errors.push({ row: sourceRows[index], reason: "用户名已存在" });
        }
        if (value.email === user.email) {
          errors.push({ row: sourceRows[index], reason: "邮箱已被注册" });
        }
      }
    }
  }
  if (errors.length) invalidRows(errors.sort((a, b) => a.row - b.row));

  // 必须在写入前完成所有密码哈希，避免长时间占用数据库事务。
  const now = new Date().toISOString();
  const inserts: (typeof users.$inferInsert)[] = [];
  for (const user of prepared) {
    inserts.push({
      id: user.id,
      username: user.username,
      email: user.email,
      password_hash: await hashTemporaryPassword(user.password),
      must_change_password: true,
      email_verified: true,
      role: platformRole,
      created_at: now,
      updated_at: now,
    });
  }
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(users).values(inserts)
      .onConflictDoNothing().returning({ id: users.id });
    if (inserted.length !== prepared.length) {
      const ids = new Set(inserted.map((item) => item.id));
      invalidRows(
        prepared.flatMap((item, index) =>
          ids.has(item.id) ? [] : [{
            row: sourceRows[index],
            reason: "用户名或邮箱已被其他请求占用，请重新校验",
          }]
        ),
      );
    }
    for (const item of prepared) {
      await enqueueSearchIndexTaskTx(tx, "user", item.id, "upsert", item.id);
    }
  });
  return prepared;
}

/** 管理员重置密码，原子更新凭据和会话版本，并保护 root 与已注销账号。 */
export async function adminResetPassword(
  userId: string,
  suppliedPassword?: unknown,
): Promise<InitialCredential> {
  if (userId === ROOT_USER_ID) {
    throw new ForbiddenError("不能重置 root 系统用户的密码");
  }
  if (suppliedPassword !== undefined && typeof suppliedPassword !== "string") {
    throw new BadRequestError("密码必须为字符串");
  }
  const db = getDb();
  const [user] = await db.select().from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  ).limit(1);
  if (!user) throw new NotFoundError("用户不存在或已注销");
  const password = suppliedPassword ||
    temporaryPassword(user.username, user.email);
  validatePasswordStrength(password, user.username, user.email);
  const [updated] = await db.update(users).set(
    passwordUpdate(await hashTemporaryPassword(password), true),
  )
    .where(and(eq(users.id, userId), isNull(users.deleted_at))).returning({
      id: users.id,
    });
  if (!updated) throw new NotFoundError("用户不存在或已注销");
  return { id: user.id, username: user.username, email: user.email, password };
}
