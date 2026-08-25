import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import { users } from "../../db/schema.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/public-id.ts";

/** 将 UUID 或 username 解析为内部用户 UUID。 */
export async function resolveUserId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  const rows = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, value)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("用户不存在");
  return row.id;
}
