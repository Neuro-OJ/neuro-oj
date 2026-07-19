/**
 * 搜索 service 测试（issue #100 Task 5 + reviewer 修复）。
 *
 * 覆盖 8 个场景：
 * 1. 搜 'P1001' 命中 P 型题（display_id 走 search_vector）
 * 2. 中文 '动态规划' 命中（trigram ILIKE 兜底）
 * 3. 公开搜索不返回 U 型题
 * 4. admin + includeU=true 返回 U+P
 * 5. 搜英文 'Hello' 命中 tsvector
 * 6. 用户搜索仅 admin（root 排除由测试 7 单独验证）
 * 7. 用户搜索排除 root（seed 含 root，断言 result 中无 id='0'）
 * 8. searchUsers admin 守卫：isAdmin=false 抛 ForbiddenError
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { searchProblems, searchUsers } from "../../src/services/search.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { getDb } from "../../src/db/connection.ts";
import { ForbiddenError } from "../../src/lib/errors.ts";

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
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
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
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
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
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
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
  // reviewer issue 1：root 用户（id='0'）由 _setup.ts 建表时种入。
  // 这里显式 upsert 一下，确保 username='root' / email='root@noj.local' 与 service
  // 期望一致（_setup.ts 已经种了相同 id='0'，onConflictDoNothing 跳过）。
  await db
    .insert(users)
    .values({
      id: "0",
      username: "root",
      email: "root@noj.local",
      password_hash: "x",
      role: "admin",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
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

Deno.test({
  name: "search service: 用户搜索排除 root（reviewer issue 1）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedUsers();
    // 搜 "root" 既可能匹配 root 用户，也可能匹配其他含 'root' 字样的。
    // 这里用宽查询 'a' 来确认 root（username='root'）从不被返回。
    const result = await searchUsers({
      q: "a",
      isAdmin: true,
      page: 1,
      limit: 20,
    });
    // 关键断言：root 用户（id='0'）必须被排除
    const root = result.items.find((i) => i.id === "0");
    assertEquals(root, undefined);
    // 同时验证 alice / admin 两个非 root 用户都能命中
    const usernames = result.items.map((i) => i.username).sort();
    assertEquals(usernames.includes("alice_test"), true);
    assertEquals(usernames.includes("admin_test"), true);
  },
});

Deno.test({
  name: "search service: searchUsers admin 守卫（reviewer issue 3）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await seedUsers();
    // isAdmin=false 时 service 层兜底抛 ForbiddenError（fail-closed）
    await assertRejects(
      () =>
        searchUsers({
          q: "alice",
          isAdmin: false,
          page: 1,
          limit: 20,
        }),
      ForbiddenError,
      "用户搜索仅限管理员",
    );
  },
});
