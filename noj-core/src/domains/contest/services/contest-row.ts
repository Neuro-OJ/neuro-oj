import { eq } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import { contests } from "../../../db/schema.ts";
import { NotFoundError } from "./../../../shared/base/errors.ts";

/**
 * 按内部竞赛 UUID 查询竞赛数据行，不存在时抛错。
 *
 * @param id 竞赛 UUID
 * @returns 竞赛数据行
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function findContestRow(id: string) {
  const db = getDb();
  const [row] = await db.select().from(contests).where(eq(contests.id, id))
    .limit(
      1,
    );
  if (!row) {
    throw new NotFoundError("竞赛不存在");
  }
  return row;
}
