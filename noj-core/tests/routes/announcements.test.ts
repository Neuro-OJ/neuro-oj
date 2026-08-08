/**
 * 公告路由层测试（issue #231）。
 *
 * 覆盖：公开列表（未登录 200 / 置顶排序 / 下架不可见 / 分页 meta / 详情 404）、
 * 管理端点（非 admin 403 / 创建 201 / 发布下架 / 删除 204 / 更新 404 / 校验 400）、
 * RBAC seed（announcement:manage 权限存在且 admin 角色拥有）。
 *
 * 依赖 PGlite 内存数据库 + JWT_SECRET（helper 自动 seed RBAC）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createUserToken, initRedisForTest } from "../lib/helper.ts";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { permissions, rolePermissions, roles } from "../../src/db/schema.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipDb = !hasDb;
const skipEnv = !hasEnv;

const ts = Date.now();

/** admin 创建一条公告，返回 { id, res } */
async function createViaApi(
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const app = createApp();
  const res = await app.request("/api/v1/admin/announcements", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: `公告-${ts}`,
      content: "公告正文",
      ...overrides,
    }),
  });
  const body = await res.json();
  return { id: body.data?.id as string, res, body };
}

Deno.test({
  name: "announcements route: 公开列表未登录 200 空列表 + 404",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await initRedisForTest();
    const app = createApp();

    const listRes = await app.request("/api/v1/announcements");
    assertEquals(listRes.status, 200);
    const body = await listRes.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.meta.total, 0);

    const detailRes = await app.request(
      "/api/v1/announcements/00000000-0000-0000-0000-000000000000",
    );
    assertEquals(detailRes.status, 404);
  },
});

Deno.test({
  name: "announcements route: 非 admin 写操作 403",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const token = await createUserToken();
    const app = createApp();
    const res = await app.request("/api/v1/admin/announcements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "x", content: "y" }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "announcements route: admin 发布 → 公开可见 → 置顶排序 → 下架消失",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await initRedisForTest();
    const token = await createUserToken("admin");
    const app = createApp();

    // 先建普通公告，再建置顶公告（置顶较新，验证置顶优先）
    const normal = await createViaApi(token);
    assertEquals(normal.res.status, 201);
    const pinned = await createViaApi(token, { is_pinned: true });
    assertEquals(pinned.res.status, 201);

    // 公开列表：置顶在前
    const listRes = await app.request("/api/v1/announcements");
    const list = await listRes.json();
    assertEquals(list.data[0].id, pinned.id);
    assertEquals(list.data[0].title, `公告-${ts}`);
    assertEquals(list.data[0].excerpt, "公告正文");
    assertEquals("content" in list.data[0], false);
    assertEquals(list.meta.total, 2);

    // 详情可读全文
    const detailRes = await app.request(
      `/api/v1/announcements/${pinned.id}`,
    );
    assertEquals(detailRes.status, 200);
    const detail = await detailRes.json();
    assertEquals(detail.content, "公告正文");
    assertEquals(detail.is_pinned, true);

    // 下架置顶公告 → 公开列表消失 + 详情 404
    const unpublishRes = await app.request(
      `/api/v1/admin/announcements/${pinned.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ is_active: false }),
      },
    );
    assertEquals(unpublishRes.status, 200);

    const listAfter = await app.request("/api/v1/announcements");
    const after = await listAfter.json();
    assertEquals(after.meta.total, 1);
    assertEquals(after.data[0].id, normal.id);

    const detailAfter = await app.request(
      `/api/v1/announcements/${pinned.id}`,
    );
    assertEquals(detailAfter.status, 404);
  },
});

Deno.test({
  name: "announcements route: 分页 meta 生效",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const token = await createUserToken("admin");
    for (let i = 0; i < 3; i++) {
      await createViaApi(token, { title: `公告-${ts}-${i}` });
    }
    const app = createApp();
    const res = await app.request("/api/v1/announcements?page=2&per_page=1");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.meta.page, 2);
    assertEquals(body.meta.per_page, 1);
    assertEquals(body.meta.total, 3);
    assertEquals(body.data.length, 1);
  },
});

Deno.test({
  name: "announcements route: 创建校验 400 + 更新不存在 404 + 删除 204",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const token = await createUserToken("admin");
    const app = createApp();

    // 空 title → 400
    const bad = await app.request("/api/v1/admin/announcements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "", content: "x" }),
    });
    assertEquals(bad.status, 400);

    // 更新不存在 → 404
    const missing = await app.request(
      "/api/v1/admin/announcements/00000000-0000-0000-0000-000000000000",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: "x" }),
      },
    );
    assertEquals(missing.status, 404);

    // 创建 → 删除 → 204
    const created = await createViaApi(token);
    const delRes = await app.request(
      `/api/v1/admin/announcements/${created.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(delRes.status, 204);
  },
});

Deno.test({
  name: "announcements route: 管理列表含下架 + is_active 筛选",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const token = await createUserToken("admin");
    await createViaApi(token, { is_active: false });

    const app = createApp();
    const headers = { Authorization: `Bearer ${token}` };

    const allRes = await app.request("/api/v1/admin/announcements", {
      headers,
    });
    const all = await allRes.json();
    assertEquals(all.meta.total, 1);

    const activeRes = await app.request(
      "/api/v1/admin/announcements?is_active=true",
      { headers },
    );
    const active = await activeRes.json();
    assertEquals(active.meta.total, 0);
  },
});

Deno.test({
  name: "announcements route: RBAC seed 含 announcement:manage 且 admin 拥有",
  ignore: skipDb || skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createUserToken("admin"); // 触发 ensureRbacSeeds

    const db = getDb();
    const perm = await db.select().from(permissions).where(
      and(
        eq(permissions.resource, "announcement"),
        eq(permissions.action, "manage"),
      ),
    );
    assertEquals(perm.length, 1);

    // admin 角色显式拥有该权限
    const adminRole = await db.select().from(roles)
      .where(eq(roles.name, "admin")).limit(1);
    assertEquals(adminRole.length, 1);
    const grants = await db.select().from(rolePermissions).where(
      and(
        eq(rolePermissions.role_id, adminRole[0].id),
        eq(rolePermissions.permission_id, perm[0].id),
      ),
    );
    assertEquals(grants.length, 1);
  },
});
