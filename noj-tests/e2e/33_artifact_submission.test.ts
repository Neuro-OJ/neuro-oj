/**
 * Artifact 提交跨模块 E2E：上传 zip → 评测 → 分数展示。
 */

import { zipSync, strToU8 } from "npm:fflate@0.8.2";
import {
  apiGet,
  apiPost,
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

function makeZip(): Blob {
  const zipData = zipSync({
    "submission.py": strToU8("def solve():\n    return 42\n"),
  });
  return new Blob([zipData as unknown as BlobPart], { type: "application/zip" });
}

e2eTest("[e2e/artifact] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
});

e2eTest("[e2e/artifact] 创建 artifact 题目并上传 zip 评测", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  const userToken = await registerUser(
    `artifact_${ts}`,
    `artifact_${ts}@test.com`,
    TEST_PASSWORD,
  );

  // 创建 artifact 题目
  const createRes = await apiPost(
    "/api/v1/problems",
    {
      title: `[E2E] Artifact ${ts}`,
      description: "artifact submission e2e",
      difficulty: "easy",
      type: "P",
      submission_mode: "artifact",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command:
            `python3 -c "import json; from noj_evaluator_sdk import SolutionRunner, result; ` +
            `runner = SolutionRunner(); value = runner.call('solve'); ` +
            `result.accept(score=10000, details={'value': value})"`,
          time_limit_ms: 15000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 128,
        },
      },
    },
    adminToken,
  );
  if (createRes.status !== 201) {
    throw new Error(`创建 artifact 题目失败: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  const problemId = (createRes.body as { data: { id: string } }).data.id;

  // 上传 zip
  const form = new FormData();
  form.append("problem_id", problemId);
  form.append("language", "python3");
  form.append("file", makeZip(), "submission.zip");
  const uploadRes = await fetch(`${BASE_URL}/api/v1/submissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: form,
  });
  if (uploadRes.status !== 201) {
    throw new Error(`上传 artifact 失败: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const submission = (await uploadRes.json() as { data: { id: string } }).data;

  // 轮询评测结果
  let result: { status: string; score?: number } | null = null;
  for (let i = 0; i < 40; i++) {
    const detail = await apiGet(`/api/v1/submissions/${submission.id}`, userToken);
    const d = (detail.body as { data: { status: string; result: { status: string; score: number } | null } }).data;
    if (d.status === "finished" || d.status === "error") {
      result = d.result ?? { status: d.status };
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!result) throw new Error("评测超时未结束");
  if (result.status !== "finished") {
    throw new Error(`评测未成功: ${JSON.stringify(result)}`);
  }
  if ((result.score ?? 0) <= 0) {
    throw new Error(`分数异常: ${JSON.stringify(result)}`);
  }
  console.log("  ✓ artifact 上传 → 评测 → 分数展示 OK");
});
