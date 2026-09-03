import { eq } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { users } from "../../../../db/schema.ts";
import { logger } from "./../../../../shared/base/logging.ts";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";

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
  const { hashPassword } = await import("../../../../lib/password.ts");
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
