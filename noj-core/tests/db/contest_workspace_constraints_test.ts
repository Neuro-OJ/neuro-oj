import { assertEquals, assertIsError, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import { resetDbForTest } from "../helpers/db.ts";
import {
  contestProblems,
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
} from "../../src/shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../src/shared/workspace/types.ts";
import { createDomain } from "../../src/domains/workspace/index.ts";
import {
  problemExecutionForTest,
  publishBaselineVersionForTest,
} from "../helper.ts";

async function fixture() {
  await resetDbForTest();
  const db = getDb(), now = new Date().toISOString();
  const other = await createDomain(
    { slug: "contest-integrity", name: "另一域", preset: "team" },
    "0",
    { approved: true },
  );
  const [problem, paper] = await db.insert(problems).values(
    [false, true].map((objective, index) => ({
      id: crypto.randomUUID(),
      domain_id: DEFAULT_DOMAIN_ID,
      number: 998038 + index,
      title: objective ? "客观题" : "代码题",
      description: "约束测试",
      visibility: "public",
      owner_id: "0",
      is_objective: objective,
      created_at: now,
      updated_at: now,
    })),
  ).returning();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(contests).values(ids.map((id, index) => ({
    id,
    domain_id: index ? other.id : DEFAULT_DOMAIN_ID,
    title: "约束测试",
    type: "kaggle",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-01-02T00:00:00.000Z",
    created_at: now,
    updated_at: now,
  })));
  return { db, now, problem, paper, mainContest: ids[0], otherContest: ids[1] };
}

Deno.test("比赛约束：比赛及题库关联必须有域和真实绑定", async () => {
  const f = await fixture();
  const missing = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.execute(sql`
    INSERT INTO contests (id, title, type, start_time, end_time, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, '无归属', 'kaggle', '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z', ${f.now}, ${f.now})`)
    )
  );
  assertIsError(missing);
  assertEquals((missing.cause as { code: string }).code, "23502");
  const execution = await problemExecutionForTest(f.problem.id);
  const version = await publishBaselineVersionForTest(f.problem.id);
  for (const field of ["domain_id", "domain_problem_binding_id"]) {
    const error = await assertRejects(() =>
      f.db.transaction((tx) =>
        tx.execute(sql`
      INSERT INTO contest_problems (domain_id, domain_problem_binding_id, contest_id, problem_id, label, score, pinned_version_id)
      VALUES (${field === "domain_id" ? null : execution.domain_id},
        ${
          field === "domain_problem_binding_id"
            ? null
            : execution.domain_problem_binding_id
        },
        ${f.mainContest}, ${f.problem.id}, 'A', 10000, ${version})`)
      )
    );
    assertIsError(error);
    assertEquals((error.cause as { code: string }).code, "23502");
  }
});

Deno.test("比赛约束：相同源题也不能将提交挂到另一域比赛", async () => {
  const f = await fixture();
  const source = await problemExecutionForTest(f.problem.id);
  const paper = await problemExecutionForTest(f.paper.id);
  const writes = [
    () =>
      f.db.transaction((tx) =>
        tx.insert(submissions).values({
          ...source,
          id: crypto.randomUUID(),
          user_id: "0",
          problem_id: f.problem.id,
          contest_id: f.otherContest,
          language: "python3",
          code: "original",
          created_at: f.now,
        })
      ),
    () =>
      f.db.transaction((tx) =>
        tx.insert(objectiveSubmissions).values({
          ...paper,
          id: crypto.randomUUID(),
          user_id: "0",
          paper_id: f.paper.id,
          contest_id: f.otherContest,
          submission_type: "contest",
          answers: {},
          created_at: f.now,
        })
      ),
  ];
  for (const write of writes) {
    const error = await assertRejects(write);
    assertIsError(error);
    assertEquals((error.cause as { code: string }).code, "23503");
  }
});

Deno.test("比赛约束：练习允许空比赛，删除比赛只清上下文并保留代码答案及尝试", async () => {
  const f = await fixture();
  const source = await problemExecutionForTest(f.problem.id);
  const paper = await problemExecutionForTest(f.paper.id);
  const subId = crypto.randomUUID(), objId = crypto.randomUUID();
  await f.db.insert(submissions).values({
    ...source,
    id: subId,
    user_id: "0",
    problem_id: f.problem.id,
    contest_id: f.mainContest,
    language: "python3",
    code: "immutable-code",
    created_at: f.now,
  });
  await f.db.insert(objectiveSubmissions).values({
    ...paper,
    id: objId,
    user_id: "0",
    paper_id: f.paper.id,
    contest_id: f.mainContest,
    submission_type: "contest",
    answers: { historical: ["A"] },
    created_at: f.now,
  });
  await f.db.insert(submissions).values({
    ...source,
    id: crypto.randomUUID(),
    user_id: "0",
    problem_id: f.problem.id,
    language: "python3",
    code: "practice",
    created_at: f.now,
  });
  const attempts = [crypto.randomUUID(), crypto.randomUUID()];
  await f.db.insert(evaluationAttempts).values(attempts.map((id, index) => ({
    id,
    submission_id: index ? null : subId,
    objective_submission_id: index ? objId : null,
    problem_id: index ? f.paper.id : f.problem.id,
    sequence: 0,
    source: "legacy_import" as const,
    state: "finished" as const,
    result_kind: "graded" as const,
    result_status: "finished",
    score: 10000,
    accepted: true,
    created_at: f.now,
  })));
  const version = await publishBaselineVersionForTest(f.problem.id);
  await f.db.insert(contestProblems).values({
    ...source,
    contest_id: f.mainContest,
    problem_id: f.problem.id,
    label: "A",
    score: 10000,
    pinned_version_id: version,
  });
  // 单列 SET NULL 与新增复合 NO ACTION 必须在实际数据库中一起成立。
  await f.db.delete(contests).where(eq(contests.id, f.mainContest));
  const [submission] = await f.db.select().from(submissions).where(
    eq(submissions.id, subId),
  );
  const [objective] = await f.db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, objId),
  );
  assertEquals([
    submission.domain_id,
    submission.domain_problem_binding_id,
    submission.contest_id,
    submission.code,
  ], [
    DEFAULT_DOMAIN_ID,
    source.domain_problem_binding_id,
    null,
    "immutable-code",
  ]);
  assertEquals([
    objective.domain_id,
    objective.domain_problem_binding_id,
    objective.contest_id,
    objective.answers,
  ], [DEFAULT_DOMAIN_ID, paper.domain_problem_binding_id, null, {
    historical: ["A"],
  }]);
  assertEquals(
    (await f.db.select().from(evaluationAttempts)).map((row) => row.id).sort(),
    attempts.sort(),
  );
  assertEquals((await f.db.select().from(contestProblems)).length, 0);
});
