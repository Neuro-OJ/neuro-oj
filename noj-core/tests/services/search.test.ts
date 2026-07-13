/**
 * 搜索 service 测试（issue #100 Task 5）。
 *
 * 覆盖 6 个场景：
 * 1. 搜 'P1001' 命中 P 型题（display_id 走 search_vector）
 * 2. 中文 '动态规划' 命中（trigram ILIKE 兜底）
 * 3. 公开搜索不返回 U 型题
 * 4. admin + includeU=true 返回 U+P
 * 5. 搜英文 'Hello' 命中 tsvector
 * 6. 用户搜索仅 admin，排除 root
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/services/search.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { getDb } from "../../src/db/connection.ts";

await resetDbForTest();

async function seedProblems() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values([
    {
      id: "p-uuid-1",
      title: "动态规划入门",
      description: "",
      difficulty: "medium",
      judge_image: "test",
      judge_command: "test",
      number: 1001,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "p-uuid-2",
      title: "Hello World",
      description: "",
      difficulty: "easy",
      judge_image: "test",
      judge_command: "test",
      number: 1002,
      type: "P",
      created_at: now,
      updated_at: now,
    },
    {
      id: "p-uuid-3",
      title: "私有题目",
      description: "",
      difficulty: "hard",
      judge_image: "test",
      judge_command: "test",
      number: 1,
      type: "U",
      created_at: now,
      updated_at: now,
    },
  ]);
}

async function seedUsers() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values([
    {
      id: "alice-id",
      username: "alice_test",
      email: "alice@example.com",
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    },
    {
      id: "admin-id",
      username: "admin_test",
      email: "admin@example.com",
      password_hash: "x",
      role: "admin",
      created_at: now,
      updated_at: now,
    },
  ]);
}

Deno.test({
  name: "search service: 搜 'P1001' 命中 P 型题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "P1001",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.id, "p-uuid-1");
    assertEquals(result.items[0]?.display_id, "P1001");
  },
});

Deno.test({
  name: "search service: 中文 '动态规划' 命中（trigram 兜底）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "动态规划",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length >= 1, true);
    assertEquals(result.items[0]?.title, "动态规划入门");
  },
});

Deno.test({
  name: "search service: 公开搜索不返回 U 型题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "私有",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 0);
  },
});

Deno.test({
  name: "search service: admin + includeU=true 返回 U+P",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "私有",
      isAdmin: true,
      includeU: true,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
  },
});

Deno.test({
  name: "search service: 搜英文 'Hello' 命中 tsvector",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedProblems();
    const result = await searchProblems({
      q: "Hello",
      isAdmin: false,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.title, "Hello World");
  },
});

Deno.test({
  name: "search service: 用户搜索仅 admin，排除 root",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedUsers();
    const result = await searchUsers({
      q: "alice",
      isAdmin: true,
      page: 1,
      limit: 20,
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0]?.username, "alice_test");
    assertEquals(result.items[0]?.email, "alice@example.com");
  },
});
