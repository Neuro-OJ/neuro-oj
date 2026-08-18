/**
 * 系统初始化数据（原 scripts/seed.ts 拆分）。
 *
 * 供 CLI（scripts/noj.ts）子命令复用：
 * - `init system`：root 用户 + RBAC 预置 + 镜像白名单 + 标签
 * - `bootstrap admin`：管理员引导
 * - `dev-setup`：额外填充 dev 专用数据（E2E 守卫用户）
 *
 * 全部幂等（ON CONFLICT DO NOTHING / 存在性检查）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { judgeImages, roles, tags, userRoles, users } from "../db/schema.ts";
import { hashPassword } from "../lib/password.ts";
import { ensureSystemRoles } from "./seed-rbac.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";
import {
  ADMIN_FULL_ACCESS,
  getAdminUserIds,
  getUserPermissions,
} from "../lib/permissions.ts";

/**
 * 为管理员用户写入 RBAC 关联（issue #186）。
 *
 * RBAC 落地后（#171）管理权限由 `admin:full_access` 权限（role_permissions）
 * + `user_roles` 关联表决定。bootstrap:admin 创建用户时必须同时写入
 * `user_roles` 关联（admin 角色），否则用户不具备管理员权限。
 *
 * 幂等：先确保系统角色存在（兼容 bootstrap 早于 init system 的执行顺序），
 * 再以 ON CONFLICT DO NOTHING 写入 user_roles。
 */
async function ensureAdminRoleAssignment(userId: string): Promise<void> {
  const db = getDb();
  // 确保 admin 角色存在（独立执行 bootstrap:admin 时 roles 可能尚未 seed）
  await ensureSystemRoles();

  const [adminRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, "admin"))
    .limit(1);
  if (!adminRole) {
    console.warn("  admin 角色不存在，无法写入 user_roles 关联");
    return;
  }

  await db.insert(userRoles).values({
    user_id: userId,
    role_id: adminRole.id,
  }).onConflictDoNothing();
}

/**
 * 引导管理员是否强制首次改密（issue #75 守卫）。
 *
 * 默认 true（生产安全基线）；devtool 的 `bootstrap admin` 子命令会设置
 * `NOJ_FORCE_PASSWORD_CHANGE=false`，使开发环境管理员首次登录即可使用完整功能。
 */
function shouldForcePasswordChange(): boolean {
  return Deno.env.get("NOJ_FORCE_PASSWORD_CHANGE") !== "false";
}

/**
 * 初始化评测镜像白名单。
 * 仅保留双容器镜像（noj-evaluator-python / noj-solution-python）。
 * 幂等：使用固定 UUID 确保重复运行不重复插入。
 */
export async function seedJudgeImages(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const images = [
    {
      id: "e0000000-0000-0000-0000-000000000002",
      image: "noj-evaluator-python",
      mode: "all_versions",
      kind: "evaluator",
      description: "双容器 Evaluator (Python 3.12, noj_evaluator_sdk)",
    },
    {
      id: "e0000000-0000-0000-0000-000000000003",
      image: "noj-solution-python",
      mode: "all_versions",
      kind: "solution",
      description: "双容器 Solution (Python 3.12, noj_solution_sdk)",
    },
  ];

  for (const img of images) {
    await db.insert(judgeImages).values({
      ...img,
      created_at: now,
      updated_at: now,
    }).onConflictDoUpdate({
      target: judgeImages.id,
      set: {
        kind: img.kind,
        mode: img.mode,
        description: img.description,
        updated_at: now,
      },
    });
    console.log(`  已同步评测镜像: ${img.image} (kind=${img.kind})`);
  }
}

/**
 * 初始化种子标签（issue #223：category 系统退役，双类标签取代）。
 */
export async function seedTags(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const seed = [
    // 题目标签（人人可见）
    { id: "tag-lmcc", name: "LMCC 样例题", kind: "problem" },
    { id: "tag-beginner", name: "入门", kind: "problem" },
    // 算法标签（通过题目后可见）
    { id: "tag-simulate", name: "模拟", kind: "algorithm" },
    { id: "tag-sliding-window", name: "滑动窗口", kind: "algorithm" },
    { id: "tag-prefix-sum", name: "前缀和", kind: "algorithm" },
    { id: "tag-graph", name: "图论", kind: "algorithm" },
    { id: "tag-dp", name: "DP", kind: "algorithm" },
    { id: "tag-ds", name: "数据结构", kind: "algorithm" },
    { id: "tag-tree", name: "树", kind: "algorithm" },
  ];

  for (const tag of seed) {
    // 以 name 为幂等键：运营者若已手工创建同名标签（随机 UUID），
    // 种子跳过而不触发 name UNIQUE 冲突（语义上 name 才是标签身份）。
    await db
      .insert(tags)
      .values({ ...tag, created_at: now, updated_at: now })
      .onConflictDoNothing({ target: tags.name });
    console.log(`  已同步标签: ${tag.name} (${tag.kind})`);
  }
}

/**
 * 根据 ADMIN_EMAIL 环境变量创建/提升管理员。
 *
 * ADMIN_EMAIL 必须设置。
 * 若 ADMIN_PASS 同时设置，则自动创建用户（不存在时）并设为 admin；
 * 若 ADMIN_PASS 未设置，则仅提升已存在的用户。
 */
export async function ensureAdminFromEnv(): Promise<void> {
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  if (!adminEmail) {
    console.log("  ADMIN_EMAIL 未设置，将进入引导管理员兜底流程");
    return;
  }

  const adminPass = Deno.env.get("ADMIN_PASS");
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, adminEmail))
    .limit(1);

  if (existing.length === 0) {
    if (!adminPass) {
      console.warn(
        `  警告：用户 ${adminEmail} 不存在，且未设置 ADMIN_PASS，无法自动创建`,
      );
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const username = adminEmail.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");

    await db.insert(users).values({
      id,
      username,
      email: adminEmail,
      password_hash: await hashPassword(adminPass),
      must_change_password: shouldForcePasswordChange(),
      created_at: now,
      updated_at: now,
    });
    await ensureAdminRoleAssignment(id);
    const guard = shouldForcePasswordChange()
      ? "已强制首次改密"
      : "开发模式：未强制首次改密";
    console.log(`  已创建管理员用户: ${adminEmail} (${username})，${guard}`);
    return;
  }

  const user = existing[0];
  // 幂等判断：已通过 RBAC 拥有 admin:full_access 权限则跳过
  const perms = await getUserPermissions(user.id);
  if (perms.has(ADMIN_FULL_ACCESS)) {
    console.log(`  用户 ${adminEmail} 已是管理员，无需提升`);
    return;
  }

  await ensureAdminRoleAssignment(user.id);
  console.log(`  已提升用户 ${adminEmail} 为管理员`);
}

/**
 * 生成 24 字符 base64url 强随机密码（issue #75，评审修复 M4）。
 *
 * base64url 字符集 [A-Za-z0-9_-] 共 64 字符，每字符 6 bits 熵。
 * 24 字符 × 6 bits = 144 bits 熵，满足 NIST SP 800-63B 临时凭证要求。
 */
function generateStrongPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 24);
}

/**
 * 引导管理员兜底（issue #75）。
 *
 * 当系统中不存在任何可登录管理员（权限集含 admin:full_access 且 id!='0'）时，
 * 自动创建一个临时管理员（username=admin / email=admin@noj.local /
 * 24 字符随机密码，must_change_password=true），凭据打印到终端。
 * 已存在可登录 admin 时本函数为 no-op，可重复运行（幂等）。
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (Deno.env.get("ADMIN_EMAIL")) {
    console.log("  ADMIN_EMAIL 已设置，遵循环境变量配置，跳过引导管理员创建");
    return;
  }

  const db = getDb();

  // 存在可登录管理员（admin:full_access 权限，含继承链，排除 root）则跳过
  const adminIds = await getAdminUserIds();
  const hasLoginableAdmin = [...adminIds].some((id) => id !== ROOT_USER_ID);
  if (hasLoginableAdmin) {
    console.log("  已存在可登录管理员，跳过引导管理员创建");
    return;
  }

  const username = "admin";
  const email = "admin@noj.local";
  const password = generateStrongPassword();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    username,
    email,
    password_hash: await hashPassword(password),
    must_change_password: shouldForcePasswordChange(),
    created_at: now,
    updated_at: now,
  });
  await ensureAdminRoleAssignment(id);

  console.log("");
  console.log("-".repeat(72));
  if (shouldForcePasswordChange()) {
    console.log("⚠ 已创建临时引导管理员（首次登录后必须修改密码）");
  } else {
    console.log("✓ 已创建开发引导管理员（未强制首次改密，可直接使用完整功能）");
  }
  console.log("-".repeat(72));
  console.log(`  username: ${username}`);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log("-".repeat(72));
  if (shouldForcePasswordChange()) {
    console.log("⚠ 请立即记录上述密码，首次登录后系统会强制要求修改密码。");
  }
  console.log("-".repeat(72));
  console.log("");
}

/**
 * 创建 E2E 守卫测试专用用户（must_change_password=true）。
 *
 * 仅在 NOJ_RUN_E2E=1 时创建，供 noj-tests/e2e/08_password_change_guard.test.ts
 * 验证 PASSWORD_CHANGE_REQUIRED 守卫（评审修复 H2）。
 * 幂等：用户存在时跳过。
 */
export async function ensureE2EPwChangeUser(): Promise<void> {
  if (Deno.env.get("NOJ_RUN_E2E") !== "1") return;

  const email = "e2e_pwchange@test.com";
  const pass = "e2e_pwchange_pass_8chars";
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`  E2E 守卫测试用户 ${email} 已存在，跳过创建`);
    return;
  }

  const now = new Date().toISOString();
  await db.insert(users).values({
    id: crypto.randomUUID(),
    username: "e2e_pwchange",
    email,
    password_hash: await hashPassword(pass),
    must_change_password: true,
    created_at: now,
    updated_at: now,
  });
  console.log(
    `  已创建 E2E 守卫测试用户: ${email} (must_change_password=true)`,
  );
}
