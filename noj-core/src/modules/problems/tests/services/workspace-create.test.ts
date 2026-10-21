import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainLimits,
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import { AppError, ForbiddenError } from "../../../../shared/base/errors.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";
import {
  createDomainProblem,
  createProblem,
  deleteProblem,
  getDefaultDomainProblemByNumber,
  listAllProblems,
} from "../../index.ts";

async function fixture() {
  await resetDbForTest();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await ensureDefaultWorkspace();
  // 平台创建政策由现有测试 helper 配置；域内部授权不依赖平台管理员角色。
  const { updateSetting } = await import("../../../platform/system/index.ts");
  await updateSetting("domain_creation_policy", "open", "0");
  const a = await createDomain({
    slug: "number-school-a",
    name: "学校 A",
    preset: "education",
  }, id);
  const b = await createDomain({
    slug: "number-school-b",
    name: "学校 B",
    preset: "education",
  }, id);
  return { id, a, b, db: getDb() };
}

const input = { title: "域内套卷", description: "测试", is_objective: true };

Deno.test({
  name: "域题目创建: 两域从 1001 独立编号并创建策略依据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id, a, b, db } = await fixture();
    const first = await createDomainProblem(a.slug, input, id);
    const second = await createDomainProblem(b.slug, input, id);
    assertEquals([first.number, second.number], [1001, 1001]);
    const rows = await db.select().from(problems).where(
      eq(problems.id, first.id),
    );
    assertEquals(rows[0].domain_id, a.id);
    const [binding] = await db.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.problem_id, first.id),
    );
    assertEquals(binding.kind, "owned");
    const [history] = await db.select().from(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, binding.id),
    );
    assertEquals(history.effective_version_mode, "any");
    const [counter] = await db.select().from(domainResourceCounters).where(
      and(
        eq(domainResourceCounters.domain_id, a.id),
        eq(domainResourceCounters.resource, "problems"),
      ),
    );
    assertEquals(counter.used, 1);
    await assertRejects(() => getDefaultDomainProblemByNumber(1001));
    assertEquals(
      (await listAllProblems({ limit: 20 })).items.some((row) =>
        row.id === first.id || row.id === second.id
      ),
      false,
    );
  },
});

Deno.test({
  name: "域题目创建: 指定编号推动游标且移除源题不回收编号",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id, a } = await fixture();
    const first = await createDomainProblem(
      a.slug,
      { ...input, number: 1500 },
      id,
    );
    await deleteProblem(first.id, id);
    assertEquals((await createDomainProblem(a.slug, input, id)).number, 1501);
  },
});

Deno.test({
  name: "域题目创建: 旧入口写入默认域且并发请求获得不同编号",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { db } = await fixture();
    const rows = await Promise.all(
      Array.from({ length: 4 }, () => createProblem(input)),
    );
    assertEquals(rows.map((row) => row.number).sort((a, b) => a - b), [
      1001,
      1002,
      1003,
      1004,
    ]);
    const [main] = await db.select().from(domains).where(
      eq(domains.slug, "main"),
    );
    const sources = await db.select().from(problems).where(
      eq(problems.domain_id, main.id),
    );
    assertEquals(sources.length, 4);
  },
});

Deno.test({
  name: "域题目创建: 达到额度拒绝且失败写入回滚游标和绑定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id, a, db } = await fixture();
    await db.execute(
      sql`ALTER TABLE problem_drafts ADD CONSTRAINT test_domain_draft_failure CHECK (content->>'title' <> 'reject-domain-draft')`,
    );
    try {
      await assertRejects(() =>
        createDomainProblem(
          a.slug,
          { ...input, title: "reject-domain-draft" },
          id,
        )
      );
      const [domain] = await db.select().from(domains).where(
        eq(domains.id, a.id),
      );
      assertEquals(domain.next_problem_number, 1001);
      assertEquals(
        await db.select().from(domainProblemBindings).where(
          eq(domainProblemBindings.domain_id, a.id),
        ),
        [],
      );
    } finally {
      await db.execute(
        sql`ALTER TABLE problem_drafts DROP CONSTRAINT test_domain_draft_failure`,
      );
    }
    await db.update(domainLimits).set({ problems: 1 }).where(
      eq(domainLimits.domain_id, a.id),
    );
    await createDomainProblem(a.slug, input, id);
    const error = await assertRejects(
      () => createDomainProblem(a.slug, input, id),
      AppError,
    );
    assertEquals(error.code, "DOMAIN_PROBLEM_LIMIT");
  },
});

Deno.test({
  name: "域题目创建: 其他域成员不能创建资源",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { a, db } = await fixture();
    const stranger = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: stranger,
      username: stranger,
      email: `${stranger}@example.com`,
      created_at: now,
      updated_at: now,
    });
    // 公开入口可进入，但不授予资源创建能力。
    await db.update(domains).set({
      configuration: { ...a.configuration, access: "public" },
    }).where(eq(domains.id, a.id));
    await assertRejects(
      () => createDomainProblem(a.slug, input, stranger),
      ForbiddenError,
    );
  },
});

import { resetDbForTest } from "../default-fixture.ts";
