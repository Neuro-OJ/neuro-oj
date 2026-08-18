import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { trainings, userRoles, users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest, jsonRequest } from "../lib/helper.ts";
import { ensureRbacSeeds } from "../../src/services/seed-rbac.ts";

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

Deno.test({
  name: "admin trainings routes: 列表、设 public、置顶、删除",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const app = createApp();

    await db.insert(users).values([
      {
        id: adminId,
        username: `admin-train-${unique}`,
        email: `admin-train-${unique}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userId,
        username: `user-train-${unique}`,
        email: `user-train-${unique}@example.com`,
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
    const adminToken = await signToken({ sub: adminId, role: "admin" });
    const userToken = await signToken({ sub: userId, role: "user" });

    let trainingId: string | undefined;
    try {
      const createRes = await jsonRequest(app, "/api/v1/trainings", {
        method: "POST",
        token: userToken,
        body: { title: "待管理题单", visibility: "unlisted" },
      });
      assertEquals(createRes.status, 201);
      trainingId = (await createRes.json()).data.id;

      const forbidden = await jsonRequest(
        app,
        `/api/v1/admin/trainings/${trainingId}`,
        {
          method: "PATCH",
          token: userToken,
          body: { visibility: "public" },
        },
      );
      assertEquals(forbidden.status, 403);

      const forbiddenList = await jsonRequest(app, "/api/v1/admin/trainings", {
        token: userToken,
      });
      assertEquals(forbiddenList.status, 403);

      const patch = await jsonRequest(
        app,
        `/api/v1/admin/trainings/${trainingId}`,
        {
          method: "PATCH",
          token: adminToken,
          body: { visibility: "public", is_pinned: true },
        },
      );
      assertEquals(patch.status, 200);
      const patched = await patch.json();
      assertEquals(patched.data.visibility, "public");
      assertEquals(patched.data.is_pinned, true);

      const list = await jsonRequest(app, "/api/v1/admin/trainings", {
        token: adminToken,
      });
      assertEquals(list.status, 200);
      const listBody = await list.json();
      assertEquals(
        listBody.data.some((t: { id: string }) => t.id === trainingId),
        true,
      );
    } finally {
      if (trainingId) {
        await db.delete(trainings).where(eq(trainings.id, trainingId));
      }
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});
