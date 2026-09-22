/**
 * Prediction 提交跨模块 E2E：上传单个预测文件 → 单容器评测（无 Solution 容器）
 * → 隐藏用例比对算分。
 *
 * 覆盖链路：admin 建 prediction 题（evaluator 命令读 `$NOJ_PREDICTION_DIR` 下唯一
 * 文件与内联隐藏标签）→ 普通用户 multipart 上传 `.csv` →
 * `POST /api/v1/submissions` → 轮询 `GET /api/v1/submissions/:id` →
 * 断言 `finished` 且 `score > 0`。
 *
 * 评测脚本故意保留 1/3 错误预测，使 score = 6666：既证明脚本真的读到了预测文件
 * 与隐藏标签并逐条比对，又不同于任何硬编码满分。
 */

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
} from "../helper.ts";

/**
 * 构造 evaluator 命令。
 *
 * 注意 judge 的 `parse_command` 是简单的 shell 风格分词：反斜杠会被当作转义符
 * 吃掉，双引号会切换「引号内」状态。因此本命令刻意满足：
 * - 用 `python3 -c "<代码>"` 外层双引号包裹；
 * - python 代码**不出现双引号与反斜杠**（字符串统一用单引号），
 *   避免分词器把代码中的空格当作参数分隔符。
 *
 * 代码逻辑：`load_predictions()` 在 `$NOJ_PREDICTION_DIR` 下自动定位唯一预测文件，
 * 逐 case 与内联隐藏标签（c1/c3 命中、c2 故意错）比对，输出每 case 必带
 * `hidden: true`，score 按 2/3 折算为 6666。
 */
function buildEvaluatorCommand(): string {
  const code = [
    "from noj_evaluator_sdk import load_predictions, result",
    "gold = {'c1': '1', 'c2': '1', 'c3': '1'}",
    "b = load_predictions()",
    "cases = [{'case_id': r['case_id'], 'status': 'Accepted' if r['label'] == gold[r['case_id']] else 'WrongAnswer', 'hidden': True} for r in b.rows]",
    "ok = sum(1 for c in cases if c['status'] == 'Accepted')",
    "units = int(10000 * ok / len(cases)) if cases else 0",
    "result.accept(score=units / 100, details={'cases': cases})",
  ].join("; ");
  return `python3 -c "${code}"`;
}

/** 预测文件内容：每行 `case_id,label`，与隐藏标签相比 2/3 正确。 */
const PREDICTIONS_CSV = "case_id,label\nc1,1\nc2,0\nc3,1\n";

function makePredictionCsv(): Blob {
  return new Blob([PREDICTIONS_CSV], { type: "text/csv" });
}

e2eTest("[e2e/prediction] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
});

e2eTest("[e2e/prediction] 创建 prediction 题目并上传 csv 评测", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  const userToken = await registerUser(
    `prediction_${ts}`,
    `prediction_${ts}@test.com`,
    TEST_PASSWORD,
  );

  // 创建 prediction 题目：无 Solution 容器，故省略 runtime_config.solution
  const createRes = await apiPost(
    "/api/v1/problems",
    {
      title: `[E2E] Prediction ${ts}`,
      description: "prediction submission e2e",
      difficulty: "easy",
      type: "P",
      submission_mode: "prediction",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: buildEvaluatorCommand(),
          time_limit_ms: 15000,
          memory_limit_mb: 256,
        },
        // prediction 模式省略 solution（无 Solution 容器）
      },
    },
    adminToken,
  );
  if (createRes.status !== 201) {
    throw new Error(
      `创建 prediction 题目失败: ${createRes.status} ${
        JSON.stringify(createRes.body)
      }`,
    );
  }
  const problemId = (createRes.body as { data: { id: string } }).data.id;

  // multipart 上传单个预测 csv
  const form = new FormData();
  form.append("problem_id", problemId);
  form.append("file", makePredictionCsv(), "predictions.csv");
  const uploadRes = await fetch(`${BASE_URL}/api/v1/submissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: form,
  });
  if (uploadRes.status !== 201) {
    throw new Error(
      `上传预测文件失败: ${uploadRes.status} ${await uploadRes.text()}`,
    );
  }
  const submission = (await uploadRes.json() as { data: { id: string } }).data;

  // 轮询评测结果
  let result: { status: string; score?: number } | null = null;
  for (let i = 0; i < 40; i++) {
    const detail = await apiGet(
      `/api/v1/submissions/${submission.id}`,
      userToken,
    );
    const d = (detail.body as {
      data: {
        status: string;
        result: { status: string; score: number } | null;
      };
    }).data;
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
  console.log("  ✓ prediction 上传 → 单容器评测 → 隐藏用例算分 OK");
});
