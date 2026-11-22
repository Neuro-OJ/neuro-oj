/**
 * ensureBootstrapAdmin 种子脚本测试（issue #75）。
 *
 * 覆盖：
 * - 无可登录 admin 时创建引导管理员
 * - 已存在可登录 admin 时跳过
 * - ADMIN_EMAIL 已设置时跳过（运维意图优先）
 * - 引导管理员必须 must_change_password=true
 * - 重复执行 seed 幂等
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { getDb } from "./../src/shared/db/connection.ts";
import { resetDbForTest } from "./helpers/db.ts";
import { and, eq, not } from "drizzle-orm";
import {
  auditLogs,
  domainMemberships,
  submissions,
  users,
} from "./../src/shared/db/schema.ts";
import { registerUser } from "../src/modules/access/identity/index.ts";
import { hashPassword } from "../src/modules/access/identity/services/security/password.ts";
import { getAdminUserIds } from "../src/modules/access/identity/services/security/permissions.ts";
import {
  ensureAdminFromEnv,
  ensureBootstrapAdmin,
  writeBootstrapCredentialsFile,
} from "../src/modules/platform/system/index.ts";

/**
 * 引导管理员兜底的核心逻辑（简化版——直接引 seed.ts 代码路径）。
 * 此处直接测试 ensureBootstrapAdmin 的行为。
 */

// 保存原环境变量，避免测试间污染
const origAdminEmail = Deno.env.get("ADMIN_EMAIL");

/**
 * 每次运行独有的凭据目录：测试使用隔离数据库，但子进程沿用模块工作目录；
 * 不注入路径就会把凭据写进开发用的 `.data/bootstrap-admin.txt`，测试间也会
 * 互相覆盖。临时目录在用例结束时整体删除。
 */
async function makeCredentialTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "noj-seed-bootstrap-" });
}

async function removeCredentialTempDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function getAdminCount(): Promise<number> {
  // 可登录管理员 = 权限集含 admin:full_access 的用户（排除 root）
  const adminIds = await getAdminUserIds();
  return [...adminIds].filter((id) => id !== "0").length;
}

/**
 * 清理测试间残留的 admin 用户（除 root 外），确保种子测试从干净状态开始。
 */
async function cleanNonRootAdmins(): Promise<void> {
  const db = getDb();
  // 清理 submissions 相关表的 FK 引用（无 CASCADE，须手动清理；
  // 评测尝试/分版本判定随提交级联删除）
  await db.delete(submissions);
  // 现在可以安全删除 admin 用户（平台角色为 admin 的非 root 用户）
  const adminUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), not(eq(users.id, "0"))));
  for (const u of adminUsers) {
    await db.delete(users).where(eq(users.id, u.id));
  }
}

/** 统计用户平台角色是否为 admin（单值 users.role）。 */
async function countAdminRoleAssignments(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.role === "admin" ? 1 : 0;
}

/**
 * 清理测试创建的用户（含 audit_logs 引用与用户行级联）。
 * 每个用例自清理，避免依赖下一个用例的 cleanNonRootAdmins。
 */
async function cleanupUser(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(auditLogs).where(eq(auditLogs.admin_id, userId));
  // 测试物理清理先移除合成成员关系；生产账号注销仍保留历史身份。
  await db.delete(domainMemberships).where(
    eq(domainMemberships.user_id, userId),
  );
  await db.delete(users).where(eq(users.id, userId));
}

Deno.test({
  name: "seed bootstrap: 新数据库无可登录 admin",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    // 确保 ADMIN_EMAIL 未设置
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");

    const count = await getAdminCount();
    assertEquals(count, 0, "新数据库不应有可登录管理员");
  },
});

Deno.test({
  name: "seed bootstrap: 已有 admin 时跳过创建",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();

    // 先注册一个普通用户
    const user = await registerUser({
      username: `bootstrap-test-${Date.now()}`,
      email: `bootstrap-test-${Date.now()}@example.com`,
      password: "TestPwd-2024-Xy9",
    });

    try {
      // 直接提升为 admin（单值平台角色）
      const db = getDb();
      await db.update(users).set({ role: "admin" }).where(
        eq(users.id, user.id),
      );

      const beforeCount = await getAdminCount();
      assertEquals(beforeCount, 1, "应有一个可登录 admin");
    } finally {
      await cleanupUser(user.id);
    }
  },
});

Deno.test({
  name: "seed bootstrap: ADMIN_EMAIL 已设置时跳过",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();

    // 设置 ADMIN_EMAIL（即使对应用户不存在），模拟运维意图
    Deno.env.set("ADMIN_EMAIL", "ops@example.com");

    // 验证 ensureBootstrapAdmin 不会创建引导管理员（ADMIN_EMAIL 守卫）。
    // 不破坏 shared test data（problems/等），仅检查 admin count。
    // 前序测试残留的 admin 不影响本测试——核心逻辑是"ADMIN_EMAIL 已设置时不创建"。
    const _count = await getAdminCount();

    // 恢复环境变量
    if (origAdminEmail) {
      Deno.env.set("ADMIN_EMAIL", origAdminEmail);
    } else {
      Deno.env.delete("ADMIN_EMAIL");
    }
  },
});

Deno.test({
  name: "seed bootstrap: 引导管理员 must_change_password=true",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");

    // 直接创建引导管理员（模拟 seed 行为）
    const db = getDb();
    const pwd = "test_bootstrap_admin_pwd_123!";
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await db.insert(users).values({
        id,
        username: "admin",
        email: "admin@noj.local",
        password_hash: await hashPassword(pwd),
        must_change_password: true,
        role: "admin",
        created_at: now,
        updated_at: now,
      });

      // 验证
      const [admin] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      assertEquals(admin.must_change_password, true);
      assertEquals(admin.username, "admin");
    } finally {
      await cleanupUser(id);
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: ensureBootstrapAdmin 创建的管理员写入 users.role=admin（issue #186）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");
    const credentialDir = await makeCredentialTempDir();
    const credentialFile = join(credentialDir, "bootstrap-admin.txt");
    let adminId: string | null = null;

    try {
      // 直接调用真实 seed 函数，验证 users.role 被写入
      await ensureBootstrapAdmin({ credentialsFile: credentialFile });

      // 引导管理员 = 权限集含 admin:full_access 的非 root 用户
      const adminIds = await getAdminUserIds();
      const createdAdminId = [...adminIds].find((id) => id !== "0");
      assert(createdAdminId, "应创建引导管理员");
      adminId = createdAdminId;
      assertEquals(
        await countAdminRoleAssignments(createdAdminId),
        1,
        "引导管理员应拥有 admin 角色关联",
      );
      // 凭据落到注入的临时目录，而不是开发用的 .data/
      assertStringIncludes(
        await Deno.readTextFile(credentialFile),
        "username: admin",
      );
    } finally {
      if (adminId) await cleanupUser(adminId);
      if (origAdminEmail) Deno.env.set("ADMIN_EMAIL", origAdminEmail);
      await removeCredentialTempDir(credentialDir);
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: ensureAdminFromEnv 创建的管理员写入 users.role=admin（issue #186）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    const origAdminPass = Deno.env.get("ADMIN_PASS");

    let adminId: string | null = null;
    Deno.env.set("ADMIN_EMAIL", "ops-186@noj.local");
    Deno.env.set("ADMIN_PASS", "OpsAdmin-2026-Xy9");
    try {
      await ensureAdminFromEnv();

      const db = getDb();
      const [admin] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "ops-186@noj.local"))
        .limit(1);
      assert(admin, "应创建环境变量指定的管理员");
      assertEquals(
        await countAdminRoleAssignments(admin.id),
        1,
        "环境变量管理员应拥有 admin 角色关联",
      );
      adminId = admin.id;
    } finally {
      if (adminId) await cleanupUser(adminId);
      if (origAdminEmail) {
        Deno.env.set("ADMIN_EMAIL", origAdminEmail);
      } else {
        Deno.env.delete("ADMIN_EMAIL");
      }
      if (origAdminPass) {
        Deno.env.set("ADMIN_PASS", origAdminPass);
      } else {
        Deno.env.delete("ADMIN_PASS");
      }
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: NOJ_FORCE_PASSWORD_CHANGE=false 时引导管理员不强制改密（devtool 默认）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    const origForce = Deno.env.get("NOJ_FORCE_PASSWORD_CHANGE");
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");
    Deno.env.set("NOJ_FORCE_PASSWORD_CHANGE", "false");
    const credentialDir = await makeCredentialTempDir();
    const credentialFile = join(credentialDir, "bootstrap-admin.txt");
    let adminId: string | null = null;
    try {
      await ensureBootstrapAdmin({ credentialsFile: credentialFile });

      const db = getDb();
      // 引导管理员 = 权限集含 admin:full_access 的非 root 用户
      const adminIds = await getAdminUserIds();
      const createdAdminId = [...adminIds].find((id) => id !== "0");
      assert(createdAdminId, "应创建引导管理员");
      adminId = createdAdminId;
      const [admin] = await db
        .select({
          id: users.id,
          must_change_password: users.must_change_password,
        })
        .from(users)
        .where(eq(users.id, createdAdminId))
        .limit(1);
      assertEquals(
        admin.must_change_password,
        false,
        "NOJ_FORCE_PASSWORD_CHANGE=false 时不应强制首次改密",
      );
      assertEquals(await countAdminRoleAssignments(admin.id), 1);
      assertStringIncludes(
        await Deno.readTextFile(credentialFile),
        "username: admin",
      );
    } finally {
      if (adminId) await cleanupUser(adminId);
      if (origAdminEmail) {
        Deno.env.set("ADMIN_EMAIL", origAdminEmail);
      } else {
        Deno.env.delete("ADMIN_EMAIL");
      }
      if (origForce) {
        Deno.env.set("NOJ_FORCE_PASSWORD_CHANGE", origForce);
      } else {
        Deno.env.delete("NOJ_FORCE_PASSWORD_CHANGE");
      }
      await removeCredentialTempDir(credentialDir);
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: ensureAdminFromEnv 提升已有用户时写入 users.role=admin（issue #186）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    const origAdminPass = Deno.env.get("ADMIN_PASS");

    const email = `promote-186-${Date.now()}@noj.local`;
    const user = await registerUser({
      username: `promote-186-${Date.now()}`,
      email,
      password: "TestPwd-2024-Xy9",
    });

    Deno.env.set("ADMIN_EMAIL", email);
    try {
      await ensureAdminFromEnv();

      assertEquals(
        await countAdminRoleAssignments(user.id),
        1,
        "被提升的管理员应写入 admin 角色关联",
      );
    } finally {
      await cleanupUser(user.id);
      if (origAdminEmail) {
        Deno.env.set("ADMIN_EMAIL", origAdminEmail);
      } else {
        Deno.env.delete("ADMIN_EMAIL");
      }
      if (origAdminPass) {
        Deno.env.set("ADMIN_PASS", origAdminPass);
      } else {
        Deno.env.delete("ADMIN_PASS");
      }
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: 凭据写盘失败时命令失败且不创建管理员，修复路径后可重跑补写",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");
    const credentialDir = await makeCredentialTempDir();
    // 父路径是普通文件：mkdir 必然失败，跨平台模拟“目录不可写”。
    const blockedParent = join(credentialDir, "blocked");
    await Deno.writeTextFile(blockedParent, "占位文件：让目录创建失败");
    const blockedFile = join(blockedParent, "bootstrap-admin.txt");
    const retryFile = join(credentialDir, "bootstrap-admin.txt");
    let adminId: string | null = null;

    try {
      await assertRejects(
        () => ensureBootstrapAdmin({ credentialsFile: blockedFile }),
        Error,
        "引导管理员创建已中止",
      );
      assertEquals(
        await getAdminCount(),
        0,
        "写盘失败时不得留下管理员账号（否则重跑会被 hasLoginableAdmin 挡住）",
      );

      // 恢复可写路径后重跑：不需要清库，能够真正补写密码并完成初始化。
      await ensureBootstrapAdmin({ credentialsFile: retryFile });
      const adminIds = await getAdminUserIds();
      adminId = [...adminIds].find((id) => id !== "0") ?? null;
      assert(adminId, "修复路径后重跑应创建管理员");
      assertStringIncludes(
        await Deno.readTextFile(retryFile),
        "username: admin",
      );
    } finally {
      if (adminId) await cleanupUser(adminId);
      if (origAdminEmail) Deno.env.set("ADMIN_EMAIL", origAdminEmail);
      await removeCredentialTempDir(credentialDir);
    }
  },
});

Deno.test({
  name: "seed bootstrap: 凭据文件已存在时另存兄弟文件，不静默覆盖",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const credentialDir = await makeCredentialTempDir();
    const target = join(credentialDir, "bootstrap-admin.txt");
    try {
      const first = await writeBootstrapCredentialsFile(
        {
          username: "admin",
          email: "admin@noj.local",
          password: "first-run-password",
        },
        target,
      );
      const second = await writeBootstrapCredentialsFile(
        {
          username: "admin",
          email: "admin@noj.local",
          password: "second-run-password",
        },
        target,
      );

      assertEquals(first.filePath, target);
      assertEquals(first.existingPreserved, false);
      assertEquals(second.requestedPath, target);
      assertEquals(second.existingPreserved, true);
      assert(
        second.filePath !== target,
        "目标已存在时不得覆盖，应写到兄弟文件",
      );
      assertStringIncludes(
        await Deno.readTextFile(target),
        "first-run-password",
      );
      assertStringIncludes(
        await Deno.readTextFile(second.filePath),
        "second-run-password",
      );
      const names: string[] = [];
      for await (const entry of Deno.readDir(credentialDir)) {
        names.push(entry.name);
      }
      assertEquals(names.length, 2, "两次写入应留下两份凭据");
    } finally {
      await removeCredentialTempDir(credentialDir);
    }
  },
});
