/**
 * 题目敏感字段 RBAC 守卫路由层测试（issue #207）。
 *
 * 覆盖真实 Hono Context 的权限路径（服务层无 Context 路径见
 * tests/services/problem-field-guard.test.ts）：
 * - 默认放行：user 角色用户（默认授权）创建/更新含敏感字段的题目
 * - 收紧后拒绝：无敏感字段权限的用户设置/修改敏感字段 → 403
 * - 未触及字段放行：收紧用户仅更新标题 → 200
 * - 导入路径行为一致：收紧用户导入 → 403，admin 导入 → 200
 * - 资源上限：配置后超限创建 → 400 RESOURCE_LIMIT_EXCEEDED
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "./../../src/shared/db/connection.ts";

import {
  permissions,
  problems,
  rolePermissions,
  roles,
  users,
} from "./../../src/shared/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { ensureRbacSeeds } from "../../src/domains/system/index.ts";
import { resetSetting, updateSetting } from "../../src/domains/system/index.ts";

const dbAvailable = true;
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !dbAvailable || !hasJwt;

const ts = Date.now();
const now = new Date().toISOString();

const ADMIN_ID = `field-admin-${ts}`;
const USER_ID = `field-user-${ts}`;
const TIGHTENED_ID = `field-tight-${ts}`;

const VALID_RUNTIME_CONFIG = {
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
};

const NETWORKED_RUNTIME_CONFIG = {
  ...VALID_RUNTIME_CONFIG,
  evaluator: {
    ...VALID_RUNTIME_CONFIG.evaluator,
    network: { enabled: true },
  },
};

// ── 测试辅助 ─────────────────────────────────────

async function ensureUser(id: string, username: string): Promise<void> {
  await db.insert(users).values({
    id,
    username,
    email: `${username}@test.com`,
    password_hash: "not-used",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
}

function makeBundleZip(
  manifestOverrides: Record<string, unknown> = {},
): Uint8Array {
  const manifest = {
    format_version: 1,
    title: `导入测试题 ${ts}`,
    difficulty: "easy",
    type: "U",
    runtime_config: VALID_RUNTIME_CONFIG,
    ...manifestOverrides,
  };
  const enc = new TextEncoder();
  return zipSync({
    "problem.json": enc.encode(JSON.stringify(manifest)),
    "statement.md": enc.encode(
      `# ${manifest.title}\n\n## 样例输入 1\n\`\`\`\n1 2\n\`\`\`\n`,
    ),
    "evaluate.py": enc.encode("print('evaluator')"),
    "visible.jsonl": enc.encode('{"input": "1 2", "output": "3"}\n'),
  }, { level: 6 });
}

function makeZipBlob(overrides: Record<string, unknown> = {}): Blob {
  const zip = makeBundleZip(overrides);
  return new Blob(
    [zip.buffer.slice(
      zip.byteOffset,
      zip.byteOffset + zip.byteLength,
    ) as ArrayBuffer],
    { type: "application/zip" },
  );
}

// ── 模块级 setup ──────────────────────────────────

await resetDbForTest();

// 注意：必须在 resetDbForTest() 之后获取 db——reset 会关闭旧连接池
// （PG 模式 _client.end()），setup 前缓存的引用指向已关闭的池会报
// CONNECTION_ENDED
const db = getDb();
await ensureRbacSeeds();

await ensureUser(ADMIN_ID, `field-admin-${ts}`);
await ensureUser(USER_ID, `field-user-${ts}`);
await ensureUser(TIGHTENED_ID, `field-tight-${ts}`);

// 分配角色：admin / user 走预置角色；收紧用户用无敏感字段权限的自定义角色
const [adminRole] = await db.select({ id: roles.id }).from(roles).where(
  eq(roles.name, "admin"),
).limit(1);
const [userRole] = await db.select({ id: roles.id }).from(roles).where(
  eq(roles.name, "user"),
).limit(1);

const tightenedRoleId = `tightened-role-${ts}`;
await db.insert(roles).values({
  id: tightenedRoleId,
  name: `tightened-${ts}`,
  description: "测试收紧角色（无敏感字段权限，但保留 write_own）",
  is_system: false,
  is_default: false,
  parent_id: null,
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();
// NOJ-102：owner 编辑/删除现在需要细粒度权限；为隔离敏感字段变量，补 write_own。
{
  const [writeOwnPerm] = await db.select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.resource, "problem"),
        eq(permissions.action, "write_own"),
      ),
    )
    .limit(1);
  if (writeOwnPerm) {
    await db.insert(rolePermissions).values({
      role_id: tightenedRoleId,
      permission_id: writeOwnPerm.id,
    }).onConflictDoNothing();
  }
}

// 仅收紧 network 权限的角色（保留 command 权限）：用于验证
// `network: null` 不触发检查（I2 评审修复）
const NET_TIGHTENED_ID = `field-net-tight-${ts}`;
const netTightenedRoleId = `net-tightened-role-${ts}`;
await db.insert(roles).values({
  id: netTightenedRoleId,
  name: `net-tightened-${ts}`,
  description: "测试角色（仅无 network 敏感字段权限）",
  is_system: false,
  is_default: false,
  parent_id: null,
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();
const [cmdPerm] = await db.select({ id: permissions.id })
  .from(permissions)
  .where(
    and(
      eq(permissions.resource, "problem"),
      eq(permissions.action, "field_evaluator_command"),
    ),
  )
  .limit(1);
if (cmdPerm) {
  await db.insert(rolePermissions).values({
    role_id: netTightenedRoleId,
    permission_id: cmdPerm.id,
  }).onConflictDoNothing();
}

// user_roles 直接插入（role_permissions 需要 permission_id，这里只关联角色）
const { userRoles } = await import("./../../src/shared/db/schema.ts");
await ensureUser(NET_TIGHTENED_ID, `field-net-tight-${ts}`);
for (
  const [userId, roleId] of [
    [ADMIN_ID, adminRole.id],
    [USER_ID, userRole.id],
    [TIGHTENED_ID, tightenedRoleId],
    [NET_TIGHTENED_ID, netTightenedRoleId],
  ] as const
) {
  await db.insert(userRoles).values({ user_id: userId, role_id: roleId })
    .onConflictDoNothing();
}

// 模块级预置收紧用户拥有的题目（供两个 PUT 用例复用）
const FIELD_OWN_PROBLEM_ID = `field-own-${ts}`;
await db.insert(problems).values({
  id: FIELD_OWN_PROBLEM_ID,
  title: "旧标题",
  description: "旧题面",
  difficulty: "medium",
  runtime_config: VALID_RUNTIME_CONFIG,
  number: 90000 + (ts % 5000),
  owner_id: TIGHTENED_ID,
  type: "U",
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();

function makeToken(userId: string): Promise<string> {
  return signToken({ sub: userId, role: "user" });
}

// ── 用例 ─────────────────────────────────────────

Deno.test({
  name: "POST /problems: 默认用户不再拥有敏感字段权限 → 403（NOJ-062）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await makeToken(USER_ID);
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: `默认拒绝 ${ts}`,
        description: "默认拒绝",
        difficulty: "easy",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
      }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "POST /problems: 收紧用户设置敏感字段 → 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await makeToken(TIGHTENED_ID);
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: `收紧拒绝 ${ts}`,
        description: "收紧拒绝",
        difficulty: "easy",
        runtime_config: VALID_RUNTIME_CONFIG, // command 必填 → 触发检查
      }),
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "FORBIDDEN");
  },
});

Deno.test({
  name:
    "POST /problems: 默认用户即使 network:null，仍因 command 敏感字段被拒 → 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await makeToken(NET_TIGHTENED_ID);
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: `network null ${ts}`,
        description: "network null",
        difficulty: "easy",
        runtime_config: {
          ...VALID_RUNTIME_CONFIG,
          evaluator: { ...VALID_RUNTIME_CONFIG.evaluator, network: null },
        },
      }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "POST /problems: network 收紧用户设置 network.enabled=true → 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await makeToken(NET_TIGHTENED_ID);
    const res = await app.request("/api/v1/problems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: `network true ${ts}`,
        description: "network true",
        difficulty: "easy",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
      }),
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "FORBIDDEN");
  },
});

Deno.test({
  name: "PUT /problems/:id: 收紧用户未触及敏感字段 → 200 放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 题目已在模块级 setup 中预置
    const problemId = FIELD_OWN_PROBLEM_ID;

    const app = createApp();
    const token = await makeToken(TIGHTENED_ID);
    const res = await app.request(`/api/v1/problems/${problemId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "新标题" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.title, "新标题");
  },
});

Deno.test({
  name: "PUT /problems/:id: 收紧用户更新 runtime_config → 403",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = FIELD_OWN_PROBLEM_ID; // 复用模块级预置题目（owner=收紧用户）
    const app = createApp();
    const token = await makeToken(TIGHTENED_ID);
    const res = await app.request(`/api/v1/problems/${problemId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ runtime_config: NETWORKED_RUNTIME_CONFIG }),
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "import-bundle: 收紧用户导入 → 403，admin 导入 → 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const formData = new FormData();
    formData.append(
      "file",
      makeZipBlob({ runtime_config: NETWORKED_RUNTIME_CONFIG }),
      "b.zip",
    );

    const tightToken = await makeToken(TIGHTENED_ID);
    const tightRes = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${tightToken}` },
      body: formData,
    });
    assertEquals(tightRes.status, 403);

    const adminToken = await makeToken(ADMIN_ID);
    const adminRes = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formData,
    });
    assertEquals(adminRes.status, 200);
  },
});

Deno.test({
  name: "POST /problems: 资源超限 → 400 RESOURCE_LIMIT_EXCEEDED",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await updateSetting("judge_max_evaluator_memory_limit_mb", 512, ADMIN_ID);
    try {
      const app = createApp();
      const token = await makeToken(ADMIN_ID);
      const res = await app.request("/api/v1/problems", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: `超限 ${ts}`,
          description: "超限",
          difficulty: "easy",
          runtime_config: {
            ...VALID_RUNTIME_CONFIG,
            evaluator: {
              ...VALID_RUNTIME_CONFIG.evaluator,
              memory_limit_mb: 1024,
            },
          },
        }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.code, "RESOURCE_LIMIT_EXCEEDED");
    } finally {
      await resetSetting("judge_max_evaluator_memory_limit_mb", ADMIN_ID);
    }
  },
});
