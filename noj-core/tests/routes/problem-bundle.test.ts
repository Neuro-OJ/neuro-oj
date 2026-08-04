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
    ...manifestOverrides,
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
  const zip = makeBundleZip(overrides);
  return new Blob(
    [zip.buffer.slice(
      zip.byteOffset,
      zip.byteOffset + zip.byteLength,
    ) as ArrayBuffer],
    { type: "application/zip" },
  );
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
      (row.runtime_config as { evaluator: { command: string } }).evaluator
        .command,
      "python3 /workspace/evaluate.py",
    );
  },
});

Deno.test({
  name:
    "import-bundle: admin 按 (type, number) 匹配更新既有题目（幂等 upsert）",
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
      makeZipBlob({
        number: 70000 + (ts & 0x7fff),
        title: "新标题",
      }),
      "update.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    // id 由服务端生成（UUID），不因导入而改变
    assertEquals(body.data.id, pid);
    assertEquals(body.data.title, "新标题");

    // 题目行数不变（幂等更新）
    const [row] = await db.select().from(problems).where(eq(problems.id, pid))
      .limit(1);
    assertEquals(row.title, "新标题");
  },
});

Deno.test({
  name: "import-bundle: 普通用户导入含 number 的包被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const db = getDb();
    const before = await db.select({ count: sql<number>`COUNT(*)` }).from(
      problems,
    );

    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ number: 12345 }),
      "u1.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assertEquals(
      body.error?.includes("仅管理员可指定 number"),
      true,
      "错误信息应说明 number 仅限管理员",
    );

    // 拒绝不得创建任何题目
    const after = await db.select({ count: sql<number>`COUNT(*)` }).from(
      problems,
    );
    assertEquals(after[0].count, before[0].count);
  },
});

Deno.test({
  name: "import-bundle: 普通用户导入无 number 的 U 型题目成功（自动分配）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const formData = new FormData();
    formData.append("file", makeZipBlob(), "u2.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    // number 由系统自动分配（type 内 MAX+1）；id 服务端生成 UUID
    assertEquals(body.data.number >= 1, true);
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
  name: "import-bundle: admin 带 number 重复导入幂等（按 (type, number)）",
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

    const fixedNumber = 72000 + (ts & 0x7fff);
    const formData = new FormData();
    // manifest 带 number（幂等键），id 由服务端生成
    formData.append(
      "file",
      makeZipBlob({ number: fixedNumber }),
      "fixed-number.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as { data: { id: string; number: number } };
    // id 服务端生成（UUID 格式），number 使用 manifest 指定值
    assertEquals(/^[0-9a-f-]{36}$/.test(body.data.id), true);
    assertEquals(body.data.number, fixedNumber);

    // 重复导入 → 按 (type, number) 命中更新路径，不产生新行
    const res2 = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res2.status, 200);
    const body2 = (await res2.json()) as { data: { id: string } };
    assertEquals(body2.data.id, body.data.id, "重复导入应更新同一题目");

    const db = getDb();
    const rows = await db.select().from(problems).where(
      eq(problems.id, body.data.id),
    );
    assertEquals(rows.length, 1, "重复导入不应产生新行");
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

Deno.test({
  name: "import-bundle: 普通用户导入开启 evaluator 联网放行（有创建权限即可）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // manifest.runtime_config.evaluator.network.enabled=true（上传者可控）
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      }),
      "u-net1.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(
      body.data.runtime_config.evaluator.network?.enabled,
      true,
    );
  },
});
