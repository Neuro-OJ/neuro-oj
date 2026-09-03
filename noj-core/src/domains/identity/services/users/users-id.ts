import { eq } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { users } from "./../../../../shared/db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { isUuid } from "./../../../../shared/security/public-id.ts";

/** 将 UUID、username 或旧主键解析为内部用户 UUID。 */
export async function resolveUserId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  const byName = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, value)).limit(1);
  if (byName[0]) return byName[0].id;
  const byId = await db.select({ id: users.id }).from(users)
    .where(eq(users.id, value)).limit(1);
  if (!byId[0]) throw new NotFoundError("用户不存在");
  return byId[0].id;
}
