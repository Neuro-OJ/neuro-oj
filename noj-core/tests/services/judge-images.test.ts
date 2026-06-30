/**
 * 评测镜像白名单服务层测试。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 * 测试前自动运行迁移并 seed 默认白名单条目（见 00_migrate_test.ts）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { judgeImages } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  createJudgeImage,
  deleteJudgeImage,
  listJudgeImages,
  updateJudgeImage,
  validateJudgeImage,
} from "../../src/services/judge-images.ts";
import { NotFoundError, ValidationError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;
const ts = Date.now();

Deno.test({
  name: "judge-images service: listJudgeImages 返回数组",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const items = await listJudgeImages();
    assertEquals(Array.isArray(items), true);
    // 应包含 00_migrate_test.ts 的默认 seed
    assertEquals(items.some((i) => i.image === "noj-judge-python"), true);
  },
});

Deno.test({
  name: "judge-images service: createJudgeImage 创建成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const item = await createJudgeImage({
      image: `test-image-${ts}`,
      mode: "exact",
      description: "测试用镜像",
    });
    assertEquals(item.image, `test-image-${ts}`);
    assertEquals(item.mode, "exact");
    assertEquals(item.description, "测试用镜像");
    assertEquals(typeof item.id, "string");
    assertEquals(typeof item.created_at, "string");
    assertEquals(typeof item.updated_at, "string");
  },
});

Deno.test({
  name: "judge-images service: createJudgeImage 非法 mode 拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createJudgeImage({
          image: "test-image",
          mode: "regex" as "exact" | "all_versions",
        }),
      ValidationError,
    );
  },
});

Deno.test({
  name: "judge-images service: createJudgeImage 空镜像名拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createJudgeImage({
          image: "",
          mode: "exact",
        }),
      ValidationError,
    );
  },
});

Deno.test({
  name: "judge-images service: updateJudgeImage 更新成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 先创建
    const created = await createJudgeImage({
      image: `update-test-${ts}`,
      mode: "exact",
      description: "原始介绍",
    });
    // 再更新
    const updated = await updateJudgeImage(created.id, {
      description: "更新后的介绍",
      mode: "all_versions",
    });
    assertEquals(updated.description, "更新后的介绍");
    assertEquals(updated.mode, "all_versions");
    assertEquals(updated.image, `update-test-${ts}`);
  },
});

Deno.test({
  name: "judge-images service: updateJudgeImage 不存在的 id 返回 NotFound",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => updateJudgeImage("nonexistent-id", { description: "new" }),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "judge-images service: deleteJudgeImage 删除成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createJudgeImage({
      image: `delete-test-${ts}`,
      mode: "exact",
    });
    await deleteJudgeImage(created.id);
    // 删除后再次删除应抛 NotFound
    await assertRejects(
      () => deleteJudgeImage(created.id),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "judge-images service: validateJudgeImage 有效镜像通过",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await validateJudgeImage("noj-judge-python");
    assertEquals(result, true);
  },
});

Deno.test({
  name: "judge-images service: validateJudgeImage all_versions 带标签通过",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await validateJudgeImage("noj-judge-python:latest");
    assertEquals(result, true);
  },
});

Deno.test({
  name:
    "judge-images service: validateJudgeImage 不在白名单返回 ValidationError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => validateJudgeImage("unknown-image:latest"),
      ValidationError,
    );
  },
});

Deno.test({
  name: "judge-images service: validateJudgeImage 空白名单返回 ValidationError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 清空白名单
    const db = getDb();
    await db.delete(judgeImages);
    await assertRejects(
      () => validateJudgeImage("any-image"),
      ValidationError,
      "系统尚未配置允许的评测镜像",
    );
  },
});

// 清理
Deno.test({
  name: "judge-images service: cleanup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `test-image-${ts}`),
      );
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `update-test-${ts}`),
      );
      await db.delete(judgeImages).where(
        eq(judgeImages.image, `delete-test-${ts}`),
      );
    } catch {
      // ignore
    }
  },
});
