import { assertEquals } from "jsr:@std/assert@^1.0.13";
import {
  buildProblemBundle,
  problemBundleForm,
} from "../../fixtures/problem-bundle.ts";
import {
  api,
  BASE_URL,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

export interface LlmAccount {
  id: string;
  username: string;
  email: string;
  token: string;
}
export interface LlmSchool {
  id: string;
  slug: string;
  owner: LlmAccount;
}
export interface LlmUsage {
  domain_id: string;
  provider_id: string;
  model: string;
  submission_id: string;
  attempt_id: string;
  problem_id: string;
  problem_version_id: string;
  total_tokens: number;
  status: string;
}

export async function llmFixtureApi<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  revision?: number,
): Promise<T> {
  const response = await api(method, `/api/v1${path}`, {
    token,
    body,
    ...(revision === undefined
      ? {}
      : { headers: { "If-Match": String(revision) } }),
  });
  assertEquals(
    response.status >= 200 && response.status < 300,
    true,
    `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}
async function account(label: string, suffix: string): Promise<LlmAccount> {
  const username = `${label}_${suffix}`, email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const me = await llmFixtureApi<{ data: { id: string; is_admin: boolean } }>(
    "GET",
    "/auth/me",
    token,
  );
  assertEquals(me.data.is_admin, false);
  return { id: me.data.id, username, email, token };
}
async function invite(slug: string, owner: string, member: LlmAccount) {
  const invitation = await llmFixtureApi<{ data: { token: string } }>(
    "POST",
    `/domains/${slug}/invitations`,
    owner,
    { email: member.email },
  );
  await llmFixtureApi("POST", "/domain-invitations/accept", member.token, {
    token: invitation.data.token,
  });
}

/**
 * 生成 evaluator 脚本。
 *
 * 直接调用域别名 `fast` 并校验上游返回的模型名与 token 用量。
 */
export function buildLlmGovernanceEvaluatorScript(suffix: string): string {
  const models = [
    `llmgov-a-${suffix}-current`,
    `llmgov-a-${suffix}-next`,
    `llmgov-b-${suffix}`,
  ];
  return `from noj_evaluator_sdk import llm, result

response = llm.complete(model="fast", messages=[{"role": "user", "content": "governance"}])
models = ${JSON.stringify(models)}
if response.get("ok") and response.get("usage", {}).get("total_tokens") == 8 and response.get("model") in models:
    result.accept(score=100)
else:
    result.wrong_answer(score=0, message="LLM governance upstream model mismatch")
`;
}

/** 仅以公开 API 建账号/域/共享题；所有 Provider 与模型治理留给真实页面。 */
export async function createLlmGovernanceFixture(suffix: string) {
  const admin = await getAdminToken();
  const a = await account("llmgov_a", suffix),
    b = await account("llmgov_b", suffix),
    student = await account("llmgov_s", suffix);
  const source = `llmgov-source-${suffix}`;
  await llmFixtureApi("POST", "/domains", admin, {
    slug: source,
    name: source,
    preset: "community",
  });
  const schools: LlmSchool[] = [];
  for (const [tag, owner] of [["a", a], ["b", b]] as const) {
    const slug = `llmgov-${tag}-${suffix}`;
    const domain = await llmFixtureApi<{ data: { id: string } }>(
      "POST",
      "/domains",
      admin,
      { slug, name: slug, preset: "education" },
    );
    await invite(slug, admin, owner);
    await llmFixtureApi("POST", `/domains/${slug}/transfer`, admin, {
      user_id: owner.id,
    });
    await invite(slug, owner.token, student);
    schools.push({ id: domain.data.id, slug, owner });
  }
  const evaluatorScript = buildLlmGovernanceEvaluatorScript(suffix);
  const archive = buildProblemBundle({
    "problem.json": JSON.stringify({
      format_version: 2,
      title: `Browser共享模型能力 ${suffix}`,
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
          // 真实 LLM 调用需要 evaluator 加入 noj-eval-net。
          network: { enabled: true },
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      llm: { models: ["fast"], max_calls: 2, max_tokens: 1000 },
    }),
    "statement.md": "# 共享 LLM 能力\n两所学校独立映射 fast。\n",
    "evaluate.py": evaluatorScript,
  });
  const imported = await fetch(
    `${BASE_URL}/api/v1/domains/${source}/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
      body: problemBundleForm(archive, "llm-governance.zip"),
    },
  );
  const body = await imported.json();
  assertEquals(imported.status, 201, JSON.stringify(body));
  const problem = body.data as {
    problem_id: string;
    number: number;
    draft_revision: number;
  };
  const published = await llmFixtureApi<{ version_id: string }>(
    "POST",
    `/domains/${source}/problems/${problem.number}/publish`,
    admin,
    { change_note: "Browser LLM治理验收" },
    problem.draft_revision,
  );
  const ref = `${source}:${problem.number}`;
  return {
    schools,
    student,
    source,
    ref,
    problemId: problem.problem_id,
    versionId: published.version_id,
    evaluatorScript,
  };
}

export interface LlmGovernanceCopy {
  ref: string;
  problemId: string;
  versionId: string;
}

/** 学校配置 fast 别名后，把源题导入为本域独立副本；返回本域题号与版本。 */
export async function copyLlmGovernanceProblem(
  school: LlmSchool,
  sourceRef: string,
  admin: string,
): Promise<LlmGovernanceCopy> {
  const copied = await llmFixtureApi<{
    data: {
      reference: { problem_id: string; display_ref: string };
      version_id: string;
    };
  }>("POST", `/domains/${school.slug}/problem-bindings`, admin, {
    source_ref: sourceRef,
  });
  return {
    ref: copied.data.reference.display_ref,
    problemId: copied.data.reference.problem_id,
    versionId: copied.data.version_id,
  };
}

export async function submitLlmGovernance(
  school: LlmSchool,
  student: LlmAccount,
  ref: string,
  versionId: string,
) {
  const result = await llmFixtureApi<{ data: { id: string } }>(
    "POST",
    `/domains/${school.slug}/submissions`,
    student.token,
    {
      problem_ref: ref,
      version_id: versionId,
      language: "python3",
      code: "def solve(): return 1",
    },
  );
  return result.data.id;
}
export async function finishLlmGovernance(
  school: LlmSchool,
  student: LlmAccount,
  id: string,
) {
  for (let n = 0; n < 120; n++) {
    const result = await llmFixtureApi<
      { data: { status: string; result: { score: number } | null } }
    >("GET", `/domains/${school.slug}/submissions/${id}`, student.token);
    if (result.data.status === "error") {
      throw new Error(`真实LLM评测错误 ${JSON.stringify(result.data)}`);
    }
    if (result.data.status === "finished") {
      assertEquals(result.data.result?.score, 10000);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`真实LLM评测超时 ${id}`);
}
export async function llmGovernanceUsage(
  school: LlmSchool,
  id: string,
): Promise<LlmUsage[]> {
  for (let n = 0; n < 20; n++) {
    const result = await llmFixtureApi<{ data: LlmUsage[] }>(
      "GET",
      `/domains/${school.slug}/llm/usage?submission_id=${id}`,
      school.owner.token,
    );
    if (result.data.length) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`真实调用用量为空 ${school.slug}:${id}`);
}
