import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  contests,
  problems,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../access/identity/index.ts";
import {
  initRedisForTest,
  jsonRequest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import { ensureRbacSeeds } from "../../../platform/system/index.ts";
import { createDomain } from "../../../access/workspace/index.ts";

// 测试进程通常没有本地 Redis；直接短路 JWT 撤销检查，避免 authMiddleware 503。
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

Deno.test({
  name: "默认域管理入口：其他域比赛 ID 不能用于详情、修改、删除或列表",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await setupContestViaAdmin(),
      db = getDb(),
      now = new Date().toISOString();
    const other = await createDomain({
      slug: `admin-other-${crypto.randomUUID().slice(0, 8)}`,
      name: "其他学校",
      preset: "team",
    }, f.adminId);
    const foreign = crypto.randomUUID();
    await db.insert(contests).values({
      id: foreign,
      domain_id: other.id,
      title: "私有学校赛",
      created_by: f.adminId,
      type: "kaggle",
      kind: "invite",
      start_time: now,
      end_time: new Date(Date.now() + 3600000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await jsonRequest(
        f.app,
        `/api/v1/admin/contest/contests/${foreign}`,
        {
          method,
          token: f.adminToken,
          body: method === "PUT" ? { title: "越界改名" } : undefined,
        },
      );
      assertEquals(response.status, 404);
    }
    const listed = await jsonRequest(f.app, "/api/v1/admin/contest/contests", {
      token: f.adminToken,
    });
    assertEquals(listed.status, 200);
    const data = await listed.json() as { data: Array<{ id: string }> };
    assertEquals(data.data.some((row) => row.id === foreign), false);
    assertEquals(
      (await db.select().from(contests).where(eq(contests.id, foreign)))[0]
        .title,
      "私有学校赛",
    );
  },
});

async function setupContestViaAdmin(): Promise<{
  app: ReturnType<typeof createApp>;
  adminId: string;
  adminToken: string;
  contestId: string;
}> {
  const db = getDb();
  const adminId = crypto.randomUUID();
  const problemId = crypto.randomUUID();
  const now = new Date().toISOString();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(users).values({
    id: adminId,
    username: `ac-admin-${unique}`,
    email: `ac-admin-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(userRoles).values({
    user_id: adminId,
    role_id: "admin",
  }).onConflictDoNothing();
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: "后台竞赛测试题",
    description: "测试题面",
    difficulty: "easy",
    runtime_config: {},
    number: 990001 + Math.floor(Math.random() * 1000),
    owner_id: adminId,
    created_at: now,
    updated_at: now,
  });
  // 竞赛只能固定已发布版本（Handbook §2.6）：夹具题目补迁移基线
  await publishBaselineVersionForTest(problemId);

  const app = createApp();
  const adminToken = await signToken({ sub: adminId, role: "admin" });
  const create = await jsonRequest(app, "/api/v1/admin/contest/contests", {
    method: "POST",
    token: adminToken,
    body: {
      title: `邀请赛-${unique}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      kind: "invite",
      password: "OLD-CODE-123",
      is_public: false,
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
  });
  assertEquals(create.status, 201);
  const contestId = (await create.json()).data.id;
  return { app, adminId, adminToken, contestId };
}

Deno.test({
  name: "管理比赛：已移除转换分类与重置邀请码入口",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, adminToken, contestId } = await setupContestViaAdmin();
    for (
      const [suffix, method] of [["kind", "PATCH"], ["reset-code", "POST"]]
    ) {
      const response = await jsonRequest(
        app,
        `/api/v1/admin/contest/contests/${contestId}/${suffix}`,
        { method, token: adminToken, body: { kind: "public" } },
      );
      assertEquals(response.status, 404);
    }
  },
});
