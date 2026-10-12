/**
 * LLM Gateway 全链路 E2E 测试。
 *
 * 覆盖：
 * - 7.1 创建 Provider → 创建 P 型 LLM 题 → 提交 → evaluator 经 gateway 调用 Mock LLM → 用量落库
 * - 7.2 U 型题携带 llm 被拒；LLM 题未开网络被拒
 * - 7.3 重测重新签发 token（重测后产生新的用量记录）
 *
 * 依赖环境：
 * - NOJ_RUN_E2E=1
 * - noj-core / noj-judge / noj-llm-gateway 已启动
 * - E2E_LLM_MOCK_URL 指向一个 OpenAI 兼容 Mock 服务（例如 http://llm-mock:8002/v1）
 *   Mock 需对 POST /chat/completions 返回 {"ok": true, "choices": []}
 * - E2E_LLM_MOCK_MODEL 可选，默认 e2e-mock
 */
import {
  apiGet,
  apiPost,
  apiPut,
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  publishProblemVersion,
  submitCode,
  waitForJobCompleted,
  waitForServer,
} from "../helper.ts";

const testSuffix = Date.now().toString(36);
const MOCK_MODEL = Deno.env.get("E2E_LLM_MOCK_MODEL") || "e2e-mock";
const MOCK_URL = Deno.env.get("E2E_LLM_MOCK_URL") ||
  "http://noj-e2e-llm-mock:8002/v1";

let adminToken = "";
let judgeAvailable = false;
let providerId = "";
let problemId = "";
let submissionId = "";
let usageCountBeforeRejudge = 0;

const EVALUATOR_PY = `# E2E LLM Gateway 测试评测脚本
import json
from noj_evaluator_sdk import llm

try:
    resp = llm.complete(
        model=${JSON.stringify(MOCK_MODEL)},
        messages=[{"role": "user", "content": "ping"}],
    )
    ok = bool(resp.get("ok"))
    result = {
        "score": 100 if ok else 0,
        "details": resp,
    }
except Exception as error:
    result = {
        "score": 0,
        "details": {"error": str(error)},
    }

print("---RESULT---")
print(json.dumps(result, default=str), flush=True)
`;

async function makeZip(
  manifest: string,
  problemStatement: string,
): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  const enc = new TextEncoder();
  try {
    await Deno.writeFile(`${dir}/problem.json`, enc.encode(manifest));
    await Deno.writeFile(`${dir}/statement.md`, enc.encode(problemStatement));
    await Deno.writeFile(`${dir}/evaluate.py`, enc.encode(EVALUATOR_PY));
    const zipPath = `${dir}/bundle.zip`;
    const cmd = new Deno.Command("zip", {
      args: ["-r", zipPath, "."],
      cwd: dir,
    });
    const out = await cmd.output();
    if (out.code !== 0) throw new Error("zip 打包失败");
    return await Deno.readFile(zipPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function importBundle(
  manifest: string,
  problemStatement: string,
): Promise<{ status: number; body: unknown }> {
  const zip = await makeZip(manifest, problemStatement);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob(
      [zip.buffer.slice(
        zip.byteOffset,
        zip.byteOffset + zip.byteLength,
      ) as ArrayBuffer],
      { type: "application/zip" },
    ),
    `e2e-llm-${testSuffix}.zip`,
  );
  const res = await fetch(`${BASE_URL}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: formData,
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function llmManifest(
  type: "P" | "U",
  number: number,
  withNetwork: boolean,
  includeLlm: boolean,
): string {
  return JSON.stringify({
    format_version: 1,
    title: `E2E LLM ${type} ${testSuffix}`,
    difficulty: "easy",
    type,
    number,
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        time_limit_ms: 30000,
        memory_limit_mb: 512,
        network: withNetwork ? { enabled: true } : undefined,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 5000,
        memory_limit_mb: 512,
      },
    },
    ...(includeLlm ? { llm: { max_calls: 30 } } : {}),
  });
}

e2eTest("[e2e/llm-gateway] Setup: 管理员登录 + 检查 judge", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  judgeAvailable = await isJudgeAvailable();
  if (!judgeAvailable) {
    console.warn("⚠ judge 不可用，LLM 评测闭环部分跳过（仍执行 API 校验用例）");
  }

  // 创建 Provider 指向 Mock LLM
  const res = await apiPost(
    "/api/v1/admin/gateway/llm/providers",
    {
      name: `e2e-mock-${testSuffix}`,
      base_url: MOCK_URL,
      api_key: "e2e-mock-key",
      enabled: true,
    },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      `创建 LLM Provider 失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  providerId = (res.body as { data: { id: string } }).data.id;

  // 平台默认：题目不再携带 provider/model，改由平台设置提供
  const setProvider = await apiPut(
    "/api/v1/admin/system/settings/llm_default_provider_id",
    { value: providerId },
    adminToken,
  );
  if (setProvider.status !== 200) {
    throw new Error(
      `写入默认 Provider 失败: ${setProvider.status} ${
        JSON.stringify(setProvider.body)
      }`,
    );
  }
  const setModel = await apiPut(
    "/api/v1/admin/system/settings/llm_default_model",
    { value: MOCK_MODEL },
    adminToken,
  );
  if (setModel.status !== 200) {
    throw new Error(
      `写入默认模型失败: ${setModel.status} ${JSON.stringify(setModel.body)}`,
    );
  }
});

e2eTest("[e2e/llm-gateway] 7.2 U 型题携带 llm 被拒", async () => {
  if (!isE2E || !providerId) return;
  const number = 91000 + (Date.now() % 1000);
  const res = await importBundle(
    llmManifest("U", number, true, true),
    `# E2E LLM U 型题\n\n不应创建成功`,
  );
  if (res.status < 400) {
    throw new Error(`U 型 LLM 导入应当失败，实际 ${res.status}`);
  }
});

e2eTest("[e2e/llm-gateway] 7.2 LLM 题未开网络被拒", async () => {
  if (!isE2E || !providerId) return;
  const number = 92000 + (Date.now() % 1000);
  const res = await importBundle(
    llmManifest("P", number, false, true),
    `# E2E LLM 未开网络\n\n不应创建成功`,
  );
  if (res.status < 400) {
    throw new Error(`未开网络的 LLM 导入应当失败，实际 ${res.status}`);
  }
});

e2eTest("[e2e/llm-gateway] 7.1 导入 P 型 LLM 题并提交评测", async () => {
  if (!isE2E || !providerId || !judgeAvailable) return;
  const number = 93000 + (Date.now() % 1000);
  const imported = await importBundle(
    llmManifest("P", number, true, true),
    `# E2E LLM P 型题\n\nMock LLM 应答 ok=true 时应 finished 且得分>0`,
  );
  if (imported.status !== 201 && imported.status !== 200) {
    throw new Error(
      `导入 P 型 LLM 题失败: ${imported.status} ${
        JSON.stringify(imported.body)
      }`,
    );
  }
  problemId = (imported.body as { data: { id: string } }).data.id;
  // 题包导入只写共享草稿；提交前必须显式发布作答版本（Handbook §6.2）
  await publishProblemVersion(adminToken, problemId, "E2E LLM 题 V1");

  submissionId = await submitCode(
    adminToken,
    problemId,
    "def solve(): return 1",
  );
  const result = await pollSubmission(adminToken, submissionId, 60, 2000, true);
  if (result.status !== "finished" || result.score <= 0) {
    const detailRes = await apiGet(
      `/api/v1/submissions/${submissionId}`,
      adminToken,
    );
    const detail = (detailRes.body as {
      data?: { result?: { output?: string; details?: unknown } };
    }).data;
    throw new Error(
      `LLM 评测预期 finished 且分数 >0，实际 ${result.status} (score=${result.score}) output=${
        detail?.result?.output ?? "(无)"
      } details=${JSON.stringify(detail?.result?.details ?? {})}`,
    );
  }

  // 用量审计落库
  const usage = await apiGet(
    `/api/v1/admin/gateway/llm/usage?submission_id=${submissionId}`,
    adminToken,
  );
  if (usage.status !== 200) {
    throw new Error(
      `用量查询失败: ${usage.status} ${JSON.stringify(usage.body)}`,
    );
  }
  const rows = (usage.body as { data: unknown[] }).data;
  if (rows.length === 0) {
    throw new Error("LLM 用量未落库");
  }
});

e2eTest("[e2e/llm-gateway] 7.3 重测重新签发 token", async () => {
  if (!isE2E || !submissionId || !judgeAvailable) return;
  // 记录重测前用量行数
  const before = await apiGet(
    `/api/v1/admin/gateway/llm/usage?submission_id=${submissionId}`,
    adminToken,
  );
  usageCountBeforeRejudge =
    ((before.body as { data: unknown[] }).data ?? []).length;

  const rejudge = await apiPost(
    `/api/v1/admin/submission/submissions/${submissionId}/rejudge`,
    {},
    adminToken,
  );
  // 统一任务受理（Handbook §4.3）：202 + 任务 ID
  if (rejudge.status !== 202) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }
  const jobId = (rejudge.body as { data: { job_id: string } }).data.job_id;

  // 先等任务终态：只轮询提交会在"上一条 finished 仍可见"时提前返回，
  // 从而在重测真正执行前就检查用量（实测误报"token 未重新签发"）。
  await waitForJobCompleted(adminToken, jobId);
  await pollSubmission(adminToken, submissionId, 60, 2000, true);

  const after = await apiGet(
    `/api/v1/admin/gateway/llm/usage?submission_id=${submissionId}`,
    adminToken,
  );
  const afterRows = (after.body as { data: unknown[] }).data ?? [];
  if (afterRows.length <= usageCountBeforeRejudge) {
    throw new Error("重测后未产生新的 LLM 用量记录（token 可能未重新签发）");
  }
});

e2eTest("[e2e/llm-gateway] 更新 LLM 题关闭网络被拒", async () => {
  if (!isE2E || !problemId) return;
  const detail = await apiGet(`/api/v1/problems/${problemId}`, adminToken);
  const problem = (detail.body as {
    data?: {
      runtime_config?: { evaluator?: { network?: { enabled?: boolean } } };
    };
  }).data;
  const rc = problem?.runtime_config as {
    evaluator: {
      image: string;
      time_limit_ms: number;
      memory_limit_mb: number;
      network: { enabled: boolean };
    };
    solution: {
      image: string;
      call_timeout_ms: number;
      memory_limit_mb: number;
    };
  };
  const res = await apiPut(
    `/api/v1/problems/${problemId}`,
    {
      runtime_config: {
        ...rc,
        evaluator: { ...rc.evaluator, network: { enabled: false } },
      },
    },
    adminToken,
  );
  if (res.status < 400) {
    throw new Error(`关闭 LLM 题网络应当失败，实际 ${res.status}`);
  }
});

e2eTest(
  "[e2e/llm-gateway] 已发布 LLM 题不允许改为客观题（题型不可变）",
  async () => {
    if (!isE2E || !problemId) return;
    // Handbook §2.3：首次发布后固定 kind 与 AI 提交模式，跨题型转换必须新建题目。
    // 因此对已发布的 LLM 题改 is_objective 应被 409 拒绝，而不是静默改行后
    // 与已发布版本内容不一致。
    const res = await apiPut(
      `/api/v1/problems/${problemId}`,
      { is_objective: true },
      adminToken,
    );
    if (res.status !== 409) {
      throw new Error(
        `题型不可变应返回 409，实际 ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    const detail = await apiGet(`/api/v1/problems/${problemId}`, adminToken);
    const problem = (detail.body as {
      data?: { is_objective?: boolean; llm_config?: unknown };
    }).data;
    if (problem?.is_objective !== false) {
      throw new Error("被拒的题型切换不得改写题目行");
    }
    if (problem?.llm_config == null) {
      throw new Error("被拒的题型切换不得清空已发布版本的 llm_config");
    }
  },
);
