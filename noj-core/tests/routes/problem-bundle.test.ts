/**
 * 统一题目包导入端点（POST /api/v1/problems/import-bundle）路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量（PGlite 内存数据库）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";
import { problems, users } from "./../../src/shared/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { createUserToken } from "../lib/helper.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

const ts = Date.now();
const OWNER_ID = `bundle-owner-${ts}`;

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

function makeObjectiveZipBlob(
  manifestOverrides: Record<string, unknown> = {},
  questions: unknown = [
    {
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: ["A"],
      explanation: "因为 1+1=2",
    },
  ],
): Blob {
  const manifest = {
    format_version: 1,
    title: `客观题导入测试 ${ts}`,
    difficulty: "easy",
    type: "U",
    is_objective: true,
    ...manifestOverrides,
  };
  const enc = new TextEncoder();
  const zip = zipSync({
    "problem.json": enc.encode(JSON.stringify(manifest)),
    "questions.json": enc.encode(JSON.stringify(questions)),
    "statement.md": enc.encode(`# ${manifest.title}\n`),
  }, { level: 6 });
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
      created_at: now,
      updated_at: now,
    });
  }
  // issue #207：普通用户 = 真实注册用户（user 角色默认拥有敏感字段权限）。
  // resetDbForTest 会 TRUNCATE roles，需先幂等重建系统角色再分配。
  const { ensureRbacSeeds } = await import(
    "../../src/domains/system/index.ts"
  );
  await ensureRbacSeeds();
  const { roles, userRoles } = await import("./../../src/shared/db/schema.ts");
  const [userRole] = await db.select({ id: roles.id }).from(roles).where(
    eq(roles.name, "user"),
  ).limit(1);
  if (userRole) {
    await db.insert(userRoles).values({ user_id: id, role_id: userRole.id })
      .onConflictDoNothing();
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
    const token = await createUserToken("admin");

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
  name: "import-bundle: manifest.template 合法值导入成功",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ template: "starter.py" }),
      "tpl1.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "import-bundle: manifest.template 含路径分隔符/.. 被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ template: "../evil.py" }),
      "tpl2.zip",
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
    const token = await createUserToken("admin");
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
  name:
    "import-bundle: 普通用户导入含 evaluator.command 的 U 型题目被拒（NOJ-062）",
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
    assertEquals(res.status, 403);
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
    const token = await createUserToken("admin");

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
    const token = await createUserToken("admin");

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
    const token = await createUserToken("admin");

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
    const token = await createUserToken("admin");

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

Deno.test({
  name:
    "import-bundle: admin 导入客观题套卷成功（无 evaluate.py/runtime_config，不产生评测包）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    const formData = new FormData();
    formData.append("file", makeObjectiveZipBlob(), "obj1.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.is_objective, true);
    assertEquals(body.data.support_package_storage_url, null);

    const db = getDb();
    const [row] = await db.select().from(problems).where(
      eq(problems.id, body.data.id),
    ).limit(1);
    assertEquals(row.is_objective, true);
    assertEquals(row.runtime_config, null);
    assertEquals(row.support_package_storage_url, null);

    const { objectiveQuestions } = await import(
      "./../../src/shared/db/schema.ts"
    );
    const qs = await db.select().from(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, body.data.id),
    );
    assertEquals(qs.length, 1);
    assertEquals(qs[0].prompt, "1+1=?");
  },
});

Deno.test({
  name:
    "import-bundle: admin 按 (type, number) 幂等更新客观题套卷并全量替换小题",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");
    const fixedNumber = 73000 + (ts & 0x7fff);

    const formData = new FormData();
    formData.append(
      "file",
      makeObjectiveZipBlob({ number: fixedNumber, title: "旧客观题" }),
      "obj-update1.zip",
    );
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    const id = body.data.id;

    // 第二次导入：改标题 + 换小题
    const formData2 = new FormData();
    formData2.append(
      "file",
      makeObjectiveZipBlob(
        { number: fixedNumber, title: "新客观题" },
        [
          {
            type: "judge",
            prompt: "地球是圆的",
            answer: [true],
          },
        ],
      ),
      "obj-update2.zip",
    );
    const res2 = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData2,
    });
    assertEquals(res2.status, 200);
    const body2 = await res2.json();
    assertEquals(body2.data.id, id);
    assertEquals(body2.data.title, "新客观题");

    const db = getDb();
    const { objectiveQuestions } = await import(
      "./../../src/shared/db/schema.ts"
    );
    const qs = await db.select().from(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, id),
    );
    assertEquals(qs.length, 1);
    assertEquals(qs[0].type, "judge");
  },
});

Deno.test({
  name:
    "import-bundle: 客观题包缺 questions.json / 空数组 / 非法字段被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    // 缺 questions.json
    const enc = new TextEncoder();
    const noQuestionsZip = zipSync({
      "problem.json": enc.encode(JSON.stringify({
        format_version: 1,
        title: "缺小题",
        is_objective: true,
      })),
      "statement.md": enc.encode("# 缺小题"),
    });
    let formData = new FormData();
    formData.append(
      "file",
      new Blob([noQuestionsZip], { type: "application/zip" }),
      "obj-missing.zip",
    );
    let res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);

    // 空数组
    formData = new FormData();
    formData.append("file", makeObjectiveZipBlob({}, []), "obj-empty.zip");
    res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);

    // 携带 runtime_config
    formData = new FormData();
    formData.append(
      "file",
      makeObjectiveZipBlob({
        runtime_config: {
          evaluator: { image: "x" },
          solution: { image: "y" },
        },
      }),
      "obj-rc.zip",
    );
    res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name:
    "import-bundle: 普通用户可创建 U 型客观题套卷，但提供 number 被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 无 number：成功
    const formData = new FormData();
    formData.append("file", makeObjectiveZipBlob(), "obj-user1.zip");
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);

    // 带 number：400
    const formData2 = new FormData();
    formData2.append(
      "file",
      makeObjectiveZipBlob({ number: 12345 }),
      "obj-user2.zip",
    );
    const res2 = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData2,
    });
    assertEquals(res2.status, 400);
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
  name:
    "import-bundle: 普通用户导入开启 evaluator 联网/自定义命令被拒（NOJ-062/190 前置）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // manifest.runtime_config 由上传者可控，普通用户默认无敏感字段权限 → 403。
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
    assertEquals(res.status, 403);
  },
});
