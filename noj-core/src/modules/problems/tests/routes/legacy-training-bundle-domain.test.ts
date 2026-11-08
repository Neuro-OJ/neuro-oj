import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { zipSync } from "fflate";
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
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  createDomain,
  DEFAULT_DOMAIN_ID,
} from "../../../access/workspace/index.ts";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
import {
  createDefaultCatalogToken,
  resetDbForTest,
} from "../default-fixture.ts";
import { saveDomainTraining } from "../../services/workspace/trainings.ts";
import {
  readDomainTraining,
} from "../../services/workspace/training-access.ts";
import { listUserTrainings } from "../../services/trainings.ts";
import {
  importDomainProblem,
  setDomainProblemBindingState,
} from "../../services/workspace/problem-bindings.ts";
import { importProblemBundle } from "../../services/problems/problem-bundle.ts";

Deno.test("旧题单入口固定 main，独立副本不受来源撤销影响且不聚合其他域成绩", async () => {
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
    content: {
      kind: "ai",
      title: `版本${i + 1}`,
      description: `题面${i + 1}`,
      submission_mode: "code",
      template_content: "print(1)",
      runtime_config: {
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
      },
    },
    published_at: now,
  })));
  await db.update(problems).set({ latest_version_id: versions[1] }).where(
    eq(problems.id, id),
  );
  await db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: source.id,
    problem_id: id,
    visibility: "public",
    created_by: actor,
    created_at: now,
    updated_at: now,
  });
  const imported = await importDomainProblem(
    "main",
    "legacy-training-source:1001",
    actor,
  );
  const localRef = imported.reference.display_ref;
  const training = await saveDomainTraining("main", actor, {
    title: "main副本题单",
    state: "published",
    problems: [localRef],
  });
  const outside = await saveDomainTraining(source.slug, actor, {
    title: "其他域题单",
    state: "published",
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
  const profile = await listUserTrainings(actor, actor, {
    page: 1,
    perPage: 100,
  });
  assertEquals(
    profile.data.some((row) => row.id === outside.id),
    false,
    "按创建者列出 main 题单时不得混入其他域的题单",
  );
  assertEquals(
    profile.data.some((row) => row.id === training.id),
    true,
  );
  const read = await readDomainTraining("main", training.id, actor);
  const first = read.items[0]!;
  assertEquals(first.resource_available, true);
  assertEquals(first.display_ref, localRef);
  assertEquals(
    read.items[0]!.problem_id === id,
    false,
    "main 题单引用的是导入后的副本",
  );
  await assertRejects(
    () => readDomainTraining("main", outside.id, actor),
    NotFoundError,
  );
  await setDomainProblemBindingState(
    "main",
    localRef,
    actor,
    imported.binding.revision,
    { disabled: true, reason: "目标域独立下架" },
  );
  assertEquals(
    (await readDomainTraining("main", training.id, actor)).items[0]!
      .resource_available,
    false,
  );
  // main 域被挂起后，非平台管理员不能经域内读取入口访问题单。
  await db.update(domains).set({ status: "suspended" }).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  await assertRejects(
    async () =>
      await readDomainTraining(
        "main",
        training.id,
        await createDefaultCatalogToken("member").then((t) =>
          decodeJwt(t).sub!
        ),
      ),
    AppError,
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
