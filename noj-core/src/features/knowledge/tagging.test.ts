/**
 * AI 打标测试（真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 模型调用经 `setTagCompleterForTest` 注入，**不发起任何真实网络请求**；
 * 预算/用量经平台网关接口读取，`NOJ_LLM_GATEWAY_URL` 指向不可达地址时
 * `queryPlatformUsage` 会失败——预算相关用例只用 budget=0 的短路路径。
 *
 * 覆盖：开关关闭不调用；hash 未变 skipped；人工挂载 skipped；预算用尽 /
 * 预算为 0 → budget_paused 且 reschedule 到下月；别名未配置 skipped；
 * 非法输出重试一次后 failed；合法输出按阈值 auto/pending；提示词 system
 * 部分跨题逐字节一致且不含 summary、user 部分被截断。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql as sqlRaw } from "drizzle-orm";
import { createApp } from "../../app.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  backgroundTasks,
  knowledgeAreas,
  knowledgeNodes,
  knowledgePacks,
  knowledgeTagRuns,
  problemKnowledge,
  problems,
  problemVersions,
  users,
} from "../../shared/db/schema.ts";
import { resetSetting, updateSetting } from "../../modules/platform/index.ts";
import { PlatformCompletionError } from "../../modules/platform/index.ts";
import { ConflictError } from "../../shared/base/errors.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { importPack } from "./import.ts";
import { resolveOfficialPackDir } from "./pack.ts";
import {
  backfillKnowledgeTags,
  buildTagSystemPrompt,
  buildTagUserPrompt,
  KNOWLEDGE_TAG_TASK_TYPE,
  knowledgeTagHandler,
  monthStart,
  nextMonthStart,
  setTagCompleterForTest,
  TAG_DESCRIPTION_LIMIT_CHARS,
  TAG_SAMPLES_LIMIT_CHARS,
} from "./tagging.ts";
import type { TagCompleter, TagCompletionResult } from "./tagging.ts";
import { isTaskRescheduleResult } from "../../modules/runtime/index.ts";
import { setOffpeakNowForTest } from "./offpeak.ts";

await initRedisForTest();

const admin = () => userActorFromAuthenticatedId("0");

/** 记录调用次数的假模型。 */
function fakeCompleter(
  build: (call: number) => TagCompletionResult | Error,
): TagCompleter & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  // deno-lint-ignore require-await
  const fn = (async (input) => {
    calls.push({
      system: input.messages[0]!.content,
      user: input.messages[1]!.content,
    });
    const result = build(calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  }) as TagCompleter & { calls: { system: string; user: string }[] };
  fn.calls = calls;
  return fn;
}

function reply(content: string): TagCompletionResult {
  return { content, model: "fake-model", input_tokens: 10, output_tokens: 5 };
}

/** 跑一次打标任务（直接调用 handler，target = 题目）。 */
async function runTag(problemId: string) {
  return await knowledgeTagHandler({
    id: crypto.randomUUID(),
    taskType: KNOWLEDGE_TAG_TASK_TYPE,
    targetKind: "problem",
    targetId: problemId,
    dedupeKey: "",
    payloadVersion: 1,
    payload: {},
    failureCount: 0,
    leaseToken: "lease",
    leaseExpiry: new Date(Date.now() + 60_000).toISOString(),
  }, new AbortController().signal);
}

async function setTagging(enabled: boolean): Promise<void> {
  await updateSetting("knowledge_enabled", true, admin());
  await updateSetting("knowledge_ai_tagging_enabled", enabled, admin());
  // 既有用例与低峰时段无关：默认关闭 offpeak（低峰专项用例再显式开启）。
  await updateSetting("knowledge_ai_offpeak_only", false, admin());
}

async function fixture(options: { description?: string } = {}) {
  await resetDbForTest();
  await updateSetting("domain_creation_policy", "open", admin());
  const now = new Date().toISOString();
  const ownerId = crypto.randomUUID();
  await getDb().insert(users).values({
    id: ownerId,
    username: ownerId,
    email: `${ownerId}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(knowledgePacks).values({
    id: "test",
    name: "测试包",
    version: "1",
    license: "CC",
    active: true,
    imported_at: now,
  });
  await getDb().insert(knowledgeAreas).values({
    id: "area",
    pack_id: "test",
    name: "领域",
    sort: 0,
  });
  // 名称刻意打乱插入顺序，验证 system 提示词按 id 排序后稳定。
  for (
    const [id, name, sort] of [
      ["n.b", "线性回归", 1],
      ["n.a", "正则化", 0],
      ["n.c", "图论", 2],
    ] as const
  ) {
    await getDb().insert(knowledgeNodes).values({
      id,
      area_id: "area",
      pack_id: "test",
      name,
      summary: "这个 summary 绝不能出现在提示词里",
      status: "active",
      sort,
      updated_at: now,
    });
  }
  const { createSystemActor } = await import(
    "../../modules/runtime/index.ts"
  );
  const { ensureDefaultWorkspace } = await import(
    "../../modules/access/domains.ts"
  );
  await ensureDefaultWorkspace(createSystemActor("bootstrap"));
  const { domains } = await import("../../shared/db/schema.ts");
  const [workspace] = await getDb().select().from(domains).limit(1);
  const problemId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const description = options.description ?? "在 Ridge 与 Lasso 之间选择并调参";
  await getDb().insert(problems).values({
    id: problemId,
    domain_id: workspace.id,
    number: 1,
    title: "正则化选择",
    description,
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    schema_version: 1,
    origin: "published",
    content: {
      kind: "ai",
      title: "正则化选择",
      description,
      samples: [{ id: "s1", input: "1 2", output: "3" }],
      submission_mode: "code",
      template_content: "SECRET_TEMPLATE",
      runtime_config: null,
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await getDb().update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  return { ownerId, problemId, versionId };
}

async function runsOf(problemId: string) {
  return await getDb().select().from(knowledgeTagRuns).where(
    eq(knowledgeTagRuns.problem_id, problemId),
  );
}

Deno.test({
  name: "knowledge tagging: 开关关闭时不调用模型、不写记录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(false);
    const fake = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake);
    try {
      const outcome = await runTag(f.problemId) as { status: string };
      assertEquals(outcome.status, "disabled");
      assertEquals(fake.calls.length, 0);
      assertEquals((await runsOf(f.problemId)).length, 0);
    } finally {
      setTagCompleterForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: hash 未变 / 人工挂载 → skipped 不调用",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_offpeak_only", false, admin());
    await updateSetting("knowledge_ai_monthly_token_budget", 0, admin());
    // 预置一条同内容的 succeeded 记录（免预算查询）。
    const { computeTagContentHash } = await import("./tagging.ts");
    const [version] = await getDb().select().from(problemVersions).where(
      eq(problemVersions.id, f.versionId),
    );
    const hash = await computeTagContentHash(
      version!.content as Record<string, unknown>,
    );
    await getDb().insert(knowledgeTagRuns).values({
      id: crypto.randomUUID(),
      problem_id: f.problemId,
      version_id: f.versionId,
      content_hash: hash,
      model: "fake",
      prompt_version: "v",
      status: "succeeded",
      created_at: new Date().toISOString(),
    });
    const fake = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake);
    try {
      const outcome = await runTag(f.problemId) as {
        status: string;
        reason?: string;
      };
      assertEquals(outcome.status, "skipped");
      assertEquals(outcome.reason, "content_hash_unchanged");
      assertEquals(fake.calls.length, 0);
    } finally {
      setTagCompleterForTest(null);
    }

    // 人工挂载优先：另一个题目维度。
    const other = await fixture({ description: "另一道题" });
    await setTagging(true);
    await getDb().insert(problemKnowledge).values({
      problem_id: other.problemId,
      node_id: "n.a",
      role: "primary",
      source: "human",
      review_status: "confirmed",
      updated_at: new Date().toISOString(),
    });
    const fake2 = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake2);
    try {
      const outcome = await runTag(other.problemId) as {
        status: string;
        reason?: string;
      };
      assertEquals(outcome.status, "skipped");
      assertEquals(outcome.reason, "human_mapping_exists");
      assertEquals(fake2.calls.length, 0);
    } finally {
      setTagCompleterForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 预算为 0 → budget_paused 并 reschedule 到下月",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_offpeak_only", false, admin());
    await updateSetting("knowledge_ai_monthly_token_budget", 0, admin());
    const fake = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake);
    try {
      const outcome = await runTag(f.problemId);
      assertEquals(fake.calls.length, 0);
      assertEquals(isTaskRescheduleResult(outcome), true);
      const resumed = outcome as { availableAt: string };
      assertEquals(
        resumed.availableAt,
        nextMonthStart().toISOString(),
      );
      assertEquals(
        new Date(resumed.availableAt).getTime() >
          monthStart().getTime(),
        true,
      );
      const runs = await runsOf(f.problemId);
      assertEquals(runs.length, 1);
      assertEquals(runs[0]!.status, "budget_paused");
    } finally {
      setTagCompleterForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 别名未配置 → skipped 并记录原因",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_monthly_token_budget", 2000000, admin());
    // 预算检查需要网关用量：把网关地址指向不可达端口会让 queryPlatformUsage
    // 抛错——此处改用大预算 + 本地 mock 网关更稳妥，见下方 gateway mock。
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/platform-usage") {
        return Response.json({
          purpose: "knowledge.tag",
          since: url.searchParams.get("since") ?? "",
          input_tokens: 0,
          output_tokens: 0,
          requests: 0,
          cost: 0,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const previousUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
    const previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_GATEWAY_URL",
      `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    );
    Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-token");
    // 用默认（网关）调用路径，但不触发网关调用：先让 completer 抛别名错误
    // 不可行，因此这里模拟的是「任务在调用前已确定别名未配置」以外的路径——
    // 见下方用例：MODEL_ALIAS_NOT_CONFIGURED 由 completer 抛出的同类型错误。
    setTagCompleterForTest(() =>
      Promise.reject(
        new PlatformCompletionError(400, "MODEL_ALIAS_NOT_CONFIGURED"),
      )
    );
    try {
      const outcome = await runTag(f.problemId) as {
        status: string;
        reason?: string;
      };
      assertEquals(outcome.status, "skipped");
      assertEquals(outcome.reason, "model_alias_not_configured");
      const runs = await runsOf(f.problemId);
      assertEquals(runs.length, 1);
      assertEquals(runs[0]!.status, "skipped");
    } finally {
      setTagCompleterForTest(null);
      await server.shutdown();
      if (previousUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
      else Deno.env.set("NOJ_LLM_GATEWAY_URL", previousUrl);
      if (previousToken === undefined) {
        Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      } else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 非法输出重试一次后 failed，题目保持未归类",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_monthly_token_budget", 2000000, admin());
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1" },
      () =>
        Response.json({
          purpose: "knowledge.tag",
          since: new Date().toISOString(),
          input_tokens: 0,
          output_tokens: 0,
          requests: 0,
          cost: 0,
        }),
    );
    const previousUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
    const previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_GATEWAY_URL",
      `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    );
    Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-token");
    const fake = fakeCompleter(() => reply('{"primary": "n.missing"}'));
    setTagCompleterForTest(fake);
    try {
      const outcome = await runTag(f.problemId) as { status: string };
      assertEquals(outcome.status, "failed");
      assertEquals(fake.calls.length, 2);
      const runs = await runsOf(f.problemId);
      assertEquals(runs[0]!.status, "failed");
      // 失败也累计用量。
      assertEquals(runs[0]!.input_tokens, 20);
      const rows = await getDb().select().from(problemKnowledge).where(
        eq(problemKnowledge.problem_id, f.problemId),
      );
      assertEquals(rows.length, 0);
    } finally {
      setTagCompleterForTest(null);
      await server.shutdown();
      if (previousUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
      else Deno.env.set("NOJ_LLM_GATEWAY_URL", previousUrl);
      if (previousToken === undefined) {
        Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      } else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 合法输出按阈值 auto / pending",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_monthly_token_budget", 2000000, admin());
    await updateSetting("knowledge_auto_accept_threshold", 75, admin());
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1" },
      () =>
        Response.json({
          purpose: "knowledge.tag",
          since: new Date().toISOString(),
          input_tokens: 0,
          output_tokens: 0,
          requests: 0,
          cost: 0,
        }),
    );
    const previousUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
    const previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_GATEWAY_URL",
      `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    );
    Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-token");
    try {
      const highConfidence = JSON.stringify({
        primary: "n.a",
        secondary: ["n.b"],
        confidence: 0.9,
        rationale: "正则化",
      });
      const fake = fakeCompleter(() => reply(highConfidence));
      setTagCompleterForTest(fake);
      const outcome = await runTag(f.problemId) as { status: string };
      assertEquals(outcome.status, "succeeded");
      assertEquals(fake.calls.length, 1);
      let rows = await getDb().select().from(problemKnowledge).where(
        eq(problemKnowledge.problem_id, f.problemId),
      );
      const primary = rows.find((row) => row.role === "primary")!;
      assertEquals(primary.node_id, "n.a");
      assertEquals(primary.source, "ai");
      assertEquals(primary.review_status, "auto");
      assertEquals(primary.confidence, 90);
      let runs = await runsOf(f.problemId);
      assertEquals(runs[0]!.status, "succeeded");
      assertEquals(runs[0]!.input_tokens, 10);
      assertEquals(runs[0]!.output_tokens, 5);
      assertEquals(runs[0]!.model, "fake-model");

      // 低置信度 → pending（先清空旧挂载）。
      await getDb().delete(problemKnowledge).where(
        eq(problemKnowledge.problem_id, f.problemId),
      );
      setTagCompleterForTest(fakeCompleter(() =>
        reply(JSON.stringify({
          primary: "n.a",
          secondary: [],
          confidence: 0.3,
        }))
      ));
      // 同 hash 已成功后再次运行会 skipped；换一个内容版本。
      const now = new Date().toISOString();
      const nextVersion = crypto.randomUUID();
      await getDb().insert(problemVersions).values({
        id: nextVersion,
        problem_id: f.problemId,
        version: 2,
        schema_version: 1,
        origin: "published",
        content: {
          kind: "ai",
          title: "正则化选择",
          description: "新题面",
          samples: [],
          submission_mode: "code",
          template_content: "",
          runtime_config: null,
          artifact_max_size_mb: null,
          llm_config: null,
        },
        published_at: now,
      });
      await getDb().update(problems).set({ latest_version_id: nextVersion })
        .where(eq(problems.id, f.problemId));
      const second = await runTag(f.problemId) as { status: string };
      assertEquals(second.status, "succeeded");
      rows = await getDb().select().from(problemKnowledge).where(
        eq(problemKnowledge.problem_id, f.problemId),
      );
      assertEquals(
        rows.find((row) => row.role === "primary")!.review_status,
        "pending",
      );
      runs = await runsOf(f.problemId);
      assertEquals(runs.filter((r) => r.status === "succeeded").length, 2);
    } finally {
      setTagCompleterForTest(null);
      await server.shutdown();
      if (previousUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
      else Deno.env.set("NOJ_LLM_GATEWAY_URL", previousUrl);
      if (previousToken === undefined) {
        Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      } else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
    }
  },
});

Deno.test({
  name:
    "knowledge tagging: system 提示词跨题逐字节一致（无 summary），user 截断",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await importPack(resolveOfficialPackDir());
    const nodes = (await getDb().select().from(knowledgeNodes)).map((n) => ({
      id: n.id,
      name: n.name,
    }));
    const a = buildTagSystemPrompt(nodes);
    const b = buildTagSystemPrompt(
      [...nodes].sort((x, y) => x.id < y.id ? 1 : -1),
    );
    assertEquals(a, b);
    // 官方包 summary 是中文长句，确认没有混入任何节点的 summary。
    const summaries = (await getDb().select().from(knowledgeNodes))
      .map((n) => n.summary)
      .filter((s) => s.length >= 20);
    assertEquals(summaries.length > 0, true);
    assertEquals(summaries.some((s) => a.includes(s)), false);

    const longDescription = "题".repeat(TAG_DESCRIPTION_LIMIT_CHARS + 500);
    const user = buildTagUserPrompt({
      kind: "oi",
      title: "长题",
      description: longDescription,
      samples: Array.from({ length: 40 }, () => ({
        input: "i".repeat(100),
        output: "o".repeat(100),
      })),
      runtime_config: { judge: "j".repeat(5000) },
    });
    assertEquals(user.includes("已截断"), true);
    // 题面部分被截断到上限；样例合计也被截断。
    const descIndex = user.indexOf("\n题面：\n");
    assertEquals(descIndex > 0, true);
    const descSection = user.slice(descIndex + 5).split("\n公开样例：\n")[0]!;
    assertEquals(
      descSection.length <= TAG_DESCRIPTION_LIMIT_CHARS + 40,
      true,
    );
    assertEquals(descSection.startsWith("题".repeat(100)), true);
    assertEquals(
      user.length <=
        TAG_DESCRIPTION_LIMIT_CHARS + 200 +
          TAG_SAMPLES_LIMIT_CHARS + 1000,
      true,
    );
  },
});

Deno.test({
  name: "knowledge tagging: 回填预估与实际数偏差超过 10% → 409",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    // 未带 confirm → 400；带 confirmed 但偏差过大 → 409。
    await assertRejects(
      () => backfillKnowledgeTags(admin(), { expected_count: 1 }),
      Error,
    );
    // 当前实际待打标 1 道；声明预期 100（偏差 > 10%）。
    await assertRejects(
      () =>
        backfillKnowledgeTags(admin(), {
          confirm: true,
          expected_count: 100,
        }),
      ConflictError,
    );
    const ok = await backfillKnowledgeTags(admin(), {
      confirm: true,
      expected_count: 1,
    });
    assertEquals(ok.enqueued, 1);
    const [task] = await getDb().execute(sqlRawTag()) as unknown as {
      task_type: string;
      dedupe_key: string;
    }[];
    assertEquals(task!.task_type, KNOWLEDGE_TAG_TASK_TYPE);
    assertEquals(task!.dedupe_key, `tag:${f.versionId}`);
    // 再投一次命中去重，不新增。
    const again = await backfillKnowledgeTags(admin(), {
      confirm: true,
      expected_count: 1,
    });
    assertEquals(again.enqueued, 1);
    const count = await getDb().execute(sqlRawTagCount()) as unknown as {
      n: number;
    }[];
    assertEquals(Number(count[0]!.n), 1);
  },
});

import { sql } from "drizzle-orm";

function sqlRawTag() {
  return sql`SELECT task_type, dedupe_key FROM background_tasks ORDER BY created_at`;
}
function sqlRawTagCount() {
  return sql`SELECT count(*)::int AS n FROM background_tasks`;
}

/** 清理任务表，避免后续单测受残留影响。 */
Deno.test({
  name: "knowledge tagging: 管理 API 鉴权 401/403，用量/预估返回结构",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await fixture();
    await setTagging(true);
    const app = createApp();
    for (
      const path of [
        "/api/v1/admin/knowledge/tagging/usage",
        "/api/v1/admin/knowledge/tagging/estimate",
      ]
    ) {
      assertEquals((await jsonRequest(app, path)).status, 401);
      const userToken = await createUserToken("user");
      assertEquals(
        (await jsonRequest(app, path, { token: userToken })).status,
        403,
      );
    }
    assertEquals(
      (await jsonRequest(
        app,
        "/api/v1/admin/knowledge/tagging/backfill",
        { method: "POST", body: { confirm: true, expected_count: 1 } },
      )).status,
      401,
    );
    const userToken = await createUserToken("user");
    assertEquals(
      (await jsonRequest(
        app,
        "/api/v1/admin/knowledge/tagging/backfill",
        {
          method: "POST",
          token: userToken,
          body: { confirm: true, expected_count: 1 },
        },
      )).status,
      403,
    );
    // 实例管理员：预估可用（网关不可达时用量接口仍返回结构，费用/别名未知）。
    const adminToken = await createUserToken("admin");
    const estimate = await jsonRequest(
      app,
      "/api/v1/admin/knowledge/tagging/estimate",
      { token: adminToken },
    );
    assertEquals(estimate.status, 200);
    const data = (await estimate.json()).data;
    assertEquals(data.expected_count, 1);
    assertEquals(data.estimated_cost, null);
    // 偏差 409。
    const drifted = await jsonRequest(
      app,
      "/api/v1/admin/knowledge/tagging/backfill",
      {
        method: "POST",
        token: adminToken,
        body: { confirm: true, expected_count: data.expected_count + 10 },
      },
    );
    assertEquals(drifted.status, 409);
    await resetSetting("knowledge_ai_tagging_enabled", admin()).catch(() => {});
  },
});

// ── 低峰时段（任务 E）────────────────────────────────────
// 固定「当前时刻」使结果与真实运行时刻无关：以下用例默认模拟北京 12:00（时段外）。
const OFFPEAK_TEST_NOW = new Date("2026-11-13T04:00:00Z");

/** 设置低峰开关与时段。 */
async function setOffpeak(enabled: boolean, window?: string) {
  await updateSetting("knowledge_ai_offpeak_only", enabled, admin());
  if (window !== undefined) {
    await updateSetting("knowledge_ai_offpeak_window", window, admin());
  }
}

/** 可返回零用量的本地假网关（避免依赖真实网关）。 */
async function withZeroUsageGateway(
  fn: (restore: () => Promise<void>) => Promise<void>,
) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    () =>
      Response.json({
        purpose: "knowledge.tag",
        since: new Date().toISOString(),
        input_tokens: 0,
        output_tokens: 0,
        requests: 0,
        cost: 0,
      }),
  );
  const previousUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  const previousToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set(
    "NOJ_LLM_GATEWAY_URL",
    `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
  );
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-token");
  const restore = async () => {
    await server.shutdown();
    if (previousUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", previousUrl);
    if (previousToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previousToken);
  };
  try {
    await fn(restore);
  } finally {
    await restore();
  }
}

Deno.test({
  name: "knowledge tagging: 低峰时段外 → reschedule 且不调用模型、不写记录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await setOffpeak(true, "00:30-08:30");
    await updateSetting("knowledge_ai_monthly_token_budget", 2000000, admin());
    const fake = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake);
    setOffpeakNowForTest(OFFPEAK_TEST_NOW); // 北京 12:00
    try {
      const outcome = await runTag(f.problemId);
      assertEquals(fake.calls.length, 0);
      assertEquals(isTaskRescheduleResult(outcome), true);
      assertEquals(
        (outcome as { availableAt: string }).availableAt,
        "2026-11-13T16:30:00.000Z", // 北京 11/14 00:30
      );
      // 顺延在预算检查之前：预算为 0 也只会顺延、不写 budget_paused。
      assertEquals((await runsOf(f.problemId)).length, 0);
    } finally {
      setOffpeakNowForTest(null);
      setTagCompleterForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 时段内正常调用；关闭 offpeak 时任何时刻都调用",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await setOffpeak(true, "00:30-08:30");
    await updateSetting("knowledge_ai_monthly_token_budget", 2000000, admin());
    await withZeroUsageGateway(async () => {
      // 时段内（北京 03:00）→ 正常调用。
      const fake = fakeCompleter(() => reply('{"primary": "n.missing"}'));
      setTagCompleterForTest(fake);
      setOffpeakNowForTest(new Date("2026-11-13T19:00:00Z"));
      try {
        const outcome = await runTag(f.problemId);
        assertEquals(isTaskRescheduleResult(outcome), false);
        assertEquals(fake.calls.length > 0, true);
      } finally {
        setTagCompleterForTest(null);
      }
      // 关闭 offpeak：北京 12:00 也调用。
      await setOffpeak(false);
      setOffpeakNowForTest(OFFPEAK_TEST_NOW);
      const fake2 = fakeCompleter(() => reply('{"primary": "n.missing"}'));
      setTagCompleterForTest(fake2);
      try {
        const outcome = await runTag(f.problemId);
        assertEquals(isTaskRescheduleResult(outcome), false);
        assertEquals(fake2.calls.length > 0, true);
      } finally {
        setOffpeakNowForTest(null);
        setTagCompleterForTest(null);
      }
    });
  },
});

Deno.test({
  name: "knowledge tagging: 非法窗口回退默认（时段外仍顺延）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await updateSetting("knowledge_ai_offpeak_only", true, admin());
    // 直接写库绕过写入校验，模拟历史脏数据 / env 兜底非法值。
    await getDb().execute(
      sqlRaw`UPDATE system_settings SET value = '"bad"'::jsonb
             WHERE key = 'knowledge_ai_offpeak_window'`,
    );
    setOffpeakNowForTest(OFFPEAK_TEST_NOW); // 北京 12:00（默认时段外）
    const fake = fakeCompleter(() => reply("{}"));
    setTagCompleterForTest(fake);
    try {
      const outcome = await runTag(f.problemId);
      assertEquals(fake.calls.length, 0);
      assertEquals(
        (outcome as { availableAt: string }).availableAt,
        "2026-11-13T16:30:00.000Z",
      );
    } finally {
      setOffpeakNowForTest(null);
      setTagCompleterForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 回填投递在时段外设置 availableAt",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setTagging(true);
    await setOffpeak(true, "00:30-08:30");
    setOffpeakNowForTest(OFFPEAK_TEST_NOW);
    try {
      const result = await backfillKnowledgeTags(admin(), {
        confirm: true,
        expected_count: 1,
      });
      assertEquals(result.enqueued, 1);
      const [task] = await getDb().select().from(backgroundTasks).where(
        and(
          eq(backgroundTasks.task_type, KNOWLEDGE_TAG_TASK_TYPE),
          eq(backgroundTasks.target_id, f.problemId),
        ),
      );
      assertEquals(task!.available_at, "2026-11-13T16:30:00.000Z");
    } finally {
      setOffpeakNowForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tagging: 用量接口含 offpeak 视图",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await fixture();
    await setTagging(true);
    await setOffpeak(true, "22:00-06:00");
    setOffpeakNowForTest(OFFPEAK_TEST_NOW); // 北京 12:00，不在时段内
    try {
      const app = await createApp();
      const adminToken = await createUserToken("admin");
      const res = await jsonRequest(
        app,
        "/api/v1/admin/knowledge/tagging/usage",
        { token: adminToken },
      );
      assertEquals(res.status, 200);
      const data = (await res.json()).data;
      assertEquals(data.offpeak.enabled, true);
      assertEquals(data.offpeak.window, "22:00-06:00");
      assertEquals(data.offpeak.next_start, "2026-11-14T14:00:00.000Z");
      // 关闭后 next_start 为 null。
      await setOffpeak(false);
      const res2 = await jsonRequest(
        app,
        "/api/v1/admin/knowledge/tagging/usage",
        { token: adminToken },
      );
      const data2 = (await res2.json()).data;
      assertEquals(data2.offpeak.enabled, false);
      assertEquals(data2.offpeak.next_start, null);
    } finally {
      setOffpeakNowForTest(null);
    }
  },
});

// 清理：避免将测试用粗粒度任务留下（其余用例各自 resetDb）。
Deno.test({
  name: "knowledge tagging: 清理任务表",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await getDb().delete(problemKnowledge).where(
      and(
        eq(problemKnowledge.source, "ai"),
        eq(problemKnowledge.role, "primary"),
      ),
    ).catch(() => {});
    await resetDbForTest();
  },
});
