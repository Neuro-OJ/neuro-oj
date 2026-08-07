/**
 * 题目敏感字段 RBAC 守卫测试（issue #207）。
 *
 * 服务层覆盖（无 Hono Context 的 CLI/内部调用路径 + seed + 资源上限）：
 * - seed：敏感字段权限项存在、user 角色默认拥有（默认放行）
 * - createProblem / updateProblem：内部调用放行、CLI admin 放行、CLI 显式非 admin 拒绝
 * - enforceResourceLimits：超限 400 / 未超限放行
 * - importProblemBundle：CLI admin 放行 / CLI 显式非 admin 拒绝 / 超限 400
 *
 * 真实 Hono Context（路由层）的权限路径见 tests/routes/problem-field-guard.test.ts。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  permissions,
  problems,
  rolePermissions,
  roles,
  users,
} from "../../src/db/schema.ts";
import { AppError, ForbiddenError } from "../../src/lib/errors.ts";
import { ROOT_USER_ID } from "../../src/lib/constants.ts";
import { ensureRbacSeeds } from "../../src/services/seed-rbac.ts";
import { createProblem, updateProblem } from "../../src/services/problems.ts";
import { importProblemBundle } from "../../src/services/problem-bundle.ts";
import {
  resetSetting,
  updateSetting,
} from "../../src/services/system-settings.ts";

// PGlite 内存数据库始终可用
const dbAvailable = true;
const skip = !dbAvailable;

const ts = Date.now();

// 共享 runtime_config 样例（含 network 用于敏感字段触发）
const VALID_RUNTIME_CONFIG = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    entry: "submission_sample.py",
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

/** 构造统一题目包 zip（结构对齐 tests/routes/problem-bundle.test.ts） */
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

// ── 模块级 setup ──────────────────────────────────

// @std/assert 1.0.19 的 assertRejects 不支持谓词函数（类型检查失败），
// 用 try/catch 手动断言 AppError 的 code 与状态码
async function assertResourceLimitExceeded(
  fn: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof AppError &&
      caught.statusCode === 400 &&
      caught.code === "RESOURCE_LIMIT_EXCEEDED",
    "应抛 RESOURCE_LIMIT_EXCEEDED（400）",
  );
}

await resetDbForTest();
await ensureRbacSeeds();

// 注意：必须在 resetDbForTest() 之后获取 db——reset 会关闭旧连接池
// （PG 模式 _client.end()），setup 前缓存的引用指向已关闭的池会报
// CONNECTION_ENDED
const db = getDb();

// ── seed 覆盖（任务 5.3）────────────────────────

Deno.test({
  name: "seed: 敏感字段权限项存在",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const rows = await db.select().from(permissions).where(
      eq(permissions.resource, "problem"),
    );
    const actions = rows.map((r) => r.action);
    assert(
      actions.includes("field_evaluator_command"),
      "应有 problem:field_evaluator_command",
    );
    assert(
      actions.includes("field_evaluator_network"),
      "应有 problem:field_evaluator_network",
    );
  },
});

Deno.test({
  name: "seed: user 角色默认拥有敏感字段权限（默认放行）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const [userRole] = await db.select({ id: roles.id }).from(roles).where(
      eq(roles.name, "user"),
    ).limit(1);
    const permRows = await db.select({
      resource: permissions.resource,
      action: permissions.action,
    })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permission_id, permissions.id))
      .where(eq(rolePermissions.role_id, userRole.id));
    const perms = permRows.map((p) => `${p.resource}:${p.action}`);
    assert(
      perms.includes("problem:field_evaluator_command"),
      "user 角色应有 command 权限",
    );
    assert(
      perms.includes("problem:field_evaluator_network"),
      "user 角色应有 network 权限",
    );
  },
});

Deno.test({
  name: "seed: 管理员收紧后重复 ensureRbacSeeds 不恢复（一次性授权持久化）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const [userRole] = await db.select({ id: roles.id }).from(roles).where(
      eq(roles.name, "user"),
    ).limit(1);
    const [cmdPerm] = await db.select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.resource, "problem"),
          eq(permissions.action, "field_evaluator_command"),
        ),
      )
      .limit(1);
    if (!userRole || !cmdPerm) return; // 前置数据缺失则跳过

    // 模拟管理员收紧：移除 user 角色的 command 授权
    await db.delete(rolePermissions).where(
      and(
        eq(rolePermissions.role_id, userRole.id),
        eq(rolePermissions.permission_id, cmdPerm.id),
      ),
    );
    // 重启（再次 seed）不得恢复
    await ensureRbacSeeds();
    const [after] = await db.select().from(rolePermissions).where(
      and(
        eq(rolePermissions.role_id, userRole.id),
        eq(rolePermissions.permission_id, cmdPerm.id),
      ),
    ).limit(1);
    assertEquals(after, undefined, "收紧的授权不应被 seed 恢复");

    // 恢复现场（手动补回关联，避免影响其他用例）
    await db.insert(rolePermissions).values({
      role_id: userRole.id,
      permission_id: cmdPerm.id,
    }).onConflictDoNothing();
  },
});

// ── createProblem ────────────────────────────────

Deno.test({
  name: "createProblem: 内部调用（无 c、无 userRole）默认放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem({
      title: `内部创建 ${ts}`,
      description: "内部调用",
      difficulty: "easy",
      runtime_config: NETWORKED_RUNTIME_CONFIG,
    });
    assertEquals(problem.title, `内部创建 ${ts}`);
  },
});

Deno.test({
  name: "createProblem: CLI admin 放行（显式 userRole=admin）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem(
      {
        title: `CLI admin ${ts}`,
        description: "CLI",
        difficulty: "easy",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
      },
      ROOT_USER_ID,
      "admin",
    );
    assertEquals(problem.title, `CLI admin ${ts}`);
  },
});

Deno.test({
  name: "createProblem: CLI 显式非 admin 设置敏感字段被拒（403）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createProblem(
          {
            title: `CLI user ${ts}`,
            description: "CLI",
            difficulty: "easy",
            runtime_config: NETWORKED_RUNTIME_CONFIG,
          },
          "cli-user-id",
          "user",
        ),
      ForbiddenError,
      "权限不足",
    );
  },
});

// ── updateProblem ────────────────────────────────

Deno.test({
  name: "updateProblem: 内部调用（无 c、无 userRole）默认放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem(
      {
        title: `待更新 ${ts}`,
        description: "owner",
        difficulty: "easy",
        runtime_config: VALID_RUNTIME_CONFIG,
      },
      ROOT_USER_ID,
      "admin",
    );
    const updated = await updateProblem(
      problem.id,
      { runtime_config: NETWORKED_RUNTIME_CONFIG },
      ROOT_USER_ID, // owner
    );
    assertEquals(updated.title, `待更新 ${ts}`);
  },
});

Deno.test({
  name: "updateProblem: CLI 显式非 admin 更新敏感字段被拒（403）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // owner 为普通用户（非 root），updateProblem 的 owner 检查可通过，
    // 守卫按 fail-closed 拒绝（非 root 且 userRole 非 admin）
    await db.insert(users).values({
      id: "cli-owner-id",
      username: `cli-owner-${ts}`,
      email: `cli-owner-${ts}@test.com`,
      password_hash: "not-used",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).onConflictDoNothing();
    const problem = await createProblem(
      {
        title: `待收紧 ${ts}`,
        description: "owner",
        difficulty: "easy",
        runtime_config: VALID_RUNTIME_CONFIG,
      },
      "cli-owner-id",
      "admin",
    );
    await assertRejects(
      () =>
        updateProblem(
          problem.id,
          { runtime_config: NETWORKED_RUNTIME_CONFIG },
          "cli-owner-id",
          "user",
        ),
      ForbiddenError,
      "权限不足",
    );
  },
});

// ── 资源上限 ─────────────────────────────────────

Deno.test({
  name: "资源上限: 创建超限被拒（400 RESOURCE_LIMIT_EXCEEDED）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await updateSetting(
      "judge_max_evaluator_memory_limit_mb",
      512,
      ROOT_USER_ID,
    );
    try {
      await assertResourceLimitExceeded(
        () =>
          createProblem({
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
      );
    } finally {
      await resetSetting("judge_max_evaluator_memory_limit_mb", ROOT_USER_ID);
    }
  },
});

Deno.test({
  name: "资源上限: 未超限放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await updateSetting(
      "judge_max_evaluator_memory_limit_mb",
      512,
      ROOT_USER_ID,
    );
    try {
      const problem = await createProblem({
        title: `未超限 ${ts}`,
        description: "未超限",
        difficulty: "easy",
        runtime_config: {
          ...VALID_RUNTIME_CONFIG,
          evaluator: {
            ...VALID_RUNTIME_CONFIG.evaluator,
            memory_limit_mb: 256,
          },
        },
      });
      assertEquals(problem.title, `未超限 ${ts}`);
    } finally {
      await resetSetting("judge_max_evaluator_memory_limit_mb", ROOT_USER_ID);
    }
  },
});

Deno.test({
  name: "资源上限: 更新超限被拒（400）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem(
      {
        title: `更新超限 ${ts}`,
        description: "owner",
        difficulty: "easy",
        runtime_config: VALID_RUNTIME_CONFIG,
      },
      ROOT_USER_ID,
      "admin",
    );
    await updateSetting(
      "judge_max_solution_call_timeout_ms",
      5000,
      ROOT_USER_ID,
    );
    try {
      await assertResourceLimitExceeded(
        () =>
          updateProblem(
            problem.id,
            {
              runtime_config: {
                ...VALID_RUNTIME_CONFIG,
                solution: {
                  ...VALID_RUNTIME_CONFIG.solution,
                  call_timeout_ms: 10000,
                },
              },
            },
            ROOT_USER_ID,
            "admin",
          ),
      );
    } finally {
      await resetSetting("judge_max_solution_call_timeout_ms", ROOT_USER_ID);
    }
  },
});

// ── importProblemBundle（CLI 路径）───────────────

Deno.test({
  name: "importProblemBundle: CLI admin 导入含敏感字段的包放行",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const zip = makeBundleZip({
      runtime_config: {
        ...VALID_RUNTIME_CONFIG,
        evaluator: {
          ...VALID_RUNTIME_CONFIG.evaluator,
          network: { enabled: true },
        },
      },
    });
    const result = await importProblemBundle(
      { name: "cli-bundle.zip", data: zip },
      { userId: ROOT_USER_ID, userRole: "admin" },
    );
    assertEquals(result.title, `导入测试题 ${ts}`);
  },
});

Deno.test({
  name: "importProblemBundle: CLI 显式非 admin 导入被拒（403）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const zip = makeBundleZip();
    await assertRejects(
      () =>
        importProblemBundle(
          { name: "cli-bundle.zip", data: zip },
          { userId: "cli-user", userRole: "user" },
        ),
      ForbiddenError,
      "权限不足",
    );
  },
});

Deno.test({
  name: "importProblemBundle: 导入超限包被拒（400）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await updateSetting(
      "judge_max_evaluator_time_limit_ms",
      5000,
      ROOT_USER_ID,
    );
    try {
      const zip = makeBundleZip({
        runtime_config: {
          ...VALID_RUNTIME_CONFIG,
          evaluator: {
            ...VALID_RUNTIME_CONFIG.evaluator,
            time_limit_ms: 10000,
          },
        },
      });
      await assertResourceLimitExceeded(
        () =>
          importProblemBundle(
            { name: "cli-bundle.zip", data: zip },
            { userId: ROOT_USER_ID, userRole: "admin" },
          ),
      );
    } finally {
      await resetSetting("judge_max_evaluator_time_limit_ms", ROOT_USER_ID);
    }
  },
});

Deno.test({
  name:
    "importProblemBundle: admin 按 number 更新超限包被拒且旧数据不变（I4 前置校验）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 预置既有题目（owner=root），admin 带 number 导入超限包走 updateExisting
    const problemId = `i4-existing-${ts}`;
    const isoNow = new Date().toISOString();
    await db.insert(problems).values({
      id: problemId,
      title: "旧标题",
      description: "旧题面",
      difficulty: "medium",
      runtime_config: VALID_RUNTIME_CONFIG,
      number: 95000 + (ts % 4000),
      owner_id: ROOT_USER_ID,
      type: "U",
      created_at: isoNow,
      updated_at: isoNow,
    }).onConflictDoNothing();

    await updateSetting(
      "judge_max_solution_memory_limit_mb",
      256,
      ROOT_USER_ID,
    );
    try {
      const zip = makeBundleZip({
        number: 95000 + (ts % 4000),
        title: "新标题",
        runtime_config: {
          ...VALID_RUNTIME_CONFIG,
          solution: {
            ...VALID_RUNTIME_CONFIG.solution,
            memory_limit_mb: 1024,
          },
        },
      });
      await assertResourceLimitExceeded(
        () =>
          importProblemBundle(
            { name: "cli-bundle.zip", data: zip },
            { userId: ROOT_USER_ID, userRole: "admin" },
          ),
      );
      // DB 未变：标题与 runtime_config 保持旧值（updateExisting 前置校验
      // 失败，不触碰 storage、不落库）
      const [row] = await db.select().from(problems).where(
        eq(problems.id, problemId),
      ).limit(1);
      assertEquals(row.title, "旧标题");
      assertEquals(
        (row.runtime_config as { evaluator: { time_limit_ms: number } })
          .evaluator.time_limit_ms,
        5000,
      );
    } finally {
      await resetSetting("judge_max_solution_memory_limit_mb", ROOT_USER_ID);
    }
  },
});
