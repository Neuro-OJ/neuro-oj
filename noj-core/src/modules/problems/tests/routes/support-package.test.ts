/**
 * 支持包路由层测试（上传端点已废弃，仅保留删除/下载相关）。
 *
 * 依赖 DATABASE_URL + JWT_SECRET 环境变量。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { decodeJwt } from "jose";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../access/identity/index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problems,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { ensureRbacSeeds } from "../../../platform/system/index.ts";
import { eq, sql } from "drizzle-orm";
import {
  bindPublishedProblemForTest,
  createUserToken,
} from "../../../../../tests/helper.ts";

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
  await grantDefaultCatalogRole(ownerId, "editor");
  const now = new Date().toISOString();
  await db.insert(problems).values({
    domain_id: "00000000-0000-4000-8000-000000000001",
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
    created_at: now,
    updated_at: now,
  });
  return pid;
}

/** 读取域草稿的当前 revision（写文件引用必须带它）。 */
async function currentDraftRevision(
  problemId: string,
  token: string,
): Promise<number> {
  const res = await createApp().request(
    (await domainSupportPackageUrl(problemId)).replace(
      /\/support-package$/,
      "/draft",
    ),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json() as {
    draft_revision?: number;
    data?: { draft_revision?: number };
  };
  return body.draft_revision ?? body.data?.draft_revision ?? 1;
}

/** 0.11 起支持包写入只在域入口：用域题号定位题目。 */
async function domainSupportPackageUrl(problemId: string): Promise<string> {
  const [row] = await getDb().select({ number: problems.number })
    .from(problems).where(eq(problems.id, problemId)).limit(1);
  return `/api/v1/domains/main/problems/${row!.number}/support-package`;
}

Deno.test({
  name: "support-package route: POST 上传端点已移除返回 404",
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
  name: "support-package route: DELETE 非 owner 返回 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const pid = await createTestProblem();
    await bindPublishedProblemForTest(pid);
    const app = createApp();
    const token = await createUserToken();
    // 域入口要求成员身份才可能 403（非成员会得到 404 以免泄露存在性）
    await grantDefaultCatalogRole(decodeJwt(token).sub as string, "member");
    const revision = String(await currentDraftRevision(pid, token));

    const res = await app.request(
      await domainSupportPackageUrl(problemIdRef[0]),
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "If-Match": revision },
      },
    );
    assertEquals(res.status, 403);
  },
});

// 清理
Deno.test({
  name: "support-package route: cleanup",
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

import { resetDbForTest } from "../default-fixture.ts";

import { grantDefaultCatalogRole } from "../default-fixture.ts";
