import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainProblemBindings,
  domains,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  presetConfiguration,
} from "../../../access/workspace/index.ts";

/** 每个违规写入使用独立事务，避免事务中止制造假阳性。 */
async function constraintRejected(
  write: (tx: Executor) => PromiseLike<unknown>,
) {
  const error = await assertRejects(() =>
    getDb().transaction(async (tx) => await write(tx))
  );
  assert(error instanceof Error);
  const cause = error.cause as { code?: string } | undefined;
  assertEquals(["23503", "23505", "23514"].includes(cause?.code ?? ""), true);
}

async function seed() {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const now = new Date().toISOString();
  const school = crypto.randomUUID();
  await getDb().insert(domains).values({
    id: school,
    slug: "schema-school",
    name: "学校",
    owner_id: "0",
    preset: "education",
    configuration: presetConfiguration("education"),
    created_at: now,
    updated_at: now,
  });
  const problem = crypto.randomUUID();
  const other = crypto.randomUUID();
  // 学校域自己的题目：绑定只能引用同域题目。
  const schoolProblem = crypto.randomUUID();
  await getDb().insert(problems).values([
    ...[problem, other].map((id, i) => ({
      id,
      domain_id: DEFAULT_DOMAIN_ID,
      title: "公开源题",
      description: "题面",
      number: 90001 + i,
      created_at: now,
      updated_at: now,
    })),
    {
      id: schoolProblem,
      domain_id: school,
      title: "学校题目",
      description: "题面",
      number: 90001,
      created_at: now,
      updated_at: now,
    },
  ]);
  const versions = [crypto.randomUUID(), crypto.randomUUID()];
  const schoolVersion = crypto.randomUUID();
  await getDb().insert(problemVersions).values([
    ...[problem, other].map((id, i) => ({
      id: versions[i],
      problem_id: id,
      version: 1,
      content: { kind: "ai" },
      published_at: now,
    })),
    {
      id: schoolVersion,
      problem_id: schoolProblem,
      version: 1,
      content: { kind: "ai" },
      published_at: now,
    },
  ]);
  return {
    school,
    problem,
    other,
    schoolProblem,
    schoolVersion,
    versions,
    now,
  };
}

Deno.test("域题库约束：同域唯一绑定、题目唯一策略和版本同题外键", async () => {
  const { school, schoolProblem, problem, versions, now } = await seed();
  const owned = {
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    problem_id: problem,
    created_by: "0",
    created_at: now,
    updated_at: now,
  };
  await getDb().insert(domainProblemBindings).values(owned);
  const shared = {
    ...owned,
    id: crypto.randomUUID(),
    domain_id: school,
    problem_id: schoolProblem,
  };
  await getDb().insert(domainProblemBindings).values(shared);
  assertEquals((await getDb().select().from(domainProblemBindings)).length, 2);
  await constraintRejected((tx) =>
    tx.insert(domainProblemBindings).values({
      ...shared,
      id: crypto.randomUUID(),
    })
  );
  await constraintRejected((tx) =>
    tx.update(problems).set({
      effective_version_mode: "exact",
      required_version_id: versions[1],
    }).where(eq(problems.id, problem))
  );
  await constraintRejected((tx) =>
    tx.update(problems).set({
      effective_version_mode: "exact",
      required_version_id: null,
    }).where(eq(problems.id, problem))
  );
  await constraintRejected((tx) =>
    tx.update(domainProblemBindings).set({ revision: -1 }).where(
      eq(domainProblemBindings.id, shared.id),
    )
  );
});

Deno.test("绑定沿革：版本和绑定必须同题，历史绑定阻止级联删除源题", async () => {
  const { school, schoolProblem, schoolVersion, other, versions, now } =
    await seed();
  const binding = crypto.randomUUID();
  await getDb().insert(domainProblemBindings).values({
    id: binding,
    domain_id: school,
    problem_id: schoolProblem,
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  const history = {
    id: crypto.randomUUID(),
    binding_id: binding,
    problem_id: schoolProblem,
    revision: 0,
    effective_version_mode: "any" as const,
    answer_version_id: schoolVersion,
    actor_id: "0",
    reason: "初始化",
    created_at: now,
  };
  await getDb().insert(problemBindingHistory).values(history);
  await constraintRejected((tx) =>
    tx.insert(problemBindingHistory).values({
      ...history,
      id: crypto.randomUUID(),
      revision: 1,
      problem_id: other,
    })
  );
  await constraintRejected((tx) =>
    tx.insert(problemBindingHistory).values({
      ...history,
      id: crypto.randomUUID(),
      revision: 1,
      answer_version_id: versions[1],
    })
  );
  await constraintRejected((tx) =>
    tx.delete(problems).where(eq(problems.id, schoolProblem))
  );
  assertEquals((await getDb().select().from(problemBindingHistory)).length, 1);
});

Deno.test("同域外键：绑定不能引用其他域的题目", async () => {
  const { school, problem, now } = await seed();
  await constraintRejected((tx) =>
    tx.insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: school,
      problem_id: problem,
      created_by: "0",
      created_at: now,
      updated_at: now,
    })
  );
  assertEquals((await getDb().select().from(domainProblemBindings)).length, 0);
});
