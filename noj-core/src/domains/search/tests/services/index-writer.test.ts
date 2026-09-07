import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import {
  buildProblemEntry,
  buildUserEntry,
  deleteSearchEntry,
  processSearchIndexEvent,
  upsertSearchEntry,
} from "../../services/index-writer.ts";
import { searchEntries } from "../../../../shared/db/schema.ts";
import { sql } from "drizzle-orm";

await resetDbForTest();

Deno.test({
  name: "index-writer: upsert 后可按 entity 查到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: "p-search-1",
      title: "动态规划",
      description: "入门",
      difficulty: "medium",
      runtime_config: {
        evaluator: {
          image: "x",
          command: "x",
          time_limit_ms: 1000,
          memory_limit_mb: 128,
        },
        solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
      },
      number: 1,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildProblemEntry("p-search-1");
    assertEquals(entry !== null, true);
    await upsertSearchEntry(entry!);
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'problem' AND ${searchEntries.entity_id} = 'p-search-1'`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.title, "动态规划");
  },
});

Deno.test({
  name: "index-writer: delete 后条目消失",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-1",
      username: "alice",
      email: "alice@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const entry = await buildUserEntry("u-search-1");
    await upsertSearchEntry(entry!);
    await deleteSearchEntry("user", "u-search-1");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-1'`,
    );
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "index-writer: processSearchIndexEvent delete 时源仍存在则转 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u-search-2",
      username: "bob",
      email: "bob@example.com",
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    await processSearchIndexEvent("user", "u-search-2", "delete");
    const rows = await db.select().from(searchEntries).where(
      sql`${searchEntries.entity_type} = 'user' AND ${searchEntries.entity_id} = 'u-search-2'`,
    );
    assertEquals(rows.length, 1);
  },
});
