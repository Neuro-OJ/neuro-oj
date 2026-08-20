import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { initRedisForTest } from "../lib/helper.ts";
import {
  createTag,
  deleteTag,
  getTag,
  listTags,
  mergeTags,
  updateTag,
} from "../../src/services/tags.ts";
import { ConflictError, NotFoundError } from "../../src/lib/errors.ts";
import { getDb } from "../../src/db/connection.ts";
import {
  auditLogs,
  problems,
  problemTags,
  tags,
  users,
} from "../../src/db/schema.ts";
import { enterTestContext } from "../../src/lib/requestContext.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

import { resetDbForTest } from "../../src/db/connection.ts";
await resetDbForTest();
await initRedisForTest();

const ts = Date.now();

Deno.test({
  name: "tags service: 创建标签成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tag = await createTag({ name: `服务标签-${ts}`, kind: "problem" });
    assertEquals(tag.name, `服务标签-${ts}`);
    assertEquals(tag.kind, "problem");
    assertEquals(tag.problem_count, 0);

    const db = getDb();
    await db.delete(tags).where(eq(tags.id, tag.id));
  },
});

Deno.test({
  name: "tags service: 重名标签返回 ConflictError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const name = `重名标签-${ts}`;
    const tag = await createTag({ name, kind: "problem" });
    await assertRejects(
      () => createTag({ name, kind: "algorithm" }),
      ConflictError,
    );

    const db = getDb();
    await db.delete(tags).where(eq(tags.id, tag.id));
  },
});

Deno.test({
  name: "tags service: 非法 kind 返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { BadRequestError } = await import("../../src/lib/errors.ts");
    await assertRejects(
      () => createTag({ name: `非法-${ts}`, kind: "unknown" }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "tags service: 更新标签维护 updated_at 并写审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // logAudit 依赖 RequestContext + admin_id FK → 先建 admin 用户再注入 actor
    const adminId = `test-admin-upd-${ts}`;
    const now = new Date().toISOString();
    await getDb().insert(users).values({
      id: adminId,
      username: `audit_admin_upd_${ts}`,
      email: `audit_admin_upd_${ts}@test.local`,
      password_hash: "x",
      must_change_password: false,
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing({ target: users.id });
    enterTestContext({
      actorId: adminId,
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    const tag = await createTag({ name: `改名前-${ts}`, kind: "problem" });
    const updated = await updateTag(tag.id, { name: `改名后-${ts}` });
    assertEquals(updated.name, `改名后-${ts}`);
    assertEquals(updated.kind, "problem");

    // 审计记录存在
    const db = getDb();
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tags.update"))
      .limit(5);
    assertEquals(
      rows.some((r) =>
        (r.detail as { from?: string }).from ===
          `${tag.name} (${tag.kind})`
      ),
      true,
    );

    await db.delete(tags).where(eq(tags.id, tag.id));
  },
});

Deno.test({
  name: "tags service: 删除标签级联清理关联并写审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    // logAudit 依赖 RequestContext + admin_id FK → 先建 admin 用户再注入 actor
    const adminId = `test-admin-del-${ts}`;
    const adminNow = new Date().toISOString();
    await db.insert(users).values({
      id: adminId,
      username: `audit_admin_del_${ts}`,
      email: `audit_admin_del_${ts}@test.local`,
      password_hash: "x",
      must_change_password: false,
      created_at: adminNow,
      updated_at: adminNow,
    }).onConflictDoNothing({ target: users.id });
    enterTestContext({
      actorId: adminId,
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    const tag = await createTag({ name: `删除标签-${ts}`, kind: "problem" });

    // 造一个题目并关联
    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: problemId,
      title: `审计题-${ts}`,
      description: "描述",
      difficulty: "easy",
      runtime_config: null,
      is_objective: false,
      number: 910000 + (ts % 10000),
      owner_id: "0",
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemTags).values({
      problem_id: problemId,
      tag_id: tag.id,
    });

    await deleteTag(tag.id);

    // 关联被级联清理
    const remaining = await db
      .select()
      .from(problemTags)
      .where(eq(problemTags.tag_id, tag.id));
    assertEquals(remaining.length, 0);

    // 审计存在
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tags.delete"));
    assertEquals(
      rows.some((r) => (r.detail as { name?: string }).name === tag.name),
      true,
    );

    await db.delete(problems).where(eq(problems.id, problemId));
  },
});

Deno.test({
  name: "tags service: 合并标签重指向关联并删除源标签",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const source = await createTag({ name: `合并源-${ts}`, kind: "algorithm" });
    const target = await createTag({
      name: `合并目标-${ts}`,
      kind: "algorithm",
    });

    // 题目 A 只关联 source；题目 B 同时关联 source 与 target（冲突去重场景）
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values([
      {
        id: problemA,
        title: `合并题A-${ts}`,
        description: "描述",
        difficulty: "easy",
        runtime_config: null,
        is_objective: false,
        number: 920000 + (ts % 10000),
        owner_id: "0",
        type: "P",
        created_at: now,
        updated_at: now,
      },
      {
        id: problemB,
        title: `合并题B-${ts}`,
        description: "描述",
        difficulty: "easy",
        runtime_config: null,
        is_objective: false,
        number: 930000 + (ts % 10000),
        owner_id: "0",
        type: "P",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(problemTags).values([
      { problem_id: problemA, tag_id: source.id },
      { problem_id: problemB, tag_id: source.id },
      { problem_id: problemB, tag_id: target.id },
    ]);

    await mergeTags(source.id, target.id);

    // 源标签已删除
    await assertRejects(() => getTag(source.id), NotFoundError);
    // A 关联到 target，B 仅剩一行 target（无重复）
    const rowsA = await db
      .select()
      .from(problemTags)
      .where(eq(problemTags.problem_id, problemA));
    assertEquals(rowsA.length, 1);
    assertEquals(rowsA[0].tag_id, target.id);
    const rowsB = await db
      .select()
      .from(problemTags)
      .where(eq(problemTags.problem_id, problemB));
    assertEquals(rowsB.length, 1);
    assertEquals(rowsB[0].tag_id, target.id);

    // 清理
    await db.delete(problemTags).where(
      eq(problemTags.tag_id, target.id),
    );
    await db.delete(problems).where(
      inArray(problems.id, [problemA, problemB]),
    );
    await db.delete(tags).where(eq(tags.id, target.id));
  },
});

Deno.test({
  name: "tags service: 合并到自身返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { BadRequestError } = await import("../../src/lib/errors.ts");
    await assertRejects(
      () => mergeTags("same-id", "same-id"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "tags service: listTags 返回 problem_count 并按 name 升序",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const all = await listTags();
    const names = all.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assertEquals(names, sorted);
    for (const t of all) {
      assertEquals(typeof t.problem_count, "number");
    }
  },
});

Deno.test({
  name: "tags service: cleanup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const rows = await db.select().from(tags);
    for (const row of rows) {
      if (
        row.name.startsWith("服务标签-") ||
        row.name.startsWith("重名标签-") ||
        row.name.startsWith("改名前-") ||
        row.name.startsWith("改名后-") ||
        row.name.startsWith("删除标签-") ||
        row.name.startsWith("合并源-") ||
        row.name.startsWith("合并目标-")
      ) {
        await db.delete(problemTags).where(eq(problemTags.tag_id, row.id));
        await db.delete(tags).where(eq(tags.id, row.id));
      }
    }
  },
});
