/**
 * 支持包服务层测试。
 *
 * 依赖 DATABASE_URL 环境变量。
 * 测试前自动运行迁移并 seed root 用户（见 00_migrate_test.ts）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  deleteSupportPackage,
  getSupportPackageBytes,
  saveSupportPackage,
} from "../../src/services/support-package.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../src/lib/errors.ts";
import { isStorageUrl, parseStorageUrl } from "../../src/lib/storage/types.ts";
import { resetStorageProvider } from "../../src/lib/storage/mod.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

const ts = Date.now();
const OWNER_ID = `test-owner-${ts}`;
const ADMIN_ID = "0";
const TEST_NUMBER = 40000 + (ts & 0x7fff);

/** 每个测试独立的问题 ID 计数器，避免同文件内 PK 冲突 */
let problemSeq = 0;
let currentProblemId = "";

/**
 * 创建测试用户（确保 FK 约束满足）。
 */
async function createTestUser(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `tuser-${id}`,
    email: `tuser-${id}@test.com`,
    password_hash: "not-used",
    role: "user",
    created_at: now,
    updated_at: now,
  });
}

/**
 * 创建测试题目（直接 DB 插入，绕过 whitelist 校验）。自动使用独立 ID 避免 PK 冲突。
 */
async function createTestProblem(
  ownerId: string = OWNER_ID,
  type: string = "U",
): Promise<string> {
  const db = getDb();
  currentProblemId = `test-sp-problem-${ts}-${++problemSeq}`;
  // 确保 owner 用户存在（FK 约束）
  const existingOwner = await db.select().from(users).where(
    eq(users.id, ownerId),
  ).limit(1);
  if (existingOwner.length === 0) {
    await createTestUser(ownerId);
  }
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: currentProblemId,
    title: `支持包测试题目 ${ts}`,
    description: "测试描述",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: TEST_NUMBER + problemSeq,
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });
  return currentProblemId;
}

Deno.test({
  name:
    "support-package service: saveSupportPackage 上传成功返回 noj-storage:// URL",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    const zipData = new Uint8Array([
      0x50,
      0x4b,
      0x05,
      0x06,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const result = await saveSupportPackage(
      currentProblemId,
      { name: "test.zip", data: zipData },
      OWNER_ID,
      "user",
    );

    // 验证返回的是 noj-storage:// URL
    assertEquals(isStorageUrl(result), true);
    const parsed = parseStorageUrl(result);
    assertEquals(parsed.provider, "local");
    assertEquals(typeof parsed.checksumSha256, "string");

    // 验证 DB 已更新
    const db = getDb();
    const [row] = await db
      .select({ url: problems.support_package_storage_url })
      .from(problems)
      .where(eq(problems.id, currentProblemId))
      .limit(1);
    assertEquals(row?.url, result);
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage 非 zip 扩展名拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    await assertRejects(
      () =>
        saveSupportPackage(
          currentProblemId,
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
    resetStorageProvider();
    await createTestProblem();

    await assertRejects(
      () =>
        saveSupportPackage(
          currentProblemId,
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
    resetStorageProvider();
    await createTestProblem("other-owner");

    const zipData = new Uint8Array(10);
    const result = await saveSupportPackage(
      currentProblemId,
      { name: "admin-test.zip", data: zipData },
      ADMIN_ID,
      "admin",
    );
    assertEquals(isStorageUrl(result), true);
  },
});

Deno.test({
  name: "support-package service: saveSupportPackage P 型非 admin 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem(OWNER_ID, "P");

    await assertRejects(
      () =>
        saveSupportPackage(
          currentProblemId,
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
    resetStorageProvider();
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
    resetStorageProvider();
    await createTestProblem();

    // 先上传
    const url = await saveSupportPackage(
      currentProblemId,
      { name: "test.zip", data: new Uint8Array(10) },
      OWNER_ID,
      "user",
    );
    assertEquals(isStorageUrl(url), true);

    // 再删除
    await deleteSupportPackage(currentProblemId, OWNER_ID, "user");

    // 验证 DB 已清空
    const db = getDb();
    const [row] = await db
      .select({ url: problems.support_package_storage_url })
      .from(problems)
      .where(eq(problems.id, currentProblemId))
      .limit(1);
    assertEquals(row?.url, null);
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 幂等：无文件时也成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    // 删除不存在的支持包应幂等
    await deleteSupportPackage(currentProblemId, OWNER_ID, "user");
    // 再次删除仍应成功
    await deleteSupportPackage(currentProblemId, OWNER_ID, "user");
  },
});

Deno.test({
  name: "support-package service: deleteSupportPackage 非 owner 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    await assertRejects(
      () => deleteSupportPackage(currentProblemId, "other-user", "user"),
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
    resetStorageProvider();
    await assertRejects(
      () => deleteSupportPackage("nonexistent", ADMIN_ID, "admin"),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "support-package service: getSupportPackageBytes 返回存储的数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    const zipData = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    await saveSupportPackage(
      currentProblemId,
      { name: "test.zip", data: zipData },
      OWNER_ID,
      "user",
    );

    const bytes = await getSupportPackageBytes(
      currentProblemId,
      OWNER_ID,
      "user",
    );
    assertEquals(bytes !== null, true);
    if (bytes) {
      assertEquals(bytes.length, zipData.length);
    }
  },
});

Deno.test({
  name: "support-package service: getSupportPackageBytes 无支持包返回 null",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    const bytes = await getSupportPackageBytes(
      currentProblemId,
      OWNER_ID,
      "user",
    );
    assertEquals(bytes, null);
  },
});

Deno.test({
  name: "support-package service: getSupportPackageBytes 非 owner 返回 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetStorageProvider();
    await createTestProblem();

    await assertRejects(
      () => getSupportPackageBytes(currentProblemId, "other-user", "user"),
      ForbiddenError,
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
      await db.delete(problems).where(eq(problems.id, currentProblemId));
      await db.delete(users).where(eq(users.id, OWNER_ID));
    } catch {
      // ignore
    }
  },
});
