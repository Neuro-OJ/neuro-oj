import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problems,
  trainings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../access/identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import {
  addTrainingProblem,
  createTraining,
  updateTraining,
} from "../../services/trainings.ts";

await resetDbForTest();
await initRedisForTest();

/**
 * 无域题单的**只读**契约。
 *
 * 0.11 起题单的创建、更新、删除与题目增删只存在于域入口
 * `/api/v1/domains/:slug/trainings`（覆盖见 `domain-trainings.test.ts`）；无域写路由
 * 已删除。这里保留对仍存在的无域读端点的断言：公开列表、mine、containing、
 * 详情可见性与题目列表。准备数据一律直接调用服务层，不再经由 HTTP 写路由。
 */
Deno.test({
  name: "trainings routes: 公开列表、mine、containing 与详情可见性（只读）",
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
      domain_id: "00000000-0000-4000-8000-000000000001",
      id: problemId,
      title: "路由题单测试题",
      description: "测试题面",
      difficulty: "easy",
      visibility: "public",
      runtime_config: {},
      number: 950001,
      owner_id: adminId,
      created_at: now,
      updated_at: now,
    });

    await grantDefaultCatalogRole(userId, "editor");
    await publishDefaultCatalogFixture(problemId);
    const userToken = await signToken({ sub: userId, role: "user" });
    const adminToken = await signToken({ sub: adminId, role: "admin" });
    let trainingId: string | undefined;
    let publicTrainingId: string | undefined;

    try {
      const own = await createTraining(
        { title: "我的题单", state: "draft" },
        userId,
      );
      trainingId = own.id;
      assertExists(trainingId);

      const published = await createTraining(
        { title: "公开题单", state: "published" },
        adminId,
      );
      publicTrainingId = published.id;

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

      await addTrainingProblem(trainingId, problemId, undefined, userId);

      // 预勾选已含题目的题单
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

      const adminView = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}`,
        { token: adminToken },
      );
      assertEquals(adminView.status, 200);

      // 转回 draft 后匿名不可见（可见性由服务层状态决定）
      await updateTraining(trainingId, { state: "draft" }, userId);
      const hiddenByAnon = await jsonRequest(
        app,
        `/api/v1/trainings/${trainingId}`,
      );
      assertEquals(hiddenByAnon.status, 404);

      // 已删除的无域写路由：确认不再存在（0.11 起只有域入口）
      for (
        const [method, path] of [
          ["POST", "/api/v1/trainings"],
          ["PUT", `/api/v1/trainings/${trainingId}`],
          ["DELETE", `/api/v1/trainings/${trainingId}`],
          ["POST", `/api/v1/trainings/${trainingId}/problems`],
          ["PUT", `/api/v1/trainings/${trainingId}/problems`],
          ["DELETE", `/api/v1/trainings/${trainingId}/problems/${problemId}`],
        ] as const
      ) {
        const res = await jsonRequest(app, path, { method, token: adminToken });
        assertEquals(
          res.status,
          404,
          `${method} ${path} 应已删除，实际 ${res.status}`,
        );
      }
    } finally {
      if (trainingId) {
        await db.delete(trainings).where(eq(trainings.id, trainingId));
      }
      if (publicTrainingId) {
        await db.delete(trainings).where(eq(trainings.id, publicTrainingId));
      }
      // 已发布版本和题库绑定作为历史依据，由测试事务整体回滚。
      // 作者及版本身份由测试事务整体回滚，不物理删除历史作者。
    }
  },
});

import {
  grantDefaultCatalogRole,
  publishDefaultCatalogFixture,
  resetDbForTest,
} from "../default-fixture.ts";
