import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { decodeBase64 } from "@std/encoding/base64";
import { eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  evaluationAttempts,
  problems,
  problemVersions,
  selfTests,
  submissions,
} from "../../../../shared/db/schema.ts";
import { getDomainContestTemplate } from "../../../contests/index.ts";
import {
  buildJudgeTaskLlm,
  getDomainLlmDefault,
  listLlmGatewayModelCapabilities,
  readDomainLlmModelAliases,
  saveDomainLlmModelAlias,
} from "../../../platform/gateway/index.ts";
import {
  LocalStorageProvider,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../assets/storage/mod.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "../../index.ts";
import { fixture } from "../_domain-execution-fixture.ts";
import { createApp } from "../../../../app.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../access/identity/index.ts";
import { startFakeRedis } from "../mq/_setup.ts";
const secret = "integration-llm-service-token-0123456789abcdef";
async function openToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const data = decodeBase64(token);
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.slice(0, 12) },
        key,
        data.slice(12),
      ),
    ),
  );
}

Deno.test("主线融合 Domain：共享 UI 使用域别名与冻结凭据，自测沿用域，比赛固定界面拒绝脚本模板", async () => {
  const f = await fixture(),
    now = new Date().toISOString(),
    version = crypto.randomUUID();
  const runtime = {
    ...f.runtime,
    evaluator: { ...f.runtime.evaluator, network: { enabled: true } },
  };
  await f.db.insert(problemVersions).values({
    id: version,
    problem_id: f.problemId,
    version: 3,
    published_at: now,
    content: {
      kind: "ai",
      title: "共享界面题",
      description: "题面",
      samples: [],
      submission_mode: "ui",
      runtime_config: runtime,
      template_content: "def solve(x):\n    return prompt",
      artifact_max_size_mb: null,
      llm_config: { models: ["fast"], max_calls: 3, max_tokens: 500 },
    },
  });
  await f.db.update(problems).set({ latest_version_id: version }).where(
    eq(problems.id, f.problemId),
  );
  const [aVersion] = await f.db.select().from(problemVersions).where(
    eq(problemVersions.id, version),
  );
  const versionB = crypto.randomUUID();
  await f.db.insert(problemVersions).values({
    ...aVersion,
    id: versionB,
    problem_id: f.problemB,
  });
  await f.db.update(problems).set({ latest_version_id: versionB }).where(
    eq(problems.id, f.problemB),
  );
  const oldFetch = globalThis.fetch,
    oldSecret = Deno.env.get("NOJ_LLM_SERVICE_TOKEN"),
    oldRedis = Deno.env.get("REDIS_URL");
  const fake = startFakeRedis();
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", secret);
  const aliasModels = new Map([
    [f.a.id, "school-a-model"],
    [f.b.id, "school-b-model"],
  ]);
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const domain = new Headers(init?.headers).get("X-Noj-Domain-Id");
    const path = new URL(String(input)).pathname;
    const requestBody = typeof init?.body === "string"
      ? JSON.parse(init.body) as {
        aliases?: string[];
        provider_id?: string;
        model?: string;
      }
      : {};
    const fallbackAliasModel = domain === f.a.id
      ? "school-a-model"
      : "school-b-model";
    if (
      domain && path.includes("/internal/model-aliases/") &&
      init?.method === "PUT" && requestBody.model
    ) {
      aliasModels.set(domain, requestBody.model);
    }
    const aliasModel = aliasModels.get(domain ?? "") ?? fallbackAliasModel;
    const alias = {
      domain_id: domain,
      alias: "fast",
      provider_id: `provider-${domain}`,
      model: requestBody.model ?? aliasModel,
      description: "fast capability",
      revision: 1,
      updated_at: now,
    };
    const data = path.endsWith("/internal/execution-config")
      ? {
        provider_id: `provider-${domain}`,
        models: (requestBody.aliases ?? []).map((alias) => ({
          alias,
          model: alias === "fast" ? aliasModel : "default-model",
        })),
      }
      : path.endsWith("/internal/model-capabilities")
      ? [
        { alias: "default", description: "default capability" },
        { alias: "fast", description: "fast capability" },
      ]
      : path.endsWith("/internal/model-aliases") && init?.method === undefined
      ? [alias]
      : path.includes("/internal/model-aliases/")
      ? alias
      : {
        id: `provider-${domain}`,
        domain_id: domain,
        enabled: true,
        revision: 1,
      };
    return Promise.resolve(
      new Response(
        JSON.stringify({ data }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  try {
    await getRedis().connect();
    await saveDomainLlmModelAlias(f.a.slug, f.owner, "fast", {
      provider_id: `provider-${f.a.id}`,
      model: "school-a-model",
    }, 0);
    await saveDomainLlmModelAlias(f.b.slug, f.owner, "fast", {
      provider_id: `provider-${f.b.id}`,
      model: "school-b-model",
    }, 0);
    assertEquals(await getDomainLlmDefault(f.a.id), null);
    assertEquals(
      (await listLlmGatewayModelCapabilities(f.a.id)).map((r) => r.alias),
      ["default", "fast"],
    );
    await assertRejects(
      () => readDomainLlmModelAliases(f.a.slug, f.student),
      ForbiddenError,
    );
    const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
      language: "ui",
      code: '{"prompt":"hello"}',
      version_id: version,
    });
    const [row] = await f.db.select().from(submissions).where(
      eq(submissions.id, created.id),
    );
    const task = JSON.parse(fake.getMessages("noj:judge:queue:ai:medium")[0]);
    assertEquals(row.domain_id, f.a.id);
    assertEquals(row.code, '{"prompt":"hello"}');
    assertStringIncludes(task.code, "return prompt");
    assertStringIncludes(task.code, 'prompt = PARAMS["prompt"]');
    assertEquals(task.llm.provider_id, `provider-${f.a.id}`);
    assertEquals(task.llm.model_map, { fast: "school-a-model" });
    const payload = await openToken(task.llm.eval_token);
    assertEquals(payload.protocol_version, 3);
    assertEquals(payload.domain_id, f.a.id);
    assertEquals(payload.attempt_id, row.active_attempt_id);
    const [attempt] = await f.db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, row.active_attempt_id!),
    );
    const frozen = (attempt.task_snapshot as {
      llm_execution: Parameters<typeof buildJudgeTaskLlm>[5]["frozen"];
    }).llm_execution!;
    assertEquals(frozen.domain_id, f.a.id);
    await saveDomainLlmModelAlias(f.a.slug, f.owner, "fast", {
      provider_id: `provider-${f.a.id}`,
      model: "changed-a-model",
    }, 1);
    const restored = await buildJudgeTaskLlm(
      { models: ["fast"] },
      row.id,
      f.problemId,
      f.student,
      runtime,
      { domainId: f.a.id, attemptId: attempt.id, frozen },
    );
    assertEquals(restored.model_map, { fast: "school-a-model" });
    await assertRejects(
      () =>
        buildJudgeTaskLlm(
          { models: ["fast"] },
          row.id,
          f.problemId,
          f.student,
          runtime,
          { domainId: f.b.id, attemptId: attempt.id, frozen },
        ),
      BadRequestError,
    );
    const self = await createDomainSelfTest(f.a.slug, f.ref, f.student, {
      language: "ui",
      code: '{"prompt":"self"}',
      version_id: version,
    });
    const [selfRow] = await f.db.select().from(selfTests).where(
      eq(selfTests.id, self.id),
    );
    assertEquals(
      (selfRow.task_snapshot as {
        llm_execution: { domain_id: string; models: { model: string }[] };
      }).llm_execution.domain_id,
      f.a.id,
    );
    assertEquals(
      (selfRow.task_snapshot as {
        llm_execution: { models: { model: string }[] };
      }).llm_execution.models[0].model,
      "changed-a-model",
    );
    const selfB = await createDomainSelfTest(f.b.slug, f.ref, f.student, {
      language: "ui",
      code: '{"prompt":"B"}',
      version_id: versionB,
    });
    const app = createApp();
    const token = await signToken({ sub: f.student, role: "user" });
    const historyPath =
      `/api/v1/domains/${f.a.slug}/problems/${f.ref}/self-tests?limit=1`;
    const historyResponse = await jsonRequest(app, historyPath, { token });
    assertEquals(historyResponse.status, 200);
    const history = await historyResponse.json();
    assertEquals(history.data.map((r: { id: string }) => r.id), [self.id]);
    assertEquals(history.data[0].version_id, version);
    assertEquals(history.data[0].domain_id, f.a.id);
    assertEquals(history.pagination.total, 1);
    assertEquals("code" in history.data[0], false);
    const otherDomain = await jsonRequest(
      app,
      historyPath.replace(f.a.slug, f.b.slug),
      { token },
    );
    assertEquals(
      (await otherDomain.json()).data.map((r: { id: string }) => r.id),
      [selfB.id],
    );
    const outsiderToken = await signToken({ sub: f.outsider, role: "user" });
    assertEquals(
      (await jsonRequest(app, historyPath, { token: outsiderToken })).status,
      404,
    );
    const contest = crypto.randomUUID();
    await f.db.insert(contests).values({
      id: contest,
      domain_id: f.a.id,
      title: "固定UI",
      type: "kaggle",
      kind: "invite",
      created_by: f.owner,
      start_time: new Date(Date.now() - 60000).toISOString(),
      end_time: new Date(Date.now() + 60000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(contestProblems).values({
      contest_id: contest,
      domain_id: f.a.id,
      domain_problem_binding_id: f.bindingA.id,
      problem_id: f.problemId,
      label: "A",
      score: 10000,
      pinned_version_id: version,
    });
    await f.db.insert(contestParticipants).values({
      contest_id: contest,
      user_id: f.student,
      registered_at: now,
    });
    await assertRejects(
      () => getDomainContestTemplate(f.a.slug, contest, "A", f.student),
      NotFoundError,
    );
    const duringContest = await jsonRequest(app, historyPath, { token });
    assertEquals(duringContest.status, 403);
    assertEquals(
      (await duringContest.json()).code,
      "CONTEST_PROBLEM_RESTRICTED",
    );
    const selfPath = `/api/v1/domains/${f.a.slug}/self-tests/${self.id}`;
    assertEquals((await jsonRequest(app, selfPath, { token })).status, 403);
    assertEquals(
      (await jsonRequest(app, historyPath.replace(f.a.slug, f.b.slug), {
        token,
      })).status,
      200,
    );
    await f.db.update(contests).set({
      end_time: new Date(Date.now() - 1000).toISOString(),
    }).where(eq(contests.id, contest));
    assertEquals((await jsonRequest(app, historyPath, { token })).status, 200);
    const restoredSelfTest = await jsonRequest(app, selfPath, { token });
    assertEquals(restoredSelfTest.status, 200);
    assertEquals(
      (await restoredSelfTest.json()).data.code,
      '{"prompt":"self"}',
    );
  } finally {
    globalThis.fetch = oldFetch;
    getRedis().disconnect();
    resetRedisForTest();
    await fake.stop();
    if (oldSecret === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldSecret);
    if (oldRedis === undefined) Deno.env.delete("REDIS_URL");
    else Deno.env.set("REDIS_URL", oldRedis);
  }
});

Deno.test("主线融合 Domain：共享 prediction 文件复用目标域配额、绑定与真实存储", async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(problemVersions).values({
    id,
    problem_id: f.problemId,
    version: 3,
    published_at: now,
    content: {
      kind: "ai",
      title: "预测题",
      description: "题面",
      samples: [],
      submission_mode: "prediction",
      runtime_config: { evaluator: f.runtime.evaluator },
      template_content: "",
      artifact_max_size_mb: 1,
      llm_config: null,
    },
  });
  await f.db.update(problems).set({ latest_version_id: id }).where(
    eq(problems.id, f.problemId),
  );
  const dir = await Deno.makeTempDir({ prefix: "noj-domain-prediction-" }),
    storage = new LocalStorageProvider(dir);
  setStorageProviderForTest(storage);
  const fake = startFakeRedis(), previous = Deno.env.get("REDIS_URL");
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  try {
    await getRedis().connect();
    const bytes = new TextEncoder().encode("id,prediction\n1,0.5\n");
    const created = await createDomainArtifactSubmission(
      f.a.slug,
      f.ref,
      f.student,
      {
        version_id: id,
        file_name: "answer.csv",
        file_stream: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      },
    );
    const [row] = await f.db.select().from(submissions).where(
      eq(submissions.id, created.id),
    );
    assertEquals(row.domain_id, f.a.id);
    assertEquals(row.domain_problem_binding_id, f.bindingA.id);
    assertEquals(row.submitted_version_id, id);
    assertEquals(await storage.get(row.artifact_storage_url!), bytes);
    const task = JSON.parse(fake.getMessages("noj:judge:queue:ai:medium")[0]);
    assertEquals(task.submission_mode, "prediction");
    assertEquals(task.runtime_config.solution, undefined);
    await assertRejects(
      () =>
        createDomainSubmission(f.a.slug, f.ref, f.student, {
          language: "python3",
          code: "pass",
          version_id: id,
        }),
      AppError,
    );
  } finally {
    getRedis().disconnect();
    resetRedisForTest();
    await fake.stop();
    resetStorageProvider();
    await Deno.remove(dir, { recursive: true });
    if (previous === undefined) Deno.env.delete("REDIS_URL");
    else Deno.env.set("REDIS_URL", previous);
  }
});
