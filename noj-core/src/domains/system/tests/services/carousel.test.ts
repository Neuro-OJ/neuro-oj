/**
 * 轮播 slide 服务与路由测试。
 *
 * 覆盖：公开端过滤 disabled 且按 sort_order；CRUD 往返；reorder 生效；
 * kind 校验（image 缺图 / text 缺标题）；权限（非管理员 403）；重排列表不完整 400。
 *
 * 依赖 PGlite 内存数据库 + JWT_SECRET。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { createUserToken } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { ValidationError } from "../../../../shared/base/errors.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { auditLogs, users } from "../../../../shared/db/schema.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  createSlide,
  deleteSlide,
  enterTestContext,
  leaveTestContext,
  listAllSlides,
  listEnabledSlides,
  reorderSlides,
  updateSlide,
  uploadCarouselImage,
} from "../../index.ts";

const ts = Date.now();

Deno.test({
  name: "carousel: 公开端仅返回启用项且按 sort_order 升序",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const a = await createSlide({ kind: "text", title: `A-${ts}` });
    const b = await createSlide({ kind: "text", title: `B-${ts}` });
    const c = await createSlide({
      kind: "text",
      title: `C-${ts}`,
      is_enabled: false,
    });

    // 调换顺序为 b, a, c（c 停用；reorder 要求覆盖全部 slides）
    await reorderSlides([b, a, c]);

    const enabled = await listEnabledSlides();
    assertEquals(enabled.length, 2);
    assertEquals(enabled[0]!.id, b);
    assertEquals(enabled[1]!.id, a);
  },
});

Deno.test({
  name: "carousel: CRUD 往返（新建追加末尾、更新、删除）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const id1 = await createSlide({ kind: "text", title: `T1-${ts}` });
    const id2 = await createSlide({
      kind: "image",
      image_storage_url: "https://cdn.example.test/a.png",
    });

    const all = await listAllSlides();
    assertEquals(all.length, 2);
    // 新建追加到末尾：id1 在前
    assertEquals(all[0]!.id, id1);
    assertEquals(all[1]!.id, id2);
    assertEquals(all[1]!.kind, "image");

    // 部分更新：仅切换 is_enabled，其余字段沿用
    await updateSlide(id2, { is_enabled: false });
    const afterUpdate = await listAllSlides();
    const updated = afterUpdate.find((s) => s.id === id2)!;
    assertEquals(updated.is_enabled, false);
    assertEquals(updated.image_storage_url, "https://cdn.example.test/a.png");

    await deleteSlide(id1);
    assertEquals((await listAllSlides()).length, 1);
  },
});

Deno.test({
  name: "carousel: kind 校验（image 缺图 / text 缺标题 / 非法 gradient）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await assertRejects(
      () => createSlide({ kind: "image" }),
      ValidationError,
    );
    await assertRejects(
      () => createSlide({ kind: "text" }),
      ValidationError,
    );
    await assertRejects(
      () => createSlide({ kind: "text", title: "x", gradient_key: "bogus" }),
      ValidationError,
    );
  },
});

Deno.test({
  name: "carousel: reorder 列表不完整时拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const a = await createSlide({ kind: "text", title: `a-${ts}` });
    await createSlide({ kind: "text", title: `b-${ts}` });
    // 只给一个 id（缺漏）
    await assertRejects(() => reorderSlides([a]), ValidationError);
    // 重复
    await assertRejects(() => reorderSlides([a, a]), ValidationError);
  },
});

Deno.test({
  name: "carousel: 上传图片非法类型被拒（BadRequestError）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const bad = new File([new Uint8Array([1, 2, 3, 4])], "x.png", {
      type: "image/png",
    });
    await assertRejects(() => uploadCarouselImage(bad), BadRequestError);
  },
});

Deno.test({
  name: "carousel: 公开路由返回启用项，管理路由非管理员 403",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await createSlide({ kind: "text", title: `pub-${ts}` });

    const app = createApp();
    // 公开（无认证）
    const pub = await app.request("/api/v1/carousel/slides");
    assertEquals(pub.status, 200);
    const pubBody = await pub.json();
    assertEquals(pubBody.data.length, 1);

    // 非管理员访问管理端
    const userToken = await createUserToken("user");
    const denied = await app.request("/api/v1/admin/carousel/slides", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assertEquals(denied.status, 403);

    // 管理员可访问
    const adminToken = await createUserToken("admin");
    const ok = await app.request("/api/v1/admin/carousel/slides", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assertEquals(ok.status, 200);
  },
});

Deno.test({
  name: "carousel: 经 HTTP 路由的写操作落审计（覆盖 withActorContext 挂载）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    // 注意：本测试经真实路由（非 enterTestContext 直注），用于覆盖
    // admin carousel router 的组级 withActorContext 装配是否正确。
    const app = createApp();
    const adminToken = await createUserToken("admin");

    const created = await app.request("/api/v1/admin/carousel/slides", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ kind: "text", title: `路由审计-${ts}` }),
    });
    assertEquals(created.status, 201);

    const db = getDb();
    const logs = await db.select().from(auditLogs);
    assertEquals(
      logs.some((l) => l.action === "carousel.create"),
      true,
    );
  },
});

Deno.test({
  name: "carousel: 写操作落审计日志（含 RequestContext 注入）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const actorId = "carousel-audit-actor";
    await db.insert(users).values({
      id: actorId,
      username: "carousel_actor",
      email: "carousel_actor@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing();
    enterTestContext({
      actorId,
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      const id = await createSlide({ kind: "text", title: `审计-${ts}` });
      await updateSlide(id, { title: `审计改-${ts}` });
      await deleteSlide(id);

      const logs = await db.select().from(auditLogs);
      const actions = logs.map((l) => l.action);
      assertEquals(actions.includes("carousel.create"), true);
      assertEquals(actions.includes("carousel.update"), true);
      assertEquals(actions.includes("carousel.delete"), true);
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "carousel: null 显式清空 link_url（留空则不可点）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const id = await createSlide({
      kind: "text",
      title: `清空-${ts}`,
      link_url: "/problems",
    });
    // 显式传 null → 清空
    await updateSlide(id, { link_url: null });
    const row = (await listAllSlides()).find((s) => s.id === id)!;
    assertEquals(row.link_url, null);
    // 不传（undefined）→ 沿用
    await updateSlide(id, { title: `改题-${ts}` });
    const row2 = (await listAllSlides()).find((s) => s.id === id)!;
    assertEquals(row2.title, `改题-${ts}`);
  },
});

Deno.test({
  name: "carousel: 公开图片端点返回字节与 Content-Type（上传→读取）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    // 1x1 PNG（合法 magic bytes）
    const pngBytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
      0x1f,
      0x15,
      0xc4,
      0x89,
      0x00,
      0x00,
      0x00,
      0x0a,
      0x49,
      0x44,
      0x41,
      0x54,
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01,
      0x0d,
      0x0a,
      0x2d,
      0xb4,
      0x00,
      0x00,
      0x00,
      0x00,
      0x49,
      0x45,
      0x4e,
      0x44,
      0xae,
      0x42,
      0x60,
      0x82,
    ]);
    const file = new File([pngBytes], "a.png", { type: "image/png" });
    const url = await uploadCarouselImage(file);
    const id = await createSlide({ kind: "image", image_storage_url: url });

    const { getCarouselImageBytes } = await import("../../index.ts");
    const result = await getCarouselImageBytes(id);
    assertEquals(result.contentType, "image/png");
    assertEquals(result.bytes.length > 0, true);

    // 2026-09-25 评审：停用后的幻灯片不得再通过公开端点取图
    const { updateSlide } = await import("../../index.ts");
    await updateSlide(id, { is_enabled: false });
    await assertRejects(
      () => getCarouselImageBytes(id),
      NotFoundError,
    );
  },
});
