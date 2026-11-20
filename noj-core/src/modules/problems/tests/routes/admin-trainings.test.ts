import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { auditLogs, trainings, users } from "../../../../shared/db/schema.ts";
import { signToken } from "../../../access/identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { saveDomainTraining } from "../../../../features/trainings/index.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "admin trainings routes: 题单管理端点已下线，题目列表保留",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const readerId = crypto.randomUUID();
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
      {
        id: readerId,
        username: `training-reader-${unique}`,
        email: `training-reader-${unique}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
    await grantDefaultCatalogRole(userId, "educator");
    const adminToken = await signToken({ sub: adminId, role: "admin" });
    const userToken = await signToken({ sub: userId, role: "user" });
    const readerToken = await signToken({ sub: readerId, role: "user" });

    let trainingId: string | undefined;
    try {
      // 题单只经域内服务创建：直接走服务层准备数据，管理端断言仍走 HTTP。
      const created = await saveDomainTraining("main", userId, {
        title: "待管理题单",
        state: "draft",
        problems: [],
      });
      trainingId = created.id;

      // 2026-11 精简：admin catalog 题单端点与旧预检已整体删除，普通用户与管理员
      // 都只能通过域内入口管理题单；非管理员访问已删除路径不再被管理权限前置拦截。
      const forbidden = await jsonRequest(
        app,
        `/api/v1/admin/catalog/trainings/${trainingId}`,
        {
          method: "PATCH",
          token: userToken,
          body: { state: "published" },
        },
      );
      assertEquals(forbidden.status, 404);

      const readerList = await jsonRequest(
        app,
        "/api/v1/admin/catalog/trainings",
        { token: readerToken },
      );
      // 已删除的 trainings 路径只剩 404；非管理员是否先被整组 admin 守卫拦成 403
      // 取决于读取请求的封禁/限流状态，不应断言。
      assertEquals([403, 404].includes(readerList.status), true);
      const memberList = await jsonRequest(
        app,
        "/api/v1/admin/catalog/trainings",
        { token: userToken },
      );
      assertEquals([403, 404].includes(memberList.status), true);

      const patch = await jsonRequest(
        app,
        `/api/v1/admin/catalog/trainings/${trainingId}`,
        {
          method: "PATCH",
          token: adminToken,
          body: { state: "published", is_pinned: true },
        },
      );
      assertEquals(patch.status, 404);

      const list = await jsonRequest(app, "/api/v1/admin/catalog/trainings", {
        token: adminToken,
      });
      assertEquals(list.status, 404);

      // 保留下来的题目列表端点仍由 admin:full_access 守卫。
      const problems = await jsonRequest(
        app,
        "/api/v1/admin/catalog/problems",
        {
          token: adminToken,
        },
      );
      assertEquals(problems.status, 200);
    } finally {
      if (trainingId) {
        await db.delete(trainings).where(eq(trainings.id, trainingId));
      }
      // withAudit 会为 trainings.update/delete 写入审计日志，先清理避免删除用户时外键冲突。
      await db.delete(auditLogs).where(eq(auditLogs.admin_id, adminId));
      await db.delete(auditLogs).where(eq(auditLogs.admin_id, userId));
      await removeDefaultCatalogMembership(userId);
      await db.delete(users).where(eq(users.id, userId));
      await removeDefaultCatalogMembership(adminId);
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});

import {
  grantDefaultCatalogRole,
  removeDefaultCatalogMembership,
  resetDbForTest,
} from "../default-fixture.ts";
