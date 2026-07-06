import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../../src/services/categories.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { auditLogs, categories, users } from "../../src/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../src/lib/errors.ts";
import { enterTestContext } from "../../src/lib/requestContext.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

const ts = Date.now();

Deno.test({
  name: "categories service: 创建顶级分类",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const cat = await createCategory({
      name: `测试分类 ${ts}`,
      slug: `test-cat-${ts}`,
      description: "分类测试描述",
    });
    assertEquals(cat.name, `测试分类 ${ts}`);
    assertEquals(cat.slug, `test-cat-${ts}`);
    assertEquals(cat.level, 0);
    assertEquals(cat.parent_id, null);
    assertEquals(cat.children.length, 0);
  },
});

Deno.test({
  name: "categories service: 创建子分类自动计算 level",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const parent = await createCategory({
      name: "父分类",
      slug: `parent-${ts}`,
    });
    const child = await createCategory({
      name: "子分类",
      slug: `child-${ts}`,
      parent_id: parent.id,
    });
    assertEquals(child.level, 1);
    assertEquals(child.parent_id, parent.id);
  },
});

Deno.test({
  name: "categories service: slug 冲突返回 ConflictError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 先创建一个分类占用 slug
    await createCategory({
      name: "第一个",
      slug: `test-cat-slug-conflict-${ts}`,
    });
    // 同 slug 第二次创建应冲突
    await assertRejects(
      () =>
        createCategory({ name: "重复", slug: `test-cat-slug-conflict-${ts}` }),
      ConflictError,
    );
  },
});

Deno.test({
  name: "categories service: 不存在的父分类返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createCategory({
          name: "孤立子分类",
          slug: `orphan-${ts}`,
          parent_id: "nonexistent",
        }),
      BadRequestError,
      "父分类不存在",
    );
  },
});

Deno.test({
  name: "categories service: 更新分类信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const cat = await createCategory({
      name: "原名",
      slug: `rename-${ts}`,
    });
    const updated = await updateCategory(cat.id, { name: "新名" });
    assertEquals(updated.name, "新名");
  },
});

Deno.test({
  name: "categories service: 更新为循环引用返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const parent = await createCategory({
      name: "父分类",
      slug: `cycle-p-${ts}`,
    });
    const child = await createCategory({
      name: "子分类",
      slug: `cycle-c-${ts}`,
      parent_id: parent.id,
    });
    // 尝试将父分类的 parent_id 设为子分类（形成循环）
    await assertRejects(
      () => updateCategory(parent.id, { parent_id: child.id }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "categories service: 删除无子分类的分类成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const cat = await createCategory({
      name: "待删除",
      slug: `delete-${ts}`,
    });
    await deleteCategory(cat.id);
    await assertRejects(
      () => getCategory(cat.id),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "categories service: 删除有子分类的分类返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const parent = await createCategory({
      name: "父亲",
      slug: `del-parent-${ts}`,
    });
    await createCategory({
      name: "孩子",
      slug: `del-child-${ts}`,
      parent_id: parent.id,
    });
    await assertRejects(
      () => deleteCategory(parent.id),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "categories service: listCategories 返回树形结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const tree = await listCategories();
    assertEquals(Array.isArray(tree), true);
    // 验证顶级分类包含 children
    const topLevel = tree.find((c) => c.children.length > 0);
    if (topLevel) {
      assertEquals(topLevel.children[0].parent_id, topLevel.id);
    }
  },
});

Deno.test({
  name: "categories service: deleteCategory 写一条 categories.delete 审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();

    // 准备：admin 操作者（满足 audit_logs.admin_id FK）
    const db = getDb();
    const adminId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: adminId,
      username: `test-del-cat-admin-${Date.now()}`,
      email: `test-del-cat-admin-${Date.now()}@example.com`,
      password_hash: "",
      role: "admin",
      created_at: now,
      updated_at: now,
    });

    // 注入 admin actor context（logAudit 依赖 RequestContext）
    enterTestContext({
      actorId: adminId,
      actorIp: "10.0.0.77",
      actorRole: "admin",
    });

    // 创建待删除分类
    const toDelete = await createCategory({
      name: `待删除审计分类 ${Date.now()}`,
      slug: `del-cat-audit-${Date.now()}`,
      description: "将触发 categories.delete 审计",
    });

    // 清空本测试前可能存在的审计行，避免行数偏差
    await getDb().delete(auditLogs);

    // 执行：删除分类
    await deleteCategory(toDelete.id);

    // 验证：审计日志写入
    const rows = await getDb().select().from(auditLogs).where(
      eq(auditLogs.action, "categories.delete"),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].target_type, "category");
    assertEquals(rows[0].target_id, toDelete.id);
    assertEquals(rows[0].admin_id, adminId);
    assertEquals(rows[0].ip_address, "10.0.0.77");
    const detail = rows[0].detail as {
      action: string;
      name: string;
      slug: string;
    };
    assertEquals(detail.action, "categories.delete");
    assertEquals(detail.name, toDelete.name);
    assertEquals(detail.slug, toDelete.slug);
  },
});

// 清理
Deno.test({
  name: "categories service: cleanup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(categories);
    } catch {
      // ignore
    }
  },
});
