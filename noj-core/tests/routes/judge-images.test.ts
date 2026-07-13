/**
 * 评测镜像白名单路由层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 * 测试前自动运行迁移并 seed 默认白名单条目（见 00_migrate_test.ts）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { judgeImages } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { jsonRequest } from "../lib/helper.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !hasDb;
const skipEnv = !hasEnv;

const ts = Date.now();

Deno.test({
  name: "judge-images route: GET /api/v1/judge-images 公开返回列表",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/judge-images");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    // 应包含默认 seed
    assertEquals(
      body.data.some((i: { image: string }) => i.image === "noj-judge-python"),
      true,
    );
  },
});

Deno.test({
  name: "judge-images route: GET /api/v1/judge-images 无需认证",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/judge-images");
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "judge-images route: GET /api/v1/admin/judge-images 管理员返回列表",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/judge-images", { token });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

Deno.test({
  name: "judge-images route: GET /api/v1/admin/judge-images 非管理员返回 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "test-user", role: "user" });
    const res = await jsonRequest(app, "/api/v1/admin/judge-images", { token });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "judge-images route: POST /api/v1/admin/judge-images 管理员创建成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/judge-images", {
      method: "POST",
      body: {
        image: `route-test-image-${ts}`,
        mode: "exact",
        description: "路由测试",
      },
      token,
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.image, `route-test-image-${ts}`);
    assertEquals(body.data.mode, "exact");
  },
});

Deno.test({
  name:
    "judge-images route: POST /api/v1/admin/judge-images 非法 mode 返回 400",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await jsonRequest(app, "/api/v1/admin/judge-images", {
      method: "POST",
      body: {
        image: "test-image",
        mode: "regex",
      },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "judge-images route: PUT /api/v1/admin/judge-images/:id 管理员更新成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

    // 先创建
    const createRes = await jsonRequest(app, "/api/v1/admin/judge-images", {
      method: "POST",
      body: {
        image: `route-update-test-${ts}`,
        mode: "exact",
      },
      token,
    });
    const created = await createRes.json();

    // 再更新
    const updateRes = await jsonRequest(
      app,
      `/api/v1/admin/judge-images/${created.data.id}`,
      {
        method: "PUT",
        body: {
          description: "更新后的介绍",
          mode: "all_versions",
        },
        token,
      },
    );
    assertEquals(updateRes.status, 200);
    const updated = await updateRes.json();
    assertEquals(updated.data.description, "更新后的介绍");
    assertEquals(updated.data.mode, "all_versions");
  },
});

Deno.test({
  name:
    "judge-images route: DELETE /api/v1/admin/judge-images/:id 管理员删除成功",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });

    // 先创建
    const createRes = await jsonRequest(app, "/api/v1/admin/judge-images", {
      method: "POST",
      body: {
        image: `route-delete-test-${ts}`,
        mode: "exact",
      },
      token,
    });
    const created = await createRes.json();

    // 再删除
    const deleteRes = await jsonRequest(
      app,
      `/api/v1/admin/judge-images/${created.data.id}`,
      { method: "DELETE", token },
    );
    assertEquals(deleteRes.status, 204);
  },
});

Deno.test({
  name:
    "judge-images route: DELETE /api/v1/admin/judge-images/:id 不存在的返回 404",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const token = await signToken({ sub: "0", role: "admin" });
    const res = await jsonRequest(
      app,
      "/api/v1/admin/judge-images/nonexistent-id",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "judge-images route: 未登录访问 admin 端点返回 401",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/judge-images");
    assertEquals(res.status, 401);
  },
});

// 清理
Deno.test({
  name: "judge-images route: cleanup",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `route-test-image-${ts}`),
      );
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `route-update-test-${ts}`),
      );
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `route-delete-test-${ts}`),
      );
    } catch {
      // ignore
    }
  },
});
