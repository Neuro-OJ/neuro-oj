/**
 * 回填存量数据的 public_id。
 *
 * 用法：
 *   deno run -A --env-file=.env scripts/backfill-public-ids.ts
 *
 * 幂等：已有 public_id 的行跳过；唯一冲突时重试。
 */

import { eq } from "drizzle-orm";
import { closeDbForShutdown, getDb } from "./../src/shared/db/connection.ts";
import {
  announcements,
  communityPosts,
  contests,
  submissions,
  trainings,
} from "./../src/shared/db/schema.ts";
import { generatePublicId } from "../src/lib/public-id.ts";

async function backfillOne(
  // deno-lint-ignore no-explicit-any
  table: any,
  prefix: string,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: table.id, public_id: table.public_id })
    .from(table);
  for (const row of rows) {
    if (row.public_id) continue;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generatePublicId(prefix);
      try {
        await db
          .update(table)
          .set({ public_id: candidate })
          .where(eq(table.id, row.id));
        break;
      } catch (err) {
        // 唯一冲突则重试；其它错误直接抛出
        if (!String(err).includes("23505")) throw err;
      }
    }
  }
}

export async function backfillAll(): Promise<void> {
  await backfillOne(contests, "ct");
  await backfillOne(trainings, "tr");
  await backfillOne(submissions, "sub");
  await backfillOne(communityPosts, "post");
  await backfillOne(announcements, "ann");
}

if (import.meta.main) {
  await backfillAll();
  console.log("backfill done");
  await closeDbForShutdown();
}
