import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { zipSync } from "fflate";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainLimits,
  domainProblemBindings,
  domains,
  problemDrafts,
  problems,
  problemVersions,
  submissions,
  trainings,
} from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  createDomain,
  DEFAULT_DOMAIN_ID,
} from "../../../access/workspace/index.ts";
import {
  bindPublishedProblemForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import {
  createDefaultCatalogToken,
  resetDbForTest,
} from "../default-fixture.ts";
import { saveDomainTraining } from "../../services/workspace/trainings.ts";
import {
  importDomainProblem,
  setDomainProblemBindingPolicy,
  setDomainProblemBindingState,
} from "../../services/workspace/problem-bindings.ts";
import { setDomainProblemSharing } from "../../services/workspace/problem-sharing.ts";
import { importProblemBundle } from "../../services/problems/problem-bundle.ts";

Deno.test("旧题单入口固定 main，引用读目标版本、撤销即时生效且不聚合其他域成绩", async () => {
  await resetDbForTest();
  const token = await createDefaultCatalogToken("admin"),
    actor = decodeJwt(token).sub!;
  const source = await createDomain({
    slug: "legacy-training-source",
    name: "来源",
    preset: "community",
  }, actor);
  const db = getDb(),
    now = new Date().toISOString(),
    id = crypto.randomUUID(),
    versions = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(problems).values({
    id,
    domain_id: source.id,
    number: 1001,
    title: "源题",
    description: "题面",
    owner_id: actor,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values(versions.map((version, i) => ({
    id: version,
    problem_id: id,
    version: i + 1,
    content: { kind: "ai", title: `版本${i + 1}`, description: `题面${i + 1}` },
    published_at: now,
  })));
  await db.update(problems).set({ latest_version_id: versions[1] }).where(
    eq(problems.id, id),
  );
  await db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: source.id,
    problem_id: id,
    kind: "owned",
    visibility: "public",
    created_by: actor,
    created_at: now,
    updated_at: now,
  });
  await setDomainProblemSharing(source.slug, "1001", actor, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const imported = await importDomainProblem(
    "main",
    "legacy-training-source:1001",
    actor,
  );
  await setDomainProblemBindingState(
    "main",
    "legacy-training-source:1001",
    actor,
    imported.binding.revision,
    { disabled: false, visibility: "public", reason: "公开题单使用" },
  );
  const training = await saveDomainTraining("main", actor, {
    title: "main引用题单",
    visibility: "public",
    problems: ["legacy-training-source:1001"],
  });
  const outside = await saveDomainTraining(source.slug, actor, {
    title: "其他域题单",
    visibility: "public",
    problems: ["1001"],
  });
  await db.insert(submissions).values({
    id: crypto.randomUUID(),
    domain_id: source.id,
    domain_problem_binding_id: await bindPublishedProblemForTest(id),
    user_id: actor,
    problem_id: id,
    status: "finished",
    language: "python3",
    code: "print(1)",
    is_valid: true,
    is_accepted: true,
    created_at: now,
  });
  const app = createApp();
  const path = `/api/v1/trainings/${training.id}`;
  const read = await jsonRequest(app, path + "/problems", { token });
  const first = (await read.json()).data[0];
  assertEquals(first.title, "版本2");
  assertEquals(first.display_id, "legacy-training-source:1001");
  assertEquals(Object.hasOwn(first, "type"), false);
  assertEquals(first.accepted, false);
  const [binding] = await db.select().from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.domain_id, DEFAULT_DOMAIN_ID),
      eq(domainProblemBindings.problem_id, id),
    ),
  );
  await setDomainProblemBindingPolicy(
    "main",
    "legacy-training-source:1001",
    actor,
    binding.revision,
    { mode: "exact", version_id: versions[0] },
    "验证旧入口",
  );
  const exact = await jsonRequest(app, path + "/problems", { token });
  assertEquals((await exact.json()).data[0].title, "版本1");
  const list = await jsonRequest(app, "/api/v1/trainings", { token });
  assertEquals(
    (await list.json()).data.some((row: { id: string }) =>
      row.id === outside.id
    ),
    false,
  );
  assertEquals(
    (await jsonRequest(app, `/api/v1/trainings/${outside.id}`, { token }))
      .status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, `/api/v1/trainings/${outside.public_id}`, {
      token,
    })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, `/api/v1/trainings/${outside.id}`, {
      method: "PUT",
      token,
      body: { title: "越域" },
    })).status,
    404,
  );
  await setDomainProblemSharing(source.slug, "1001", actor, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  const unavailable = await jsonRequest(app, path + "/problems", { token });
  assertEquals((await unavailable.json()).data, []);
  assertEquals(
    (await jsonRequest(app, path, { token }).then((res) => res.json())).data
      .problem_count,
    0,
  );
  await db.update(domains).set({ status: "suspended" }).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  assertEquals(
    (await jsonRequest(app, path, {
      token: await createDefaultCatalogToken("member"),
    })).status,
    404,
  );
});

Deno.test("旧整包导入存储额度不足时不留下空题目、草稿或绑定", async () => {
  await resetDbForTest();
  const token = await createDefaultCatalogToken("admin"),
    actor = decodeJwt(token).sub!,
    db = getDb();
  await db.update(domainLimits).set({ storage_bytes: 0 }).where(
    eq(domainLimits.domain_id, DEFAULT_DOMAIN_ID),
  );
  const enc = new TextEncoder(),
    bytes = zipSync({
      "problem.json": enc.encode(
        JSON.stringify({
          format_version: 2,
          title: "失败导入",
          description: "题面",
          number: 17001,
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              call_timeout_ms: 2000,
              memory_limit_mb: 512,
            },
          },
        }),
      ),
      "evaluate.py": enc.encode("print(1)"),
    });
  const failure = await assertRejects(
    () =>
      importProblemBundle({ name: "failure.zip", data: bytes }, {
        userId: actor,
      }),
    AppError,
  );
  assertEquals(failure.code, "DOMAIN_STORAGE_LIMIT", failure.message);
  assertEquals(
    (await db.select().from(problems).where(eq(problems.number, 17001))).length,
    0,
  );
  assertEquals((await db.select().from(problemDrafts)).length, 0);
  assertEquals((await db.select().from(domainProblemBindings)).length, 0);
  assertEquals((await db.select().from(trainings)).length, 0);
});
