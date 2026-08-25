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
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  submitCode,
  waitForServer,
} from "./helper.ts";

const testSuffix = Date.now().toString(36);
const MOCK_MODEL = Deno.env.get("E2E_LLM_MOCK_MODEL") || "e2e-mock";
const MOCK_URL = Deno.env.get("E2E_LLM_MOCK_URL") || "http://172.17.0.1:8002/v1";

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
        "status": "Accepted" if ok else "WrongAnswer",
        "score": 100 if ok else 0,
        "details": resp,
    }
except Exception as error:
    result = {
        "status": "RuntimeError",
        "score": 0,
        "details": {"error": str(error)},
    }

print("---RESULT---")
print(json.dumps(result))
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
    ...(includeLlm
      ? { llm: { provider_id: providerId, model: MOCK_MODEL } }
      : {}),
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
    "/api/v1/admin/llm/providers",
    {
      name: `e2e-mock-${testSuffix}`,
      base_url: MOCK_URL,
      model: MOCK_MODEL,
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
    `# E2E LLM P 型题\n\nMock LLM 应答 ok=true 时应 Accepted`,
  );
  if (imported.status !== 201 && imported.status !== 200) {
    throw new Error(
      `导入 P 型 LLM 题失败: ${imported.status} ${
        JSON.stringify(imported.body)
      }`,
    );
  }
  problemId = (imported.body as { data: { id: string } }).data.id;

  submissionId = await submitCode(
    adminToken,
    problemId,
    "def solve(): return 1",
  );
  const result = await pollSubmission(adminToken, submissionId, 60, 2000, true);
  if (result.verdict !== "Accepted") {
    const detailRes = await apiGet(`/api/v1/submissions/${submissionId}`, adminToken);
    const detail = (detailRes.body as { data?: { result?: { output?: string; details?: unknown } } }).data;
    throw new Error(
      `LLM 评测预期 Accepted，实际 ${result.verdict} (score=${result.score}) output=${detail?.result?.output ?? "(无)"} details=${JSON.stringify(detail?.result?.details ?? {})}`,
    );
  }

  // 用量审计落库
  const usage = await apiGet(
    `/api/v1/admin/llm/usage?submission_id=${submissionId}`,
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
    `/api/v1/admin/llm/usage?submission_id=${submissionId}`,
    adminToken,
  );
  usageCountBeforeRejudge =
    ((before.body as { data: unknown[] }).data ?? []).length;

  const rejudge = await apiPost(
    `/api/v1/admin/submissions/${submissionId}/rejudge`,
    {},
    adminToken,
  );
  if (rejudge.status !== 200) {
    throw new Error(
      `重测失败: ${rejudge.status} ${JSON.stringify(rejudge.body)}`,
    );
  }

  await pollSubmission(adminToken, submissionId, 60, 2000, true);

  const after = await apiGet(
    `/api/v1/admin/llm/usage?submission_id=${submissionId}`,
    adminToken,
  );
  const afterRows = (after.body as { data: unknown[] }).data ?? [];
  if (afterRows.length <= usageCountBeforeRejudge) {
    throw new Error("重测后未产生新的 LLM 用量记录（token 可能未重新签发）");
  }
});
