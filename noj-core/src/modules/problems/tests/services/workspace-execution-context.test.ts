import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problems,
} from "../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../access/workspace/index.ts";
import { createProblem } from "../../index.ts";
import { resolveDefaultExecutionContext } from "../../services/workspace/execution-context.ts";
import { resetDbForTest } from "../default-fixture.ts";

Deno.test("默认执行归属：成功解析必须返回本域 owned 绑定，停用后拒绝", async () => {
  await resetDbForTest();
  const db = getDb();
  const problem = await createProblem({
    title: "执行题",
    description: "题面",
    is_objective: true,
  });
  const context = await resolveDefaultExecutionContext(problem.id, "0", db);
  const [binding] = await db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.id, context.domain_problem_binding_id),
  );
  assertEquals(context.domain_id, DEFAULT_DOMAIN_ID);
  assertEquals([binding.problem_id, binding.kind], [problem.id, "owned"]);
  await db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, binding.id));
  await assertRejects(
    () => resolveDefaultExecutionContext(problem.id, "0", db),
    NotFoundError,
  );
});

Deno.test("默认执行归属：题目缺 owned 绑定时拒绝，不自动补题库记录", async () => {
  await resetDbForTest();
  const db = getDb(), id = crypto.randomUUID(), now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    domain_id: DEFAULT_DOMAIN_ID,
    number: 1001,
    title: "尚未完成题库归属",
    description: "题面",
    owner_id: "0",
    created_at: now,
    updated_at: now,
  });
  await assertRejects(
    () => resolveDefaultExecutionContext(id, "0", db),
    NotFoundError,
  );
  assertEquals(await db.select().from(domainProblemBindings), []);
  await db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    problem_id: id,
    kind: "shared",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  await assertRejects(
    () => resolveDefaultExecutionContext(id, "0", db),
    NotFoundError,
  );
});
