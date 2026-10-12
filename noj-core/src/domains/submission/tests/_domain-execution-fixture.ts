import { getDb, resetDbForTest } from "../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problems,
  problemVersions,
  users,
} from "../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { getRedis, resetRedisForTest } from "../../../shared/mq/connection.ts";
import {
  importDomainProblem,
  setDomainProblemSharing,
} from "../../catalog/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
} from "../../workspace/index.ts";
import { updateSetting } from "../../system/index.ts";
import { startFakeRedis } from "./_fake-redis.ts";
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
    domain_id: source.id,
    number: 1001,
    type: "P",
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
    domain_id: source.id,
    problem_id: problemId,
    kind: "owned",
    visibility: "public",
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
  await setDomainProblemSharing(source.slug, "1001", owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const ref = `${source.slug}:1001`;
  const { binding: bindingA } = await importDomainProblem(a.slug, ref, owner);
  const { binding: bindingB } = await importDomainProblem(b.slug, ref, owner);
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
    if (previous) Deno.env.set("REDIS_URL", previous);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}
