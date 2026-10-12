/**
 * 个人信息导出端点测试（PIPL 第 45 条）。
 *
 * 覆盖：未登录 401；导出包含本体账户、提交与同意记录；不含他人数据。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { submissions, users } from "../../../../shared/db/schema.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { publishVersion, recordConsent } from "../../../legal/index.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../services/security/jwt.ts";

async function makeUser(id: string) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id,
      username: `exp_${id}`,
      email: `${id}@example.test`,
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  return await signToken({ sub: id, role: "user" });
}

Deno.test({
  name: "data-export: 未登录返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/users/me/data-export");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "data-export: 返回本人账户/提交/同意，且不含他人数据",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makeUser("export-user-1");
    await makeUser("export-user-2"); // 他人

    const db = getDb();
    const now = new Date().toISOString();
    // 题目夹具（submissions.problem_id FK）
    await db.insert(problems).values({
      id: "p-x",
      title: "导出测试题",
      description: "",
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
      number: 9001,
      type: "P",
      visibility: "public",
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing();
    // 本人一条提交 + 他人一条提交
    await db.insert(submissions).values([
      {
        id: "sub-mine",
        user_id: "export-user-1",
        problem_id: "p-x",
        language: "python3",
        code: "print(1)",
        created_at: now,
      },
      {
        id: "sub-other",
        user_id: "export-user-2",
        problem_id: "p-x",
        language: "python3",
        code: "print(2)",
        created_at: now,
      },
    ]).onConflictDoNothing();

    // 本人同意记录
    await publishVersion("privacy", "v1", null, true, "export-user-1");
    await recordConsent("export-user-1", "privacy", 1, "h", null, null);

    const app = createApp();
    const res = await app.request("/api/v1/users/me/data-export", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.account.id, "export-user-1");
    assertEquals(body.data.submissions.length, 1);
    assertEquals(body.data.submissions[0].id, "sub-mine");
    assertEquals(body.data.consents.length, 1);
    assertEquals(body.data.consents[0].document_kind, "privacy");
  },
});
