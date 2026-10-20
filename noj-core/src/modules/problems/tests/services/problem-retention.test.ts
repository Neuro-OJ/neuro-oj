import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
import { eq } from "drizzle-orm";
import { AppError, ForbiddenError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  objectiveSubmissions,
  problems,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../../domains/workspace/index.ts";
import { deleteProblem } from "../../services/problems/problems-crud.ts";

async function source(objective = false) {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    domain_id: DEFAULT_DOMAIN_ID,
    number: 1001,
    title: "历史保护",
    description: "题面",
    is_objective: objective,
    created_at: now,
    updated_at: now,
  });
  return { id, now };
}

async function expectRetained(id: string) {
  const error = await assertRejects(
    () => deleteProblem(id, "0", "admin"),
    AppError,
  );
  assertEquals(error.statusCode, 409);
  assertEquals(error.code, "SOURCE_HAS_RETAINED_REFERENCES");
  assertEquals(
    (await getDb().select().from(problems).where(eq(problems.id, id))).length,
    1,
  );
}

Deno.test("源题保留：有共享引用即明确拒绝删除，权限检查仍在历史守卫之前", async () => {
  const { id, now } = await source();
  await getDb().insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    problem_id: id,
    kind: "shared",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  const token = await createUserToken();
  await assertRejects(
    () => deleteProblem(id, decodeJwt(token).sub!, "user"),
    ForbiddenError,
  );
  await expectRetained(id);
  assertEquals((await getDb().select().from(domainProblemBindings)).length, 1);
});
Deno.test("源题保留：未知旧版本的代码提交不能随源题清除", async () => {
  const code = await source();
  await getDb().insert(submissions).values({
    domain_id: DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: await bindPublishedProblemForTest(code.id),
    id: crypto.randomUUID(),
    user_id: "0",
    problem_id: code.id,
    language: "python3",
    code: "print(1)",
    status: "finished",
    created_at: code.now,
  });
  await expectRetained(code.id);
  assertEquals((await getDb().select().from(submissions))[0].code, "print(1)");
});
Deno.test("源题保留：未知旧版本的客观题答案和成绩不能随源题清除", async () => {
  const objective = await source(true);
  await getDb().insert(objectiveSubmissions).values({
    domain_id: DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: await bindPublishedProblemForTest(objective.id),
    id: crypto.randomUUID(),
    user_id: "0",
    paper_id: objective.id,
    submission_type: "practice",
    answers: { q: ["A"] },
    score: 6000,
    created_at: objective.now,
  });
  await expectRetained(objective.id);
  assertEquals(
    (await getDb().select().from(objectiveSubmissions))[0].score,
    6000,
  );
});
Deno.test("源题保留：没有版本、绑定和历史提交的草稿仍可删除", async () => {
  const { id } = await source();
  await deleteProblem(id, "0", "admin");
  assertEquals(
    (await getDb().select().from(problems).where(eq(problems.id, id))).length,
    0,
  );
});

import { resetDbForTest } from "../default-fixture.ts";

import { createUserToken } from "../../../../../tests/helper.ts";
import { decodeJwt } from "jose";
