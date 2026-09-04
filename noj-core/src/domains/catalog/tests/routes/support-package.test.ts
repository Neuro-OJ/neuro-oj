/**
 * 支持包路由层测试（上传端点已废弃，仅保留删除/下载相关）。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  problems,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { ensureRbacSeeds } from "../../../system/index.ts";
import { eq, sql } from "drizzle-orm";
import { createUserToken } from "../../../../../tests/helper.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

const ts = Date.now();
const OWNER_ID = `route-sp-owner-${ts}`;
const TEST_NUMBER = 60000 + (ts & 0x7fff);

let problemSeq = 0;
const problemIdRef: string[] = [];

/**
 * 创建测试用户（确保 FK 约束满足）。
 */
async function createTestUser(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `rtuser-${id}`,
    email: `rtuser-${id}@test.com`,
    password_hash: "not-used",
    created_at: now,
    updated_at: now,
  });
  // NOJ-102：owner 权限现在走实时 RBAC，测试用户需挂载默认 user 角色。
  await ensureRbacSeeds();
  const [userRole] = await db.select({ id: roles.id }).from(roles).where(
    eq(roles.name, "user"),
  ).limit(1);
  if (userRole) {
    await db.insert(userRoles).values({ user_id: id, role_id: userRole.id })
      .onConflictDoNothing();
  }
}

/**
 * 创建测试题目（直接 DB 插入）。
 */
async function createTestProblem(
  ownerId: string = OWNER_ID,
  type: string = "U",
): Promise<string> {
  const db = getDb();
  const pid = `route-sp-problem-${ts}-${++problemSeq}`;
  problemIdRef[0] = pid;
  if (ownerId !== "0") {
    const existingOwner = await db.select().from(users).where(
      eq(users.id, ownerId),
    ).limit(1);
    if (existingOwner.length === 0) {
      await createTestUser(ownerId);
    }
  }
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: pid,
    title: `支持包路由测试 ${ts}`,
    description: "测试描述",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    number: TEST_NUMBER + problemSeq,
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });
  return pid;
}

Deno.test({
  name: "support-package route: POST 上传端点已移除返回 404",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const blob = new Blob(["not a zip"], { type: "text/plain" });
    const formData = new FormData();
    formData.append("file", blob, "test.zip");

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "support-package route: DELETE 删除成功",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const pid = await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    // 直接设置评测包 URL（等价于导入端点写入后的状态）
    const db = getDb();
    await db
      .update(problems)
      .set({
        support_package_storage_url:
          "noj-storage://local/dGVzdA?checksum_sha256=abc",
        updated_at: new Date().toISOString(),
      })
      .where(eq(problems.id, pid));

    // 再删除
    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.support_package_storage_url, null);
  },
});

Deno.test({
  name: "support-package route: DELETE 不存在的支持包幂等返回 200",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem();
    const app = createApp();
    const token = await signToken({ sub: OWNER_ID, role: "user" });

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "support-package route: DELETE 非 owner 返回 403",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createTestProblem();
    const app = createApp();
    const token = await createUserToken();

    const res = await app.request(
      `/api/v1/problems/${problemIdRef[0]}/support-package`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assertEquals(res.status, 403);
  },
});

// 清理
Deno.test({
  name: "support-package route: cleanup",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(problems).where(
        sql`${problems.id} LIKE 'route-sp-problem-%'`,
      );
      await db.delete(users).where(eq(users.id, OWNER_ID));
    } catch {
      // ignore
    }
  },
});
