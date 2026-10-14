/** 真实 LLM 链路：公开源题 → 两学校独立 Provider/模型 → Judge → Gateway → Mock → 用量。 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.13";
import {
  api,
  BASE_URL,
  e2eTest,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

const suffix = Date.now().toString(36);
const MOCK_URL = Deno.env.get("E2E_LLM_MOCK_URL") ||
  "http://noj-e2e-llm-mock:8002/v1";
const source = `llm-source-${suffix}`,
  schoolA = `llm-a-${suffix}`,
  schoolB = `llm-b-${suffix}`,
  empty = `llm-empty-${suffix}`;
const modelA = `school-a-${suffix}`, modelB = `school-b-${suffix}`;
let admin = "",
  student = "",
  ownerA = "",
  ownerB = "",
  providerA = "",
  providerB = "";
let domainA = "",
  domainB = "",
  problemId = "",
  number = 0,
  versionId = "",
  submissionA = "",
  submissionB = "";
let originalAttempt = "";

interface Usage {
  domain_id: string;
  submission_id: string;
  problem_id: string;
  problem_version_id: string;
  attempt_id: string;
  provider_id: string;
  model: string;
  total_tokens: number;
  status: string;
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  revision?: number,
) {
  const result = await api(method, path, {
    token,
    body,
    ...(revision === undefined
      ? {}
      : { headers: { "If-Match": String(revision) } }),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}
async function join(slug: string, token: string, email: string) {
  const invite = await call(
    "POST",
    `/api/v1/domains/${slug}/invitations`,
    admin,
    { email },
  ) as { data: { token: string } };
  await call("POST", "/api/v1/domain-invitations/accept", token, {
    token: invite.data.token,
  });
}
async function configure(
  slug: string,
  token: string,
  provider: string,
  model: string,
) {
  const settings = await call(
    "GET",
    `/api/v1/domains/${slug}/llm/settings`,
    token,
  ) as { data: { revision: number } };
  return await call("PUT", `/api/v1/domains/${slug}/llm/settings`, token, {
    provider_id: provider,
    model,
  }, settings.data.revision);
}

/** SDK 从冻结的使用域执行配置选择模型，不携带源域模型。 */
const evaluator = `from noj_evaluator_sdk import llm, result
response = llm.complete(messages=[{"role": "user", "content": "ping"}])
if response.get("ok") and response.get("usage", {}).get("total_tokens") == 8:
    result.accept(score=100)
else:
    result.wrong_answer(score=0, message="Mock response mismatch")
`;

async function importBundle(network = true) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/problem.json`,
      JSON.stringify({
        format_version: 2,
        title: `共享 LLM 题 ${suffix}`,
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            time_limit_ms: 30000,
            memory_limit_mb: 512,
            network: { enabled: network },
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 5000,
            memory_limit_mb: 512,
          },
        },
        llm: { max_calls: 30 },
      }),
    );
    await Deno.writeTextFile(
      `${dir}/statement.md`,
      "# 共享 LLM 题\n不同学校使用各自模型与预算。",
    );
    await Deno.writeTextFile(`${dir}/evaluate.py`, evaluator);
    const packed = await new Deno.Command("zip", {
      args: ["-r", `${dir}/bundle.zip`, "."],
      cwd: dir,
    }).output();
    assertEquals(packed.code, 0);
    const bytes = await Deno.readFile(`${dir}/bundle.zip`);
    const body = new FormData();
    body.set(
      "file",
      new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
      "llm.zip",
    );
    const response = await fetch(
      `${BASE_URL}/api/v1/domains/${source}/problems/import-bundle`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}` },
        body,
      },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function submit(slug: string) {
  const response = await call(
    "POST",
    `/api/v1/domains/${slug}/submissions`,
    student,
    {
      problem_ref: `${source}:${number}`,
      version_id: versionId,
      language: "python3",
      code: "def solve(): return 1",
    },
  ) as { data: { id: string } };
  return response.data.id;
}
async function finished(slug: string, id: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await call(
      "GET",
      `/api/v1/domains/${slug}/submissions/${id}`,
      student,
    ) as {
      data: { status: string; result: { score: number } | null };
    };
    if (response.data.status === "error") {
      throw new Error(`LLM 平台错误：${JSON.stringify(response.data)}`);
    }
    if (response.data.status === "finished") {
      assertEquals(response.data.result?.score, 10000);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`LLM 评测等待超时 ${slug}:${id}`);
}
async function usage(slug: string, token: string, id: string) {
  const response = await call(
    "GET",
    `/api/v1/domains/${slug}/llm/usage?submission_id=${id}`,
    token,
  ) as { data: Usage[] };
  return response.data;
}

e2eTest(
  "[e2e/llm-gateway] Setup：两私有学校、独立负责人和同源共享版本",
  async () => {
    await waitForServer();
    admin = await getAdminToken();
    ownerA = await registerUser(
      `llm_a_${suffix}`,
      `llm_a_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    ownerB = await registerUser(
      `llm_b_${suffix}`,
      `llm_b_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    student = await registerUser(
      `llm_student_${suffix}`,
      `llm_student_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    for (
      const [slug, preset] of [[source, "community"], [schoolA, "education"], [
        schoolB,
        "education",
      ], [empty, "education"]]
    ) {
      const created = await call("POST", "/api/v1/domains", admin, {
        slug,
        name: slug,
        preset,
      }) as { data: { id: string } };
      if (slug === schoolA) domainA = created.data.id;
      if (slug === schoolB) domainB = created.data.id;
    }
    for (
      const [slug, token, email] of [[
        schoolA,
        ownerA,
        `llm_a_${suffix}@test.com`,
      ], [schoolB, ownerB, `llm_b_${suffix}@test.com`]]
    ) {
      await join(slug, token, email);
      const me = await call("GET", "/api/v1/auth/me", token) as {
        data: { id: string; is_admin: boolean };
      };
      assertEquals(me.data.is_admin, false);
      await call("POST", `/api/v1/domains/${slug}/transfer`, admin, {
        user_id: me.data.id,
      });
    }
    for (const slug of [schoolA, schoolB, empty]) {
      await join(
        slug,
        student,
        `llm_student_${suffix}@test.com`,
      );
    }
    for (
      const [slug, token, model] of [[schoolA, ownerA, modelA], [
        schoolB,
        ownerB,
        modelB,
      ]]
    ) {
      const provider = await call(
        "POST",
        `/api/v1/domains/${slug}/llm/providers`,
        token,
        {
          name: `${slug}-provider`,
          base_url: MOCK_URL,
          api_key: "isolated-e2e-mock-key",
          enabled: true,
        },
        0,
      ) as { data: { id: string } };
      if (slug === schoolA) providerA = provider.data.id;
      else providerB = provider.data.id;
      await configure(slug, token, provider.data.id, model);
    }
    const imported = await importBundle();
    assertEquals(imported.status, 201);
    const draft = imported.body.data as {
      problem_id: string;
      number: number;
      draft_revision: number;
    };
    problemId = draft.problem_id;
    number = draft.number;
    const published = await call(
      "POST",
      `/api/v1/domains/${source}/problems/${number}/publish`,
      admin,
      { change_note: "LLM V1" },
      draft.draft_revision,
    ) as { version_id: string };
    versionId = published.version_id;
    const sharing = await call(
      "GET",
      `/api/v1/domains/${source}/problems/${number}/sharing`,
      admin,
    ) as { data: { revision: number } };
    await call(
      "POST",
      `/api/v1/domains/${source}/problems/${number}/sharing`,
      admin,
      {
        enabled: true,
        scope: "selected",
        target_domain_slugs: [schoolA, schoolB, empty],
      },
      sharing.data.revision,
    );
    for (
      const [slug, token] of [[schoolA, ownerA], [schoolB, ownerB], [
        empty,
        admin,
      ]]
    ) {
      await call("POST", `/api/v1/domains/${slug}/problem-bindings`, token, {
        source_ref: `${source}:${number}`,
      });
    }
  },
);

e2eTest(
  "[e2e/llm-gateway] 学校管理员不能选择、改写或列出其他域 Provider",
  async () => {
    const settings = await call(
      "GET",
      `/api/v1/domains/${schoolA}/llm/settings`,
      ownerA,
    ) as { data: { revision: number } };
    const rejected = await api(
      "PUT",
      `/api/v1/domains/${schoolA}/llm/settings`,
      {
        token: ownerA,
        headers: { "If-Match": String(settings.data.revision) },
        body: { provider_id: providerB, model: modelB },
      },
    );
    assertEquals(rejected.status, 404);
    const cross = await api(
      "PUT",
      `/api/v1/domains/${schoolA}/llm/providers/${providerB}`,
      {
        token: ownerA,
        headers: { "If-Match": "1" },
        body: { enabled: false },
      },
    );
    assertEquals(cross.status, 404);
    assertEquals(
      (await api("GET", `/api/v1/domains/${schoolB}/llm/providers`, {
        token: ownerA,
      })).status,
      404,
    );
    const actual = await call(
      "GET",
      `/api/v1/domains/${schoolA}/llm/settings`,
      ownerA,
    ) as { data: { provider_id: string; model: string } };
    assertEquals(actual.data.provider_id, providerA);
    assertEquals(actual.data.model, modelA);
  },
);

e2eTest(
  "[e2e/llm-gateway] 无本域 Provider 的共享 LLM 题在提交前被拒绝",
  async () => {
    const response = await api("POST", `/api/v1/domains/${empty}/submissions`, {
      token: student,
      body: {
        problem_ref: `${source}:${number}`,
        version_id: versionId,
        language: "python3",
        code: "def solve(): return 1",
      },
    });
    assertEquals(response.status, 400);
    assertEquals(
      (response.body as { code: string }).code,
      "DOMAIN_LLM_NOT_CONFIGURED",
    );
    const list = await call(
      "GET",
      `/api/v1/domains/${empty}/submissions?problem_id=${problemId}`,
      student,
    ) as { pagination: { total: number } };
    assertEquals(list.pagination.total, 0);
  },
);

e2eTest("[e2e/llm-gateway] LLM 题包未开网络仍拒绝导入", async () => {
  assertEquals((await importBundle(false)).status, 400);
});

e2eTest(
  "[e2e/llm-gateway] 同源题在两学校完成真实评测，各自模型和持久用量隔离",
  async () => {
    submissionA = await submit(schoolA);
    submissionB = await submit(schoolB);
    await finished(schoolA, submissionA);
    await finished(schoolB, submissionB);
    for (
      const [slug, token, id, domain, provider, model] of [
        [schoolA, ownerA, submissionA, domainA, providerA, modelA],
        [schoolB, ownerB, submissionB, domainB, providerB, modelB],
      ]
    ) {
      const rows = await usage(slug, token, id);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].domain_id, domain);
      assertEquals(rows[0].problem_id, problemId);
      assertEquals(rows[0].problem_version_id, versionId);
      assertEquals(rows[0].provider_id, provider);
      assertEquals(rows[0].model, model);
      assertEquals(rows[0].total_tokens, 8);
      assertNotEquals(rows[0].attempt_id, null);
      if (slug === schoolA) originalAttempt = rows[0].attempt_id;
    }
    assertEquals(await usage(schoolA, ownerA, submissionB), []);
    assertEquals(await usage(schoolB, ownerB, submissionA), []);
    assertEquals(
      (await api(
        "GET",
        `/api/v1/domains/${schoolB}/submissions/${submissionA}`,
        { token: student },
      )).status,
      404,
    );
  },
);

e2eTest(
  "[e2e/llm-gateway] 重测新尝试重新签 token 并使用当时本域模型，另一学校不受影响",
  async () => {
    const newModel = `${modelA}-rejudge`;
    await configure(schoolA, ownerA, providerA, newModel);
    const response = await api(
      "POST",
      `/api/v1/domains/${schoolA}/submission-jobs`,
      {
        token: ownerA,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          kind: "rejudge",
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: submissionA }],
          },
          target: { mode: "submitted" },
          policy_changes: [],
        },
      },
    );
    assertEquals(response.status, 202);
    const job = (response.body as { data: { job_id: string } }).data.job_id;
    for (let attempt = 0; attempt < 90; attempt++) {
      const current = await call(
        "GET",
        `/api/v1/domains/${schoolA}/submission-jobs/${job}`,
        ownerA,
      ) as { data: { status: string } };
      if (current.data.status === "completed") break;
      if (current.data.status === "completed_with_errors" || attempt === 89) {
        throw new Error(`重测任务未成功完成 ${JSON.stringify(current)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await finished(schoolA, submissionA);
    const rows = await usage(schoolA, ownerA, submissionA);
    assertEquals(rows.length, 2);
    assertEquals(
      rows.find((row) => row.attempt_id === originalAttempt)!.model,
      modelA,
    );
    const fresh = rows.find((row) => row.attempt_id !== originalAttempt)!;
    assertEquals(fresh.model, newModel);
    assertEquals(fresh.provider_id, providerA);
    assertEquals(fresh.domain_id, domainA);
    assertEquals(fresh.total_tokens, 8);
    const nextB = await submit(schoolB);
    await finished(schoolB, nextB);
    assertEquals((await usage(schoolB, ownerB, nextB))[0].model, modelB);
  },
);

e2eTest(
  "[e2e/llm-gateway] 已发布题规则不可变，Provider停用阻止新提交并保留历史",
  async () => {
    const path = `/api/v1/domains/${source}/problems/${number}`;
    const draft = await call("GET", `${path}/draft`, admin) as {
      revision: number;
      content: Record<string, unknown> & {
        runtime_config: { evaluator: Record<string, unknown> };
      };
    };
    const disabled = structuredClone(draft.content);
    disabled.runtime_config.evaluator.network = { enabled: false };
    const noNetwork = await api("PUT", `${path}/draft`, {
      token: admin,
      headers: { "If-Match": String(draft.revision) },
      body: { content: disabled },
    });

    async function checkProviderDisabled() {
      const providers = await call(
        "GET",
        `/api/v1/domains/${schoolA}/llm/providers`,
        ownerA,
      ) as {
        data: { id: string; revision: number }[];
      };
      const before = await call(
        "GET",
        `/api/v1/domains/${schoolA}/submissions?problem_id=${problemId}`,
        student,
      ) as {
        pagination: { total: number };
      };
      await call(
        "PUT",
        `/api/v1/domains/${schoolA}/llm/providers/${providerA}`,
        ownerA,
        { enabled: false },
        providers.data.find((provider) => provider.id === providerA)!
          .revision,
      );
      const rejected = await api(
        "POST",
        `/api/v1/domains/${schoolA}/submissions`,
        {
          token: student,
          body: {
            problem_ref: `${source}:${number}`,
            version_id: versionId,
            language: "python3",
            code: "def solve(): return 1",
          },
        },
      );
      assertEquals(rejected.status, 400);
      const after = await call(
        "GET",
        `/api/v1/domains/${schoolA}/submissions?problem_id=${problemId}`,
        student,
      ) as {
        pagination: { total: number };
      };
      assertEquals(after.pagination.total, before.pagination.total);
      assertEquals((await usage(schoolA, ownerA, submissionA)).length, 2);
      const other = await call(
        "GET",
        `/api/v1/domains/${schoolB}/llm/providers`,
        ownerB,
      ) as {
        data: { id: string; enabled: boolean }[];
      };
      assertEquals(
        other.data.find((provider) => provider.id === providerB)!.enabled,
        true,
      );
    }
    assertEquals(noNetwork.status, 400);
    const kind = await api("PUT", `${path}/draft`, {
      token: admin,
      headers: { "If-Match": String(draft.revision) },
      body: {
        content: {
          kind: "objective",
          title: "错误转换",
          description: "不可转换",
          samples: [],
          questions: [{
            key: "immutable-kind-test",
            sort_order: 0,
            type: "single",
            prompt: "选择 A",
            options: [{ key: "A", text: "A" }, { key: "B", text: "B" }],
            answer: ["A"],
            explanation: "A",
          }],
        },
      },
    });
    assertEquals(kind.status, 400);
    assertEquals(
      (kind.body as { code: string }).code,
      "CONTENT_KIND_IMMUTABLE",
    );
    const detail = await call("GET", path, admin) as {
      version_id: string;
      content: { kind: string; llm_config: unknown };
    };
    assertEquals(detail.version_id, versionId);
    assertEquals(detail.content.kind, "ai");
    assertNotEquals(detail.content.llm_config, null);
    await checkProviderDisabled();
  },
);
