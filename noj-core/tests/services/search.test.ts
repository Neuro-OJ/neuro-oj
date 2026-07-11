import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { sql } from "drizzle-orm";
import { searchProblems, searchUsers } from "../../src/services/search.ts";

const ts = Date.now();
const TEST_PROBLEM_ID = `tst-p-${ts}`;
const TEST_USER_ID = `tst-u-${ts}`;

Deno.test({
  name: "search service: setup 插入测试题目与用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();

    await db.insert(problems).values({
      id: TEST_PROBLEM_ID,
      title: "传感器数据滤波",
      description: "去除噪声，平滑数据",
      difficulty: "medium",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      number: 9001,
      type: "U",
      created_at: now,
      updated_at: now,
    });

    await db.insert(users).values({
      id: TEST_USER_ID,
      username: `tstusr-${ts}`,
      email: `tstusr-${ts}@test.noj`,
      password_hash: "hash",
      role: "user",
      bio: "",
      created_at: now,
      updated_at: now,
    });
  },
});

Deno.test({
  name: "search service: trigger 在 INSERT 后填充 search_vector",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    // 直接走 PGlite 实例，避免 Drizzle execute() 在两种驱动下返回结构差异
    const conn = (db as unknown as {
      $client: {
        query: (
          s: string,
          p?: unknown[],
        ) => Promise<{ rows: { search_vector: string }[] }>;
      };
    }).$client;
    const result = await conn.query(
      "SELECT search_vector::text AS search_vector FROM problems WHERE id = $1",
      [TEST_PROBLEM_ID],
    );
    const rows = result.rows;
    assertEquals(rows.length, 1);
    // simple 词典下中文按字符切分；至少应包含 '传' '感' '器'
    const sv = rows[0].search_vector ?? "";
    assertEquals(sv.includes("传"), true, `expected 传 in ${sv}`);
    assertEquals(sv.includes("感"), true, `expected 感 in ${sv}`);
    assertEquals(sv.includes("器"), true, `expected 器 in ${sv}`);
  },
});

Deno.test({
  name: "search service: searchProblems 按中文 title 命中",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchProblems("传感器", 1, 20);
    const hit = page.items.find((i) => i.id === TEST_PROBLEM_ID);
    assertEquals(hit !== undefined, true);
    assertEquals(hit?.display_id, "U9001");
    assertEquals(hit?.title, "传感器数据滤波");
  },
});

Deno.test({
  name: "search service: searchProblems 按 display_id 部分命中（trigram 兜底）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchProblems("9001", 1, 20);
    const hit = page.items.find((i) => i.id === TEST_PROBLEM_ID);
    assertEquals(hit !== undefined, true);
    assertEquals(hit?.display_id, "U9001");
  },
});

Deno.test({
  name: "search service: searchProblems 不命中返回空",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchProblems("不存在的关键词xyz", 1, 20);
    assertEquals(page.items.length, 0);
    assertEquals(page.total, 0);
  },
});

Deno.test({
  name: "search service: searchProblems 分页正确",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page1 = await searchProblems("传感器", 1, 5);
    assertEquals(page1.page, 1);
    assertEquals(page1.limit, 5);
    assertEquals(page1.items.length <= 5, true);
  },
});

Deno.test({
  name: "search service: searchUsers 按 username trigram 命中",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchUsers(`tstusr-${ts}`, 1, 20);
    const hit = page.items.find((i) => i.id === TEST_USER_ID);
    assertEquals(hit !== undefined, true);
    assertEquals(hit?.email, `tstusr-${ts}@test.noj`);
  },
});

Deno.test({
  name: "search service: searchUsers 排除 root（UID=0）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchUsers("root", 1, 20);
    const hit = page.items.find((i) => i.id === "0");
    assertEquals(hit === undefined, true);
  },
});

Deno.test({
  name: "search service: searchUsers 不命中返回空",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const page = await searchUsers("nonexistent_xyz_qq", 1, 20);
    assertEquals(page.items.length, 0);
  },
});

Deno.test({
  name: "search service: trigger 在 UPDATE 后重新填充 search_vector",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    // 改 title → 触发器应重新计算 search_vector
    await db
      .update(problems)
      .set({ title: "新增关键词 abacaba 算法" })
      .where(sql`id = ${TEST_PROBLEM_ID}`);

    // 旧关键词不再命中
    const old = await searchProblems("传感器", 1, 20);
    assertEquals(old.items.find((i) => i.id === TEST_PROBLEM_ID), undefined);

    // 新关键词命中
    const next = await searchProblems("abacaba", 1, 20);
    const hit = next.items.find((i) => i.id === TEST_PROBLEM_ID);
    assertEquals(hit !== undefined, true);
  },
});

Deno.test({
  name: "search service: cleanup 删除测试数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(problems).where(sql`id = ${TEST_PROBLEM_ID}`);
    await db.delete(users).where(sql`id = ${TEST_USER_ID}`);
  },
});
