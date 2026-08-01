/**
 * 统一题目包导入端点（POST /api/v1/problems/import-bundle）路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量（PGlite 内存数据库）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

const ts = Date.now();
const OWNER_ID = `bundle-owner-${ts}`;
const ADMIN_ID = "0";

/**
 * 构造统一题目包 zip。
 * @param manifestOverrides 覆盖 manifest 字段
 */
export function makeBundleZip(
  manifestOverrides: Record<string, unknown> = {},
): Uint8Array {
  const manifest = {
    format_version: 1,
    title: `导入测试题 ${ts}`,
    difficulty: "easy",
    type: "U",
    ...manifestOverrides,
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
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
  };
  const enc = new TextEncoder();
  return zipSync({
    "problem.json": enc.encode(JSON.stringify(manifest)),
    "statement.md": enc.encode(
      `# ${manifest.title}\n\n## 样例输入 1\n\`\`\`\n1 2\n\`\`\`\n\n## 样例输出 1\n\`\`\`\n3\n\`\`\`\n`,
    ),
    "evaluate.py": enc.encode("print('evaluator')"),
    "visible.jsonl": enc.encode('{"input": "1 2", "output": "3"}\n'),
  }, { level: 6 });
}

function makeZipBlob(overrides: Record<string, unknown> = {}): Blob {
  return new Blob([makeBundleZip(overrides)], { type: "application/zip" });
}

async function ensureUser(id: string): Promise<void> {
  const db = getDb();
  if (id === "0") return;
  const existing = await db.select().from(users).where(eq(users.id, id)).limit(
    1,
  );
  if (existing.length === 0) {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id,
      username: `bundle-${id}`,
      email: `bundle-${id}@test.com`,
      password_hash: "not-used",
      role: "user",
      created_at: now,
      updated_at: now,
    });
  }
}

Deno.test({
  name: "import-bundle: admin 导入 P 型新题成功（含评测包注册）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({
      sub: ADMIN_ID,
      role: "admin",
      is_admin: true,
    });

    const formData = new FormData();
    formData.append("file", makeZipBlob({ type: "P" }), "p1.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.type, "P");
    assertEquals(body.data.title, `导入测试题 ${ts}`);
    assertEquals(typeof body.data.support_package_storage_url, "string");

    // 落库校验：command 默认值已注入
    const db = getDb();
    const [row] = await db.select().from(problems).where(
      eq(problems.id, body.data.id),
    ).limit(1);
    assertEquals(
      row.runtime_config.evaluator.command,
      "python3 /workspace/evaluate.py",
    );
  },
});

Deno.test({
  name: "import-bundle: admin 用 manifest.id 更新既有题目（upsert）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const db = getDb();
    const pid = `bundle-upsert-${ts}`;
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: pid,
      title: "旧标题",
      description: "旧题面",
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
      number: 70000 + (ts & 0x7fff),
      owner_id: OWNER_ID,
      type: "U",
      created_at: now,
      updated_at: now,
    });

    const app = createApp();
    const token = await signToken({
      sub: ADMIN_ID,
      role: "admin",
      is_admin: true,
    });
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ id: pid, title: "新标题" }),
      "update.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.id, pid);
    assertEquals(body.data.title, "新标题");

    // 题目行数不变（幂等更新）
    const [row] = await db.select().from(problems).where(eq(problems.id, pid))
      .limit(1);
    assertEquals(row.title, "新标题");
  },
});

Deno.test({
  name: "import-bundle: 普通用户导入 U 型题目成功且 id/number 被忽略",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ id: "should-be-ignored", number: 12345 }),
      "u1.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    // id 被忽略 → 服务端生成 UUID（非 "should-be-ignored"）
    assertEquals(body.data.id.startsWith("should-be-ignored"), false);
    assertEquals(body.data.type, "U");
    assertEquals(body.data.owner_id, OWNER_ID);
  },
});

Deno.test({
  name: "import-bundle: 普通用户导入 P 型返回 403",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const formData = new FormData();
    formData.append("file", makeZipBlob({ type: "P" }), "p2.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "import-bundle: 缺 manifest 的松散 zip 返回 400",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({
      sub: ADMIN_ID,
      role: "admin",
      is_admin: true,
    });

    const enc = new TextEncoder();
    const looseZip = zipSync({
      "evaluate.py": enc.encode("print('x')"),
      "visible.jsonl": enc.encode("x"),
    });
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([looseZip], { type: "application/zip" }),
      "loose.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import-bundle: 根级缺 evaluate.py 返回 400",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({
      sub: ADMIN_ID,
      role: "admin",
      is_admin: true,
    });

    const enc = new TextEncoder();
    const badZip = zipSync({
      "problem.json": enc.encode(
        JSON.stringify({ format_version: 1, title: "x", runtime_config: {} }),
      ),
      "statement.md": enc.encode("# x"),
      "sub/evaluate.py": enc.encode("print('x')"),
    });
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([badZip], { type: "application/zip" }),
      "bad.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import-bundle: 非 zip 文件返回 400",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({
      sub: ADMIN_ID,
      role: "admin",
      is_admin: true,
    });

    const formData = new FormData();
    formData.append(
      "file",
      new Blob(["not a zip"], { type: "text/plain" }),
      "test.txt",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "import-bundle: 未登录返回 401",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const formData = new FormData();
    formData.append("file", makeZipBlob(), "u.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      body: formData,
    });
    assertEquals(res.status, 401);
  },
});

// 清理
Deno.test({
  name: "import-bundle: cleanup",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(problems).where(
        sql`${problems.id} LIKE 'bundle-%' OR ${problems.title} LIKE '导入测试题%'`,
      );
      await db.delete(users).where(eq(users.id, OWNER_ID));
    } catch {
      // ignore
    }
  },
});
