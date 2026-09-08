import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "../../../../shared/search-events.ts";
import {
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import {
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";
import { ADMIN_INITIALIZATION_KEY } from "../../../../shared/security/admin-initialization.ts";
import { hashPassword } from "../security/password.ts";
import { validatePasswordStrength } from "./auth-register.ts";
import type { RegisterInput } from "../../types/auth.ts";

/** 升级已有站点时永久关闭首次初始化；不改变任何用户权限。 */
export async function sealExistingSiteAdminInitialization(): Promise<void> {
  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users)
    .where(ne(users.id, ROOT_USER_ID)).limit(1);
  if (existing) {
    await db.insert(systemSettings).values({
      key: ADMIN_INITIALIZATION_KEY,
      value: "true",
      updated_at: new Date().toISOString(),
    }).onConflictDoNothing();
  }
}

/**
 * 仅供服务器本机 CLI 调用的一次性管理员初始化，不挂载 HTTP 路由。
 * 数据库唯一键将并发初始化与公开注册串行化；用户、角色和关闭标记原子提交。
 * 已有用户时只提交关闭标记，不创建或提升用户。密码不写入日志。
 */
export async function initializeFirstAdmin(
  input: RegisterInput,
): Promise<void> {
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(input.username)) {
    throw new BadRequestError("用户名仅允许字母、数字和下划线，长度 3-30");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw new BadRequestError("邮箱格式不正确");
  }
  validatePasswordStrength(input.password, input.username, input.email);
  const passwordHash = await hashPassword(input.password);
  const db = getDb();
  let createdUserId: string | undefined;
  const initialized = await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const claimed = await tx.insert(systemSettings).values({
      key: ADMIN_INITIALIZATION_KEY,
      value: "true",
      updated_at: now,
    }).onConflictDoNothing().returning({ key: systemSettings.key });
    if (claimed.length === 0) return false;
    const [existing] = await tx.select({ id: users.id }).from(users)
      .where(ne(users.id, ROOT_USER_ID)).limit(1);
    if (existing) return false;
    const [adminRole] = await tx.select({ id: roles.id }).from(roles)
      .where(eq(roles.name, "admin")).limit(1);
    if (!adminRole) {
      throw new BadRequestError("请先执行 init system 初始化系统角色");
    }
    const id = crypto.randomUUID();
    await tx.insert(users).values({
      id,
      username: input.username,
      email: input.email,
      password_hash: passwordHash,
      email_verified: false,
      must_change_password: true,
      created_at: now,
      updated_at: now,
    });
    await tx.insert(userRoles).values({ user_id: id, role_id: adminRole.id });
    createdUserId = id;
    return true;
  });
  if (!initialized) {
    throw new ConflictError(
      "首次管理员初始化已关闭：站点已有用户或已完成初始化",
    );
  }
  if (createdUserId) {
    await publishSearchIndexEvent("user", createdUserId, "upsert");
  }
}
