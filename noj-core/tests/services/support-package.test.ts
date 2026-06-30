/**
 * 支持包服务层测试。
 *
 * 依赖 DATABASE_URL 环境变量。
 * 测试前自动运行迁移并 seed root 用户（见 00_migrate_test.ts）。
 */
import {
  assertEquals,
  assertRejects,
} from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  saveSupportPackage,
  deleteSupportPackage,
  getPackagePath,
  PACKAGES_DIR,
} from "../../src/services/support-package.ts";
import { NotFoundError, ForbiddenError, ValidationError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `test-sp-problem-${ts}`;
const TEST_PROBLEM_UUID = crypto.randomUUID();
const OWNER_ID = `test-owner-${ts}`;
const ADMIN_ID = "0";

/**
 * 创建测试题目（直接 DB 插入，绕过 whitelist 校验）。
 */
async function createTestProblem(
  id: string,
  ownerId: string = OWNER_ID,
  type: string = "U",
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `支持包测试题目 ${ts}`,
    description: "测试描述",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: 9997,
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "support-package service: saveSupportPackage 上传成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    const zipData = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = await saveSupportPackage(
      TEST_PROBLEM_ID,
      { name: "test.zip", data: zipData },
      OWNER_ID,
      "user",
    );
    assertEquals(result, getPackagePath(TEST_PROBLEM_ID));

    // 验证文件已写入
    const fileInfo = await Deno.stat(getPackagePath(TEST_PROBLEM_ID));
    assertEquals(fileInfo.isFile, true);

    // 验证 DB 已更新
    const db = getDb();
    const [row] = await db
      .select({ path: problems.support_package_path })
      .from(problems)
      .where(eq(problems.id, TEST_PROBLEM_ID))
      .limit(1);
    assertEquals(row?.path, getPackagePath(TEST_PROBLEM_ID));
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage 非 zip 扩展名拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    await assertRejects(
      () =>
        saveSupportPackage(
          TEST_PROBLEM_ID,
          { name: "test.exe", data: new Uint8Array(10) },
          OWNER_ID,
          "user",
        ),
      ValidationError,
      "仅支持 .zip 格式文件",
    );
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage 非 owner 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    await assertRejects(
      () =>
        saveSupportPackage(
          TEST_PROBLEM_ID,
          { name: "test.zip", data: new Uint8Array(10) },
          "other-user",
          "user",
        ),
      ForbiddenError,
    );
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage admin 可替任意题上传",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID, "other-owner");

    const zipData = new Uint8Array(10);
    const result = await saveSupportPackage(
      TEST_PROBLEM_ID,
      { name: "admin-test.zip", data: zipData },
      ADMIN_ID,
      "admin",
    );
    assertEquals(result, getPackagePath(TEST_PROBLEM_ID));
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage P 型非 admin 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID, OWNER_ID, "P");

    await assertRejects(
      () =>
        saveSupportPackage(
          TEST_PROBLEM_ID,
          { name: "test.zip", data: new Uint8Array(10) },
          OWNER_ID,
          "user",
        ),
      ForbiddenError,
      "仅管理员可管理管理题的支持包",
    );
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage 不存在的题目返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        saveSupportPackage(
          "nonexistent",
          { name: "test.zip", data: new Uint8Array(10) },
          ADMIN_ID,
          "admin",
        ),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 删除成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    // 先上传
    await saveSupportPackage(
      TEST_PROBLEM_ID,
      { name: "test.zip", data: new Uint8Array(10) },
      OWNER_ID,
      "user",
    );

    // 再删除
    await deleteSupportPackage(TEST_PROBLEM_ID, OWNER_ID, "user");

    // 验证文件已删除
    await assertRejects(
      () => Deno.stat(getPackagePath(TEST_PROBLEM_ID)),
      Deno.errors.NotFound,
    );

    // 验证 DB 已清空
    const db = getDb();
    const [row] = await db
      .select({ path: problems.support_package_path })
      .from(problems)
      .where(eq(problems.id, TEST_PROBLEM_ID))
      .limit(1);
    assertEquals(row?.path, null);
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 幂等：无文件时也成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    // 删除不存在的支持包应幂等
    await deleteSupportPackage(TEST_PROBLEM_ID, OWNER_ID, "user");
    // 再次删除仍应成功
    await deleteSupportPackage(TEST_PROBLEM_ID, OWNER_ID, "user");
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 非 owner 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem(TEST_PROBLEM_ID);

    await assertRejects(
      () => deleteSupportPackage(TEST_PROBLEM_ID, "other-user", "user"),
      ForbiddenError,
    );
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 不存在的题目返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => deleteSupportPackage("nonexistent", ADMIN_ID, "admin"),
      NotFoundError,
    );
  },
});

// 清理
Deno.test({
  name: "support-package service: cleanup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, TEST_PROBLEM_ID));
      await db.delete(problems).where(eq(problems.id, TEST_PROBLEM_UUID));
    } catch {
      // ignore
    }
    // 清理文件
    try {
      await Deno.remove(getPackagePath(TEST_PROBLEM_ID));
    } catch {
      // ignore
    }
  },
});
