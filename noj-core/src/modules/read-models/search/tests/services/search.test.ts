import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { problems, users } from "../../../../../shared/db/schema.ts";
import { upsertSearchEntry } from "../../services/index-writer.ts";
import {
  buildProblemEntry,
  buildUserEntry,
} from "../../services/index-writer.ts";
import { searchFlat, searchGrouped } from "../../services/search.ts";

import { publishAllProblemsForTest } from "../../../../../../tests/helper.ts";
import { backfillDefaultCatalog } from "../../../../problems/index.ts";

await resetDbForTest();

async function seed() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
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
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(users).values({
    id: "u-search-1",
    username: "alice",
    email: "alice@example.com",
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  // 夹具题目必须"已发布"才入索引（Handbook §6.6）
  await publishAllProblemsForTest();
  await backfillDefaultCatalog();
  await upsertSearchEntry((await buildProblemEntry("p-search-1"))!);
  await upsertSearchEntry((await buildUserEntry("u-search-1"))!);
}

Deno.test({
  name: "search service: grouped 返回题目且匿名可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchGrouped({
      q: "动态",
      types: ["problem", "user"],
      perType: 5,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(result.groups.problem.items.length, 1);
    assertEquals(result.groups.user.items.length, 0);
  },
});

Deno.test({
  name: "search service: flat 管理员可搜用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seed();
    const result = await searchFlat({
      q: "alice",
      type: "user",
      page: 1,
      perPage: 20,
      ctx: { userId: "admin", isAdmin: true, guestReadEnabled: true },
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.entity_type, "user");
  },
});

Deno.test({
  name: "search service: literal % 不触发 LIKE 通配",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values([
      {
        domain_id: DEFAULT_DOMAIN_ID,
        id: "p-percent-1",
        title: "50%off",
        description: "促销",
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "x",
            command: "x",
            time_limit_ms: 1000,
            memory_limit_mb: 128,
          },
          solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
        },
        number: 10,
        visibility: "public",
        created_at: now,
        updated_at: now,
      },
      {
        domain_id: DEFAULT_DOMAIN_ID,
        id: "p-percent-2",
        title: "50off",
        description: "促销",
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "x",
            command: "x",
            time_limit_ms: 1000,
            memory_limit_mb: 128,
          },
          solution: { image: "x", call_timeout_ms: 1000, memory_limit_mb: 128 },
        },
        number: 11,
        visibility: "public",
        created_at: now,
        updated_at: now,
      },
    ]);
    await publishAllProblemsForTest();
    await backfillDefaultCatalog();
    await upsertSearchEntry((await buildProblemEntry("p-percent-1"))!);
    await upsertSearchEntry((await buildProblemEntry("p-percent-2"))!);
    const result = await searchFlat({
      q: "50%off",
      type: "problem",
      page: 1,
      perPage: 20,
      ctx: { userId: undefined, isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.entity_id, "p-percent-1");
  },
});
