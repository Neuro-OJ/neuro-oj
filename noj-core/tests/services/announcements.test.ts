/**
 * 公告服务层测试（issue #231）。
 *
 * 覆盖：CRUD 校验（400）、公开列表仅 active + 置顶排序 + excerpt 截断 + 分页、
 * 非 active 详情 404、审计日志、删除。
 *
 * 依赖 PGlite 内存数据库（无 DATABASE_URL 也可运行）。
 * 服务层经 getRequestContext() 取操作者，测试用 enterTestContext 注入。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { desc, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";
import {
  announcements,
  auditLogs,
  users,
} from "./../../src/shared/db/schema.ts";
import {
  NotFoundError,
  ValidationError,
} from "./../../src/shared/base/errors.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../src/domains/system/index.ts";
import {
  createAnnouncement,
  deleteAnnouncement,
  getPublicAnnouncement,
  listAdminAnnouncements,
  listPublicAnnouncements,
  updateAnnouncement,
} from "../../src/domains/system/index.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

const TEST_CTX = {
  actorId: "test-admin-uuid",
  actorIp: "192.168.1.100",
  actorRole: "admin",
};

/** 重置 DB + 清理 ALS + 插入测试用户（enterTestContext 需在测试 fn 内调用，
 * 经 async helper 中转时 enterWith 上下文不会传播回调用方） */
async function setup() {
  await resetDbForTest();
  leaveTestContext(); // 清理前序测试可能的 ALS 泄漏
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: TEST_CTX.actorId,
    username: "test-admin",
    email: "test-admin@example.com",
    password_hash: "",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
}

Deno.test({
  name: "announcements service: create 默认置顶/发布 + 审计日志",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const item = await createAnnouncement({
      title: "维护通知",
      content: "本周六凌晨系统维护",
    });
    assertEquals(item.is_pinned, false);
    assertEquals(item.is_active, true);
    assertEquals(item.created_by, TEST_CTX.actorId);

    const db = getDb();
    const logs = await db.select().from(auditLogs);
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "announcement.create");
    assertEquals(logs[0].target_id, item.id);
  },
});

Deno.test({
  name: "announcements service: 创建校验 title/content 长度",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    await assertRejects(
      () => createAnnouncement({ title: "", content: "x" }),
      ValidationError,
    );
    await assertRejects(
      () => createAnnouncement({ title: "a".repeat(101), content: "x" }),
      ValidationError,
    );
    await assertRejects(
      () => createAnnouncement({ title: "ok", content: "" }),
      ValidationError,
    );
    await assertRejects(
      () => createAnnouncement({ title: "ok", content: "x".repeat(50001) }),
      ValidationError,
    );
  },
});

Deno.test({
  name:
    "announcements service: 公开列表仅 active + 置顶优先 + excerpt 截断 + 分页",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const longContent = "段落" + "x".repeat(200) + "尾部";
    // 置顶（较旧）
    await createAnnouncement({
      title: "置顶公告",
      content: longContent,
      is_pinned: true,
    });
    // 非置顶（较新）
    await createAnnouncement({ title: "普通公告", content: "普通内容" });
    // 下架
    const inactive = await createAnnouncement({
      title: "已下架",
      content: "不可见",
      is_active: false,
    });

    const list = await listPublicAnnouncements(1, 20);
    assertEquals(list.meta.total, 2);
    // 置顶优先：旧置顶排在新非置顶之前
    assertEquals(list.data[0].title, "置顶公告");
    assertEquals(list.data[1].title, "普通公告");
    // excerpt 截断 120 字符
    assertEquals(list.data[0].excerpt.length, 120);
    // 列表项不含 content 全文
    assertEquals("content" in list.data[0], false);
    // 下架公告不在列表
    assertEquals(list.data.some((a) => a.id === inactive.id), false);
  },
});

Deno.test({
  name: "announcements service: 公开详情 active 可见 / 下架 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const active = await createAnnouncement({ title: "在线", content: "全文" });
    const inactive = await createAnnouncement({
      title: "下线",
      content: "x",
      is_active: false,
    });

    const detail = await getPublicAnnouncement(active.id);
    assertEquals(detail.content, "全文");
    assertEquals(detail.created_by, TEST_CTX.actorId);

    await assertRejects(
      () => getPublicAnnouncement(inactive.id),
      NotFoundError,
    );
    await assertRejects(
      () => getPublicAnnouncement("00000000-0000-0000-0000-000000000000"),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "announcements service: 管理列表含下架 + is_active 筛选 + 审计 update",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const a = await createAnnouncement({ title: "A", content: "a" });
    const b = await createAnnouncement({
      title: "B",
      content: "b",
      is_active: false,
    });

    // 全量：2 条，最新在前
    const all = await listAdminAnnouncements(1, 20);
    assertEquals(all.meta.total, 2);
    assertEquals(all.data[0].title, "B");

    // is_active 筛选
    const activeOnly = await listAdminAnnouncements(1, 20, true);
    assertEquals(activeOnly.meta.total, 1);
    assertEquals(activeOnly.data[0].id, a.id);

    // 部分更新：下架 A
    const updated = await updateAnnouncement(a.id, { is_active: false });
    assertEquals(updated.is_active, false);
    assertEquals(updated.title, "A");

    // 不存在 → 404
    await assertRejects(
      () =>
        updateAnnouncement("00000000-0000-0000-0000-000000000000", {
          title: "x",
        }),
      NotFoundError,
    );

    // 审计含 update
    const db = getDb();
    const logs = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "announcement.update"),
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].target_id, a.id);
    assertEquals(b.id !== undefined, true);
  },
});

Deno.test({
  name: "announcements service: 删除 + 审计 + 不存在 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const item = await createAnnouncement({ title: "待删", content: "x" });

    await deleteAnnouncement(item.id);

    const db = getDb();
    const rows = await db.select().from(announcements)
      .where(eq(announcements.id, item.id));
    assertEquals(rows.length, 0);

    const logs = await db.select().from(auditLogs).where(
      eq(auditLogs.action, "announcement.delete"),
    );
    assertEquals(logs.length, 1);

    await assertRejects(
      () => deleteAnnouncement("00000000-0000-0000-0000-000000000000"),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "announcements service: update 校验 title 超长",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext(TEST_CTX);
    const item = await createAnnouncement({ title: "ok", content: "x" });
    await assertRejects(
      () => updateAnnouncement(item.id, { title: "a".repeat(200) }),
      ValidationError,
    );
    // 校验失败不落库
    const db = getDb();
    const rows = await db.select().from(announcements)
      .where(eq(announcements.id, item.id))
      .orderBy(desc(announcements.created_at));
    assertEquals(rows[0].title, "ok");
  },
});
