/**
 * 调用级超时（issue #198）全链路 E2E。
 *
 * 覆盖：
 * - 调用级 timeout_ms 覆盖题目级默认（慢调用按调用级超时，记为失败用例，评测继续）
 * - 缺省时回退题目级 call_timeout_ms（向后兼容旧行为）
 *
 * 要求：
 *   NOJ_RUN_E2E=1 表示启用 E2E 测试套件
 *   E2E_BASE_URL 指向运行中的 noj-core 服务
 */

import {
  apiGet,
  apiPost,
  getAdminToken,
  isE2E,
  registerUser,
  e2eTest,
} from "./helper.ts";


// ── 测试常量 ─────────────────────────────────────────

const EVALUATOR_IMAGE = "noj-evaluator-python";
const SOLUTION_IMAGE = "noj-solution-python";
const TEST_TAG = `e2e-${Date.now()}`;

// ── 共享 fixtures ────────────────────────────────────

/** 创建（或复用）evaluator 镜像白名单条目 */
async function ensureImage(
  image: string,
  kind: "evaluator" | "solution",
): Promise<string> {
  const adminToken = await getAdminToken();
  const list = await apiGet("/api/v1/admin/judge-images", adminToken);
  type JiEntry = { id: string; image: string; kind: string };
  const existing = ((list.body as { data: JiEntry[] }).data ?? []).find(
    (ji) => ji.image === image && ji.kind === kind,
  );
  if (existing) return existing.id;

  const create = await apiPost(
    "/api/v1/admin/judge-images",
    {
      image,
      kind,
      mode: "exact",
      description: `e2e ${kind} image`,
    },
    adminToken,
  );
  if (create.status !== 201) {
    throw new Error(
      `Failed to create image ${image} (kind=${kind}): ${create.status} ${
        JSON.stringify(create.body)
      }`,
    );
  }
  return (create.body as { data: JiEntry }).data.id;
}

/** evaluator 内联脚本：调用 sleep_solution 并捕获异常记录 status */
function evaluatorCommand(timeoutMs?: number): string {
  const call = timeoutMs === undefined
    ? `runner.call('sleep_solution')`
    : `runner.call('sleep_solution', timeout_ms=${timeoutMs})`;
  // evaluator.command 无需支持包：直接用 python3 -c 内联
  return `python3 -c "
import json
from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    ${call}
    result.accept(score=1000, details={'cases': [{'id': 'c1', 'status': 'Accepted'}]})
except Exception as e:
    result.accept(score=0, details={'cases': [{'id': 'c1', 'status': type(e).__name__}]})
"`;
}

/** 创建题目（双 runtime_config），返回 problem_id */
async function createDualProblem(
  adminToken: string,
  title: string,
  evaluatorCommand: string,
  callTimeoutMs: number,
): Promise<string> {
  const res = await apiPost(
    "/api/v1/problems",
    {
      title,
      description: `# ${title}\n\nMarkdown 内容`,
      difficulty: "medium",
      type: "P",
      number: Math.floor(Math.random() * 9000) + 1000,
      runtime_config: {
        evaluator: {
          image: EVALUATOR_IMAGE,
          command: evaluatorCommand,
          time_limit_ms: 10_000,
          memory_limit_mb: 512,
        },
        solution: {
          image: SOLUTION_IMAGE,
          call_timeout_ms: callTimeoutMs,
          memory_limit_mb: 256,
        },
      },
    },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      `Failed to create dual problem: ${res.status} ${
        JSON.stringify(res.body)
      }`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

/** 提交并轮询到终态，返回完整 submission data（含 details） */
async function submitAndWait(
  userToken: string,
  problemId: string,
  code: string,
): Promise<Record<string, unknown>> {
  const sub = await apiPost(
    "/api/v1/submissions",
    { problem_id: problemId, language: "python3", code },
    userToken,
  );
  if (sub.status !== 201) {
    throw new Error(
      `Submit failed: ${sub.status} ${JSON.stringify(sub.body)}`,
    );
  }
  const submissionId = (sub.body as { data: { id: string } }).data.id;

  // 轮询直到 finished（最多 120s；评测队列在 3 组并行下可能拥堵，
  // 60s 上限曾在 CI 出现超时）
  for (let i = 0; i < 60; i++) {
    const res = await apiGet(
      `/api/v1/submissions/${submissionId}`,
      userToken,
    );
    if (res.status === 200) {
      const data = (res.body as { data: Record<string, unknown> }).data;
      // finished 与 error 都返回：error 让下方断言暴露真实原因，
      // 避免镜像缺失等评测失败被误报为"超时未完成"
      if (data.status === "finished" || data.status === "error") {
        return data;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Submission ${submissionId} 超时未完成`);
}

// ── Tests ────────────────────────────────────────────

e2eTest("call_timeout: 调用级 timeout_ms 生效，慢调用记为失败用例且评测继续", async () => {
    const adminToken = await getAdminToken();
    await ensureImage(EVALUATOR_IMAGE, "evaluator");
    await ensureImage(SOLUTION_IMAGE, "solution");

    const problemId = await createDualProblem(
      adminToken,
      `[${TEST_TAG}] 调用级超时`,
      evaluatorCommand(100), // 调用级 timeout_ms=100（覆盖题目级 5000）
      5_000, // 题目级默认宽松；验证调用级覆盖
    );

    const userToken = await registerUser(
      `callto_${Date.now()}`,
      `callto_${Date.now()}@test.local`,
      "UserPass123!",
    );

    // sleep_solution 睡 300ms > 调用级 100ms
    const data = await submitAndWait(
      userToken,
      problemId,
      "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n",
    );

    const result = data.result as {
      status: string;
      details?: { cases?: unknown[] };
    };
    if (result.status !== "Accepted") {
      throw new Error(
        `评测应继续完成（Accepted），实际 ${result.status}: ${
          JSON.stringify(data)
        }`,
      );
    }
    const cases = result.details?.cases as Array<
      { id: string; status: string }
    >;
    if (!cases || cases[0]?.status !== "SolutionTimeoutError") {
      throw new Error(
        `超时用例应被记录为 SolutionTimeoutError: ${
          JSON.stringify(result.details)
        }`,
      );
    }
  }
);

e2eTest("call_timeout: 缺省回退题目级 call_timeout_ms", async () => {
    const adminToken = await getAdminToken();
    await ensureImage(EVALUATOR_IMAGE, "evaluator");
    await ensureImage(SOLUTION_IMAGE, "solution");

    const problemId = await createDualProblem(
      adminToken,
      `[${TEST_TAG}] 缺省回退`,
      evaluatorCommand(), // 不传 timeout_ms → 回退题目级 100ms
      100, // 题目级默认：100ms
    );

    const userToken = await registerUser(
      `callfb_${Date.now()}`,
      `callfb_${Date.now()}@test.local`,
      "UserPass123!",
    );

    const data = await submitAndWait(
      userToken,
      problemId,
      "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n",
    );

    const result = data.result as {
      status: string;
      details?: { cases?: unknown[] };
    };
    if (result.status !== "Accepted") {
      throw new Error(
        `评测应继续完成（Accepted），实际 ${result.status}: ${
          JSON.stringify(data)
        }`,
      );
    }
    const cases = result.details?.cases as Array<
      { id: string; status: string }
    >;
    if (!cases || cases[0]?.status !== "SolutionTimeoutError") {
      throw new Error(
        `缺省回退应触发题目级超时并记录 SolutionTimeoutError: ${
          JSON.stringify(result.details)
        }`,
      );
    }
  }
);
