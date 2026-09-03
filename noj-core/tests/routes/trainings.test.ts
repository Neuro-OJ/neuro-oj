import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";
import {
  problems,
  trainings,
  userRoles,
  users,
} from "./../../src/shared/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest, jsonRequest } from "../lib/helper.ts";
import { ensureRbacSeeds } from "../../src/domains/system/index.ts";

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

Deno.test({
  name: "trainings routes: 公开列表、mine、CRUD、题目管理",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const app = createApp();

    await db.insert(users).values([
      {
        id: userId,
        username: `train-user-${unique}`,
        email: `train-user-${unique}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: adminId,
        username: `train-admin-${unique}`,
        email: `train-admin-${unique}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(userRoles).values({
      user_id: adminId,
      role_id: "admin",
    }).onConflictDoNothing();
    await db.insert(userRoles).values({
      user_id: userId,
      role_id: "user",
    }).onConflictDoNothing();
    await db.insert(problems).values({
      id: problemId,
      title: "路由题单测试题",
      description: "测试题面",
      difficulty: "easy",
      runtime_config: {},
      number: 950001,
      owner_id: adminId,
      type: "P",
      created_at: now,
      updated_at: now,
    });

    const userToken = await signToken({ sub: userId, role: "user" });
    const adminToken = await signToken({ sub: adminId, role: "admin" });
    let trainingId: string | undefined;
    let publicTrainingId: string | undefined;

    try {
      const createRes = await jsonRequest(app, "/api/v1/trainings", {
        method: "POST",
        token: userToken,
        body: { title: "我的题单", visibility: "private" },
      });
      assertEquals(createRes.status, 201);
      trainingId = (await createRes.json()).data.id;
      assertExists(trainingId);

      const publicRes = await jsonRequest(app, "/api/v1/trainings", {
        method: "POST",
        token: adminToken,
        body: { title: "公开题单", visibility: "unlisted" },
      });
      assertEquals(publicRes.status, 201);
      publicTrainingId = (await publicRes.json()).data.id;
      const publishRes = await jsonRequest(
        app,
        `/api/v1/trainings/${publicTrainingId}`,
        {
          method: "PUT",
          token: adminToken,
          body: { visibility: "public" },
        },
      );
      assertEquals(publishRes.status, 200);

      const listRes = await jsonRequest(app, "/api/v1/trainings");
      const listBody = await listRes.json();
      assertEquals(
        listBody.data.some((t: { id: string }) => t.id === publicTrainingId),
        true,
      );
      assertEquals(
        listBody.data.some((t: { id: string }) => t.id === trainingId),
        false,
      );

      const mineRes = await jsonRequest(app, "/api/v1/trainings/mine", {
        token: userToken,
      });
      assertEquals(mineRes.status, 200);

      const profileRes = await jsonRequest(
        app,
        `/api/v1/trainings?created_by=${userId}`,
      );
      const profileBody = await profileRes.json();
      assertEquals(profileBody.data.length, 0);

      const addRes = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}/problems`,
        {
          method: "POST",
          token: userToken,
          body: { problem_id: problemId },
        },
      );
      assertEquals(addRes.status, 201);

      // 新增 /containing：预勾选已含题目的题单
      const containingRes = await jsonRequest(
        app,
        `/api/v1/trainings/containing?problem_id=${problemId}`,
        { token: userToken },
      );
      assertEquals(containingRes.status, 200);
      const containingBody = await containingRes.json();
      assertEquals(containingBody.data.includes(trainingId), true);
      // 只返回当前用户创建的题单，不包含管理员创建的题单
      assertEquals(containingBody.data.includes(publicTrainingId), false);

      const containingMissingParam = await jsonRequest(
        app,
        "/api/v1/trainings/containing",
        { token: userToken },
      );
      assertEquals(containingMissingParam.status, 400);

      const containingUnauthorized = await jsonRequest(
        app,
        `/api/v1/trainings/containing?problem_id=${problemId}`,
      );
      assertEquals(containingUnauthorized.status, 401);

      const problemsRes = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}/problems`,
        { token: userToken },
      );
      assertEquals((await problemsRes.json()).data.length, 1);

      const forbiddenPublish = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}`,
        {
          method: "PUT",
          token: userToken,
          body: { visibility: "public" },
        },
      );
      assertEquals(forbiddenPublish.status, 403);

      const adminView = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}`,
        { token: adminToken },
      );
      assertEquals(adminView.status, 200);
      const hiddenByAnon = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}`,
      );
      assertEquals(hiddenByAnon.status, 404);
    } finally {
      if (trainingId) {
        await db.delete(trainings).where(eq(trainings.id, trainingId));
      }
      if (publicTrainingId) {
        await db.delete(trainings).where(eq(trainings.id, publicTrainingId));
      }
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});
