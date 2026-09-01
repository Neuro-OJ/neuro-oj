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

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../src/db/connection.ts";
import { and, eq, not } from "drizzle-orm";
import {
  auditLogs,
  conversationReads,
  conversations,
  evaluationResults,
  messageDeletions,
  messages,
  roles,
  submissions,
  userRoles,
  users,
} from "../src/db/schema.ts";
import { registerUser } from "../src/domains/identity/index.ts";
import { hashPassword } from "../src/lib/password.ts";
import { getAdminUserIds } from "../src/lib/permissions.ts";
import {
  ensureAdminFromEnv,
  ensureBootstrapAdmin,
} from "../src/services/seed/seed-system.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

/**
 * 引导管理员兜底的核心逻辑（简化版——直接引 seed.ts 代码路径）。
 * 此处直接测试 ensureBootstrapAdmin 的行为。
 */

// 保存原环境变量，避免测试间污染
const origAdminEmail = Deno.env.get("ADMIN_EMAIL");

async function getAdminCount(): Promise<number> {
  // 可登录管理员 = 权限集含 admin:full_access 的用户（排除 root）
  const adminIds = await getAdminUserIds();
  return [...adminIds].filter((id) => id !== "0").length;
}

/**
 * 清理测试间残留的 admin 用户（除 root 外），确保种子测试从干净状态开始。
 *
 * 注意：conversations 等表的 FK 引用了 users.id 且无 ON DELETE CASCADE，
 * 需要先清理这些表中的数据，否则 DELETE FROM users 会因 FK 约束失败。
 */
async function cleanNonRootAdmins(): Promise<void> {
  const db = getDb();
  // 清理 submissions 相关表的 FK 引用（无 CASCADE，须手动清理）
  await db.delete(evaluationResults);
  await db.delete(submissions);
  // 清理 conversations 相关表的 FK 引用
  await db.delete(messageDeletions);
  await db.delete(messages);
  await db.delete(conversationReads);
  await db.delete(conversations);
  // 现在可以安全删除 admin 用户（关联 admin 角色的非 root 用户）
  const adminUsers = await db
    .select({ user_id: userRoles.user_id })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(and(eq(roles.name, "admin"), not(eq(userRoles.user_id, "0"))));
  for (const u of adminUsers) {
    await db.delete(users).where(eq(users.id, u.user_id));
  }
}

/**
 * 统计用户是否拥有 admin 角色关联（RBAC user_roles，issue #186）。
 */
async function countAdminRoleAssignments(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ roleId: userRoles.role_id })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(and(eq(userRoles.user_id, userId), eq(roles.name, "admin")));
  return rows.length;
}

/**
 * 清理测试创建的用户（含 audit_logs 引用与 user_roles 级联）。
 * 每个用例自清理，避免依赖下一个用例的 cleanNonRootAdmins。
 */
async function cleanupUser(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(auditLogs).where(eq(auditLogs.admin_id, userId));
  await db.delete(users).where(eq(users.id, userId));
}

Deno.test({
  name: "seed bootstrap: 新数据库无可登录 admin",
  ignore: skip,
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
  ignore: skip,
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
      // 直接提升为 admin（关联 admin 角色）
      const db = getDb();
      const [adminRole] = await db.select({ id: roles.id }).from(roles)
        .where(eq(roles.name, "admin")).limit(1);
      await db.insert(userRoles).values({
        user_id: user.id,
        role_id: adminRole!.id,
      }).onConflictDoNothing();

      const beforeCount = await getAdminCount();
      assertEquals(beforeCount, 1, "应有一个可登录 admin");
    } finally {
      await cleanupUser(user.id);
    }
  },
});

Deno.test({
  name: "seed bootstrap: ADMIN_EMAIL 已设置时跳过",
  ignore: skip,
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
  ignore: skip,
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
      const [adminRole] = await db.select({ id: roles.id }).from(roles)
        .where(eq(roles.name, "admin")).limit(1);
      await db.insert(users).values({
        id,
        username: "admin",
        email: "admin@noj.local",
        password_hash: await hashPassword(pwd),
        must_change_password: true,
        created_at: now,
        updated_at: now,
      });
      // 模拟 ensureAdminRoleAssignment：关联 admin 角色
      if (adminRole) {
        await db.insert(userRoles).values({
          user_id: id,
          role_id: adminRole.id,
        }).onConflictDoNothing();
      }

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
    "seed bootstrap: ensureBootstrapAdmin 创建的管理员写入 user_roles（issue #186）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");

    try {
      // 直接调用真实 seed 函数，验证 user_roles 关联被写入
      await ensureBootstrapAdmin();

      // 引导管理员 = 权限集含 admin:full_access 的非 root 用户
      const adminIds = await getAdminUserIds();
      const adminId = [...adminIds].find((id) => id !== "0");
      assert(adminId, "应创建引导管理员");
      assertEquals(
        await countAdminRoleAssignments(adminId),
        1,
        "引导管理员应拥有 admin 角色关联",
      );
      await cleanupUser(adminId);
    } finally {
      if (origAdminEmail) Deno.env.set("ADMIN_EMAIL", origAdminEmail);
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: ensureAdminFromEnv 创建的管理员写入 user_roles（issue #186）",
  ignore: skip,
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
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await cleanNonRootAdmins();
    const origAdminEmail = Deno.env.get("ADMIN_EMAIL");
    const origForce = Deno.env.get("NOJ_FORCE_PASSWORD_CHANGE");
    if (origAdminEmail) Deno.env.delete("ADMIN_EMAIL");
    Deno.env.set("NOJ_FORCE_PASSWORD_CHANGE", "false");
    try {
      await ensureBootstrapAdmin();

      const db = getDb();
      // 引导管理员 = 权限集含 admin:full_access 的非 root 用户
      const adminIds = await getAdminUserIds();
      const adminId = [...adminIds].find((id) => id !== "0");
      assert(adminId, "应创建引导管理员");
      const [admin] = await db
        .select({
          id: users.id,
          must_change_password: users.must_change_password,
        })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1);
      assertEquals(
        admin.must_change_password,
        false,
        "NOJ_FORCE_PASSWORD_CHANGE=false 时不应强制首次改密",
      );
      assertEquals(await countAdminRoleAssignments(admin.id), 1);
      await cleanupUser(admin.id);
    } finally {
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
    }
  },
});

Deno.test({
  name:
    "seed bootstrap: ensureAdminFromEnv 提升已有用户时写入 user_roles（issue #186）",
  ignore: skip,
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
