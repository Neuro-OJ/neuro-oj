import { assertEquals } from "jsr:@std/assert@^1.0.13";
import {
  buildProblemBundle,
  problemBundleForm,
} from "../../fixtures/problem-bundle.ts";
import {
  createEvaluationGate,
  deleteEvaluationGate,
  EVALUATION_GATE_WAIT_LIMIT_MS,
  type EvaluationGatePlacement,
  type EvaluationGateStatus,
  releaseEvaluationGate,
  resolveEvaluationGatePlacement,
  waitForEvaluationGateArrival,
} from "../../fixtures/evaluation-gate.ts";
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

/** 本 run 独有的评测屏障：主机管理地址 + evaluator 内部地址 + gate 标识。 */
export interface LlmGovernanceGate {
  placement: EvaluationGatePlacement;
  /** gate 标识；带 run 后缀，跨 run 不会互相释放。 */
  id: string;
  /** evaluator 每次执行到达时拼接 nonce 的前缀。 */
  arrival: string;
}

/**
 * 创建本轮唯一的评测屏障。
 *
 * gate 必须在评测任务开始前就存在：evaluator 会直接 `wait`，缺 gate 即 404 失败。
 * 创建/释放/删除都由测试进程持有，夹具只负责把 evaluator 一侧的地址写进脚本。
 */
export async function createLlmGovernanceGate(
  suffix: string,
): Promise<LlmGovernanceGate> {
  const placement = resolveEvaluationGatePlacement();
  const id = `llmgov-${suffix}`;
  await createEvaluationGate(placement, { id, runId: suffix });
  return { placement, id, arrival: id };
}

/** 等待至少 `minArrivals` 个 evaluator 到达屏障（默认 1，兼容 Judge 并发 1）。 */
export function waitForLlmGovernanceArrival(
  gate: LlmGovernanceGate,
  minArrivals = 1,
): Promise<EvaluationGateStatus> {
  return waitForEvaluationGateArrival(gate.placement, gate.id, {
    minArrivals,
    timeoutMs: EVALUATION_GATE_WAIT_LIMIT_MS,
  });
}

/** 释放屏障；幂等，可安全放在 finally 里。 */
export function releaseLlmGovernanceGate(
  gate: LlmGovernanceGate,
): Promise<EvaluationGateStatus> {
  return releaseEvaluationGate(gate.placement, gate.id);
}

/** 取消等待者并删除屏障；必须在 release 之后调用。 */
export function deleteLlmGovernanceGate(
  gate: LlmGovernanceGate,
): Promise<void> {
  return deleteEvaluationGate(gate.placement, gate.id);
}

/**
 * 生成 evaluator 脚本。
 *
 * 屏障等待替代原来的固定 20 秒休眠：evaluator 到达后阻塞，测试进程在「尝试仍在途」
 * 的确定状态下经 UI 修改模型别名，再释放屏障。协调服务缺失、gate 不存在或等待
 * 超时都会抛错，judge 因此把评测记为 error，用例必须失败而不是假通过。
 */
export function buildLlmGovernanceEvaluatorScript(
  suffix: string,
  gate: LlmGovernanceGate,
): string {
  const models = [
    `llmgov-a-${suffix}-current`,
    `llmgov-a-${suffix}-next`,
    `llmgov-b-${suffix}`,
  ];
  return `import json
import urllib.request
import uuid

from noj_evaluator_sdk import llm, result

# 屏障地址是 evaluator 容器所在 Docker 网络内的服务名，不是宿主机 loopback。
GATE_URL = ${JSON.stringify(gate.placement.evaluatorUrl)}
GATE_ID = ${JSON.stringify(gate.id)}
GATE_ARRIVAL = ${JSON.stringify(gate.arrival)}
GATE_WAIT_SECONDS = ${EVALUATION_GATE_WAIT_LIMIT_MS / 1000}


def wait_for_gate() -> None:
    """阻塞到测试进程释放屏障；协调服务缺失、gate 不存在或超时都必须让评测失败。"""
    arrival = GATE_ARRIVAL + ":" + uuid.uuid4().hex[:8]
    url = GATE_URL + "/gates/" + GATE_ID + "/wait?arrival=" + arrival
    url += "&timeout=" + str(GATE_WAIT_SECONDS)
    with urllib.request.urlopen(url, timeout=GATE_WAIT_SECONDS + 5) as response:
        payload = json.load(response)
    if payload.get("cancelled"):
        raise RuntimeError("评测屏障已被取消: " + json.dumps(payload))
    if payload.get("timed_out") or not payload.get("released"):
        raise RuntimeError("评测屏障等待超时: " + json.dumps(payload))


wait_for_gate()
response = llm.complete(model="fast", messages=[{"role": "user", "content": "governance"}])
models = ${JSON.stringify(models)}
if response.get("ok") and response.get("usage", {}).get("total_tokens") == 8 and response.get("model") in models:
    result.accept(score=100)
else:
    result.wrong_answer(score=0, message="LLM governance upstream model mismatch")
`;
}

/** 仅以公开 API 建账号/域/共享题；所有 Provider 与模型治理留给真实页面。 */
export async function createLlmGovernanceFixture(
  suffix: string,
  gate: LlmGovernanceGate,
) {
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
  const evaluatorScript = buildLlmGovernanceEvaluatorScript(suffix, gate);
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
          // 屏障与真实 LLM 调用都需要 evaluator 加入 noj-eval-net。
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
    // 用例可直接断言夹具确实用屏障替代了固定休眠。
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
