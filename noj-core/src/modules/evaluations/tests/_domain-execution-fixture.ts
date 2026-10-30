import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemVersions,
  users,
} from "../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { getRedis, resetRedisForTest } from "../../../shared/mq/connection.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
} from "../../access/workspace/index.ts";
import { updateSetting } from "../../platform/system/index.ts";
import { startFakeRedis } from "./_fake-redis.ts";
import { setDomainProblemBindingState } from "../../problems/index.ts";

/** 本域下架替代旧共享撤销；保留个人历史，但阻止新的执行。 */
export async function setFixtureAvailability(
  f: Awaited<ReturnType<typeof fixture>>,
  enabled: boolean,
) {
  const [binding] = await f.db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.id, f.bindingA.id),
  );
  await setDomainProblemBindingState(
    f.a.slug,
    f.ref,
    f.owner,
    binding.revision,
    { disabled: !enabled, reason: "测试本域资源下架与恢复" },
  );
}
async function account() {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function fixture(mode: "code" | "artifact" | "oi" = "code") {
  await resetDbForTest();
  const owner = await account(),
    student = await account(),
    outsider = await account();
  await updateSetting("domain_creation_policy", "open", "0");
  const source = await createDomain({
    slug: "submit-public",
    name: "公共源题",
    preset: "community",
  }, owner);
  const a = await createDomain({
    slug: "submit-school-a",
    name: "学校 A",
    preset: "education",
  }, owner);
  const b = await createDomain({
    slug: "submit-school-b",
    name: "学校 B",
    preset: "education",
  }, owner);
  for (const school of [a, b]) {
    const invitation = await createDomainInvitation(
      school.slug,
      owner,
      `${student}@example.com`,
    );
    await consumeDomainInvitation(invitation.token, student);
  }
  const now = new Date().toISOString(), problemId = crypto.randomUUID();
  await getDb().insert(problems).values({
    id: problemId,
    domain_id: a.id,
    number: 1001,
    judge_type: mode === "oi" ? "oi" : "dual",
    submission_mode: mode === "artifact" ? "artifact" : "code",
    title: "共享题",
    description: "题面",
    owner_id: owner,
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  const v1 = crypto.randomUUID(), v2 = crypto.randomUUID();
  const runtime = {
    evaluator: {
      image: "noj-evaluator-python",
      command: "python3 evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 2000,
      memory_limit_mb: 512,
    },
  };
  for (const [index, id] of [v1, v2].entries()) {
    await getDb().insert(problemVersions).values({
      id,
      problem_id: problemId,
      version: index + 1,
      content: mode === "oi"
        ? {
          kind: "oi",
          title: "共享 OI 题",
          description: "题面",
          samples: [],
          runtime_config: {
            backend: "native",
            languages: ["cc"],
            time_limit_ms: 1000,
            memory_limit_mb: 128,
            checker: { type: "default" },
            subtasks: [{
              id: "1",
              score: 100,
              cases: [{ id: "1", input: "1.in", output: "1.out" }],
            }],
          },
        }
        : {
          kind: "ai",
          title: "共享题",
          description: "题面",
          samples: [],
          submission_mode: mode,
          runtime_config: runtime,
          template_content: "",
          artifact_max_size_mb: null,
          llm_config: null,
        },
      published_at: now,
    });
  }
  await getDb().update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  await getDb().insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: a.id,
    problem_id: problemId,
    kind: "owned",
    visibility: "public",
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
  const [bindingA] = await getDb().select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, problemId),
  );
  const [base] = await getDb().select().from(problems).where(
    eq(problems.id, problemId),
  );
  const baseVersions = await getDb().select().from(problemVersions).where(
    eq(problemVersions.problem_id, problemId),
  );
  async function independent(domainId: string) {
    const identity = crypto.randomUUID(),
      versions = [crypto.randomUUID(), crypto.randomUUID()];
    await getDb().insert(problems).values({
      ...base,
      id: identity,
      searchVector: undefined,
      domain_id: domainId,
      latest_version_id: null,
    });
    await getDb().insert(problemVersions).values(
      baseVersions.map((row) => ({
        ...row,
        id: versions[row.version - 1],
        problem_id: identity,
      })),
    );
    await getDb().update(problems).set({ latest_version_id: versions[1] })
      .where(eq(problems.id, identity));
    const [binding] = await getDb().insert(domainProblemBindings).values({
      ...bindingA,
      id: crypto.randomUUID(),
      domain_id: domainId,
      problem_id: identity,
    }).returning();
    return { identity, versions, binding };
  }
  const copiedB = await independent(b.id),
    copiedSource = await independent(source.id);
  for (const domain of [a, b, source]) {
    await getDb().update(domains).set({ next_problem_number: 1002 }).where(
      eq(domains.id, domain.id),
    );
  }
  const bindingB = copiedB.binding;
  const ref = "1001";
  return {
    db: getDb(),
    owner,
    student,
    outsider,
    source,
    a,
    b,
    problemId,
    v1,
    v2,
    ref,
    bindingA,
    bindingB,
    problemB: copiedB.identity,
    v1B: copiedB.versions[0],
    v2B: copiedB.versions[1],
    sourceProblemId: copiedSource.identity,
    sourceV1: copiedSource.versions[0],
    sourceV2: copiedSource.versions[1],
    runtime,
  };
}

export async function withQueue(fn: () => Promise<void>) {
  const previous = Deno.env.get("REDIS_URL"), fake = await startFakeRedis();
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  const redis = getRedis();
  try {
    await redis.connect();
    await fn();
  } finally {
    redis.disconnect();
    resetRedisForTest();
    if (previous === undefined) Deno.env.delete("REDIS_URL");
    else Deno.env.set("REDIS_URL", previous);
    await fake.stop();
  }
}
