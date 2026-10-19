/**
 * 统一题目包导入端点（POST /api/v1/problems/import-bundle）路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量（PGlite 内存数据库）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { createUserToken } from "../../../../../tests/helper.ts";
import { getDefaultLlmLimits } from "../../../gateway/index.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

const ts = Date.now();
const OWNER_ID = `bundle-owner-${ts}`;

/**
 * 读取题目当前草稿 revision：命中既有题目的导入（`problem_id` 或 number 幂等键）
 * 是**内容修改**，必须携带编辑基线 `If-Match`（缺失 428、过时 409）。
 */
async function draftRevisionOf(problemId: string): Promise<number> {
  const { getProblemDraft } = await import(
    "../../services/versioning/draft.ts"
  );
  return (await getProblemDraft(problemId)).revision;
}

/**
 * 构造统一题目包 zip。
 * @param manifestOverrides 覆盖 manifest 字段
 */
export function makeBundleZip(
  manifestOverrides: Record<string, unknown> = {},
  extraEntries: Record<string, string> = {},
): Uint8Array {
  const manifest = {
    format_version: 2,
    title: `导入测试题 ${ts}`,
    difficulty: "easy",
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
  const extras: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(extraEntries)) {
    extras[name] = enc.encode(content);
  }
  return zipSync({
    "problem.json": enc.encode(JSON.stringify(manifest)),
    "statement.md": enc.encode(
      `# ${manifest.title}\n\n## 样例输入 1\n\`\`\`\n1 2\n\`\`\`\n\n## 样例输出 1\n\`\`\`\n3\n\`\`\`\n`,
    ),
    "evaluate.py": enc.encode("print('evaluator')"),
    "visible.jsonl": enc.encode('{"input": "1 2", "output": "3"}\n'),
    ...extras,
  }, { level: 6 });
}

function makeZipBlob(
  overrides: Record<string, unknown> = {},
  extraEntries: Record<string, string> = {},
): Blob {
  const zip = makeBundleZip(overrides, extraEntries);
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
    format_version: 2,
    title: `客观题导入测试 ${ts}`,
    difficulty: "easy",
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
    "../../../system/index.ts"
  );
  await ensureRbacSeeds();
  const { roles, userRoles } = await import("../../../../shared/db/schema.ts");
  const [userRole] = await db.select({ id: roles.id }).from(roles).where(
    eq(roles.name, "user"),
  ).limit(1);
  if (userRole) {
    await db.insert(userRoles).values({ user_id: id, role_id: userRole.id })
      .onConflictDoNothing();
  }
}

Deno.test({
  name: "import-bundle: admin 导入 v2 新题成功（含评测包注册）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    const formData = new FormData();
    formData.append("file", makeZipBlob({}), "p1.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.title, `导入测试题 ${ts}`);
    const draftObjects = await listDraftObjects(body.data.id);
    assertEquals(
      draftObjects.some((object) => object.role === "support_package"),
      true,
    );
    assertEquals(body.data.support_package_storage_url, null);

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

/** 模板内容样例（断言落库与端点返回用）。 */
const TEMPLATE_SKELETON = "# 作答骨架\nprint('TODO')\n";

Deno.test({
  name:
    "import-bundle: 模板随包落库、/template 可读、存量题目回退读包、重导入清空",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    // ① 模板随包导入（默认名 template.py）
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob(
        { title: `模板题 ${ts}` },
        { "template.py": TEMPLATE_SKELETON },
      ),
      "tpl1.zip",
    );
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    const problemId = body.data.id as string;

    // ② 落库校验：运行期不再依赖服务器本地 data/problems-src
    const db = getDb();
    const [row] = await db.select().from(problems).where(
      eq(problems.id, problemId),
    ).limit(1);
    assertEquals(row.template_content, null);
    const importedDraft = await getProblemDraft(problemId);
    assertEquals(importedDraft.content.template_content, TEMPLATE_SKELETON);
    await publishImportedProblem(problemId, decodeJwt(token).sub!);

    // ③ 端点校验：编辑器实际拿到的内容
    const tplRes = await app.request(
      `/api/v1/problems/${problemId}/template`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(tplRes.status, 200);
    const tpl = await tplRes.json();
    assertEquals(tpl.data.content, TEMPLATE_SKELETON);
    assertEquals(tpl.data.language, "python3");

    // ④ 存量题目（本次改动前导入、字段为空）：回退读支持包内的默认名模板
    await db.update(problems).set({ template_content: null }).where(
      eq(problems.id, problemId),
    );
    const fallbackRes = await app.request(
      `/api/v1/problems/${problemId}/template`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(fallbackRes.status, 200);
    assertEquals((await fallbackRes.json()).data.content, TEMPLATE_SKELETON);

    // ⑤ 重新导入同一 (type, number)、包内无模板 → 落库为空串（"已核对无模板"，
    //    解析时据此不再回源下载整个支持包），端点回到 404
    const reimport = new FormData();
    reimport.append(
      "file",
      makeZipBlob({ title: `模板题 ${ts}`, number: body.data.number }),
      "tpl1-b.zip",
    );
    const reimportRes = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": String(await draftRevisionOf(problemId)),
      },
      body: reimport,
    });
    assertEquals(reimportRes.status, 200);
    assertEquals((await reimportRes.json()).data.id, problemId);
    // 模板是**内容**字段：写入共享草稿，公开投影（只由发布更新）保持原值 null
    const { getProblemDraft: readDraftAgain } = await import(
      "../../services/versioning/draft.ts"
    );
    const clearedDraft = await readDraftAgain(problemId);
    assertEquals(
      (clearedDraft.content as { template_content?: string }).template_content,
      "",
    );
    const [afterRow] = await db.select().from(problems).where(
      eq(problems.id, problemId),
    ).limit(1);
    assertEquals(afterRow.template_content, null);
    const goneRes = await app.request(
      `/api/v1/problems/${problemId}/template`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(goneRes.status, 200);
    assertEquals((await goneRes.json()).data.content, TEMPLATE_SKELETON);
    await publishImportedProblem(problemId, decodeJwt(token).sub!);
    const publishedGone = await app.request(
      `/api/v1/problems/${problemId}/template`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(publishedGone.status, 404);
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
  name: "import-bundle: admin 按默认域 number 匹配更新既有题目（幂等 upsert）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
    const db = getDb();
    const pid = `bundle-upsert-${ts}`;
    const now = new Date().toISOString();
    await db.insert(problems).values({
      domain_id: "00000000-0000-4000-8000-000000000001",
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
      created_at: now,
      updated_at: now,
    });

    await bindDefaultCatalogFixture(pid);

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
      headers: {
        Authorization: `Bearer ${token}`,
        // 命中既有题目 → 内容修改，携带编辑基线 revision
        "If-Match": String(await draftRevisionOf(pid)),
      },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    // id 由服务端生成（UUID），不因导入而改变
    assertEquals(body.data.id, pid);

    // 内容（题面/标题）写**草稿**，公开投影只由发布更新（Handbook §2.2/§6.2）：
    // 题目行仍是旧标题，草稿内容已是新标题。
    const { getProblemDraft: readDraft } = await import(
      "../../services/versioning/draft.ts"
    );
    const draftAfter = await readDraft(pid);
    assertEquals(draftAfter.content.title, "新标题");

    // 题目行数不变（幂等更新），且投影未被内容导入提前改写
    const [row] = await db.select().from(problems).where(eq(problems.id, pid))
      .limit(1);
    assertEquals(row.title, "旧标题");
  },
});

Deno.test({
  name: "import-bundle: 默认域编辑者可指定域内 number",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
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
    assertEquals(res.status, 200);
    // 指定题号只在默认域创建一题
    const after = await db.select({ count: sql<number>`COUNT(*)` }).from(
      problems,
    );
    assertEquals(Number(after[0].count), Number(before[0].count) + 1);
  },
});

Deno.test({
  name: "import-bundle: 默认域编辑者导入默认 command 题目放行",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
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
  },
});

Deno.test({
  name: "import-bundle: 普通用户导入自定义 evaluator.command 被拒（NOJ-062）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "bash /workspace/run.sh",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      }),
      "u3.zip",
    );

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "import-bundle: 格式 2 携带旧 P 分类返回 400",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const formData = new FormData();
    formData.append("file", makeZipBlob({ type: "P" }), "p2.zip");

    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
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
        JSON.stringify({ format_version: 2, title: "x", runtime_config: {} }),
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
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": String(await draftRevisionOf(body.data.id)),
      },
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

    // LocalStorageProvider 按内容寻址，两次上传可返回同一 URL；发布后不能回收它。
    const download = await app.request(
      `/api/v1/problems/${body.data.id}/support-package`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(download.status, 200, "重复导入后支持包仍可下载");
    const packageBytes = new Uint8Array(await download.arrayBuffer());
    assertEquals(packageBytes.length > 0, true);

    // 注入数据库写入失败，验证失败请求的**零副作用**：不新增行、题目投影不变、
    // 草稿 revision 不变、已存在且被复用的支持包对象不被回收。
    //
    // 注入点必须是 db.update（而不是 db.transaction）：测试事务代理
    // （connection.ts createTestTransactionDb）的 get trap 对 `transaction`
    // 恒返回内部的 savepointTransaction，直接赋值会被静默忽略；而 insert/update/
    // select 等属性经 Reflect.get 转发，赋值可生效且同样会进入业务事务内部
    // （`tx` 就是同一个代理），因此能真实模拟"事务内写入失败"。
    const revisionBefore = await draftRevisionOf(body.data.id);
    const [rowBefore] = await db.select({ title: problems.title }).from(
      problems,
    )
      .where(eq(problems.id, body.data.id)).limit(1);
    const originalUpdate = db.update;
    // deno-lint-ignore no-explicit-any
    (db as any).update = () => {
      throw new Error("测试注入：题目更新失败");
    };
    try {
      const failed = await app.request("/api/v1/problems/import-bundle", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "If-Match": String(revisionBefore),
        },
        body: formData,
      });
      assertEquals(failed.status, 500);
    } finally {
      // deno-lint-ignore no-explicit-any
      (db as any).update = originalUpdate;
    }

    // 零副作用：题目行与草稿 revision 都不变
    const [rowAfterFailure] = await db.select({ title: problems.title }).from(
      problems,
    ).where(eq(problems.id, body.data.id)).limit(1);
    assertEquals(rowAfterFailure?.title, rowBefore?.title);
    assertEquals(await draftRevisionOf(body.data.id), revisionBefore);

    const afterFailure = await app.request(
      `/api/v1/problems/${body.data.id}/support-package`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(afterFailure.status, 200, "回滚后旧支持包仍可下载");
    assertEquals(
      new Uint8Array(await afterFailure.arrayBuffer()),
      packageBytes,
    );
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

    // 小题事实源是共享草稿（旧表已随 0107 删除）
    const { getProblemDraft } = await import(
      "../../services/versioning/draft.ts"
    );
    const draft = await getProblemDraft(body.data.id);
    const qs = (draft.content as { questions?: { prompt: string }[] })
      .questions ?? [];
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
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": String(await draftRevisionOf(id)),
      },
      body: formData2,
    });
    assertEquals(res2.status, 200);
    const body2 = await res2.json();
    assertEquals(body2.data.id, id);
    // 标题写草稿；公开投影仍为首次导入值，直到发布新版本
    const { getProblemDraft } = await import(
      "../../services/versioning/draft.ts"
    );
    const draftAfterSecond = await getProblemDraft(id);
    assertEquals(draftAfterSecond.content.title, "新客观题");
    const db = getDb();
    const [projectionRow] = await db.select({ title: problems.title })
      .from(problems).where(eq(problems.id, id)).limit(1);
    assertEquals(projectionRow?.title, "旧客观题");

    const draft = draftAfterSecond;
    const qs = (draft.content as { questions?: { type: string }[] })
      .questions ?? [];
    assertEquals(qs.length, 1);
    assertEquals(qs[0].type, "judge");
    const [updatedProblem] = await db.select({
      judge_type: problems.judge_type,
      runtime_config: problems.runtime_config,
    }).from(problems).where(eq(problems.id, id)).limit(1);
    assertEquals(updatedProblem?.judge_type, "dual");
    assertEquals(updatedProblem?.runtime_config, null);
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
        format_version: 2,
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
  name: "import-bundle: 默认域编辑者可创建客观题套卷并指定域内 number",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureUser(OWNER_ID);
    await grantDefaultCatalogRole(OWNER_ID, "coach");
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
    assertEquals(res2.status, 200);
  },
});

Deno.test({
  name:
    "import-bundle: 目标题目模式可写入**未发布**题目的草稿（新建题目后上传支持包）",
  // 不按环境变量条件跳过：test:domain 总会提供 JWT_SECRET，静默跳过只会掩盖回归
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");

    // 编辑器主路径：先建题（未发布；建题即写入首个草稿）……
    const createRes = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "待上传题包",
        description: "占位题面",
        difficulty: "easy",
        visibility: "public",
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
      }),
    });
    assertEquals(createRes.status, 201);
    const problemId = (await createRes.json()).data.id as string;
    const revision = await draftRevisionOf(problemId);
    const countBefore = (await getDb().select({ id: problems.id }).from(
      problems,
    )).length;

    // ……缺少编辑基线仍是 428（乐观锁语义不变）
    const missing = new FormData();
    missing.append("file", makeZipBlob(), "target.zip");
    missing.append("problem_id", problemId);
    const missingRes = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: missing,
    });
    assertEquals(missingRes.status, 428);

    // ……携带当前基线 → 写入该题草稿，不新建题目
    const formData = new FormData();
    formData.append("file", makeZipBlob(), "target.zip");
    formData.append("problem_id", problemId);
    formData.append("expected_revision", String(revision));
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": String(revision),
      },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.id, problemId);
    assertEquals(body.data.draft_revision, revision + 1);

    const { getProblemDraft } = await import(
      "../../services/versioning/draft.ts"
    );
    const draft = await getProblemDraft(problemId);
    assertEquals(
      (draft.content as { title: string }).title,
      `导入测试题 ${ts}`,
    );
    const countAfter = (await getDb().select({ id: problems.id }).from(
      problems,
    )).length;
    assertEquals(countAfter, countBefore, "目标模式不得创建新题目");
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
    await grantDefaultCatalogRole(OWNER_ID, "coach");
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

Deno.test({
  name: "import-bundle: LLM max_calls 超过平台默认被拒（400）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await createUserToken("admin");
    const defaults = getDefaultLlmLimits();
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            time_limit_ms: 60000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 5000,
            memory_limit_mb: 512,
          },
        },
        llm: {
          provider_id: "p1",
          model: "m",
          max_calls: defaults.max_calls + 1,
        },
      }),
      "llm-over.zip",
    );
    const res = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    assertEquals(res.status, 400);
  },
});

import {
  bindDefaultCatalogFixture,
  resetDbForTest,
} from "../default-fixture.ts";

import { grantDefaultCatalogRole } from "../default-fixture.ts";

import {
  getProblemDraft,
  listDraftObjects,
} from "../../services/versioning/draft.ts";
import { publishImportedProblem } from "../../services/problems/problem-bundle.ts";
import { decodeJwt } from "jose";
