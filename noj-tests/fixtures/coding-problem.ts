/** 通过真实题包导入与发布建立独立公开加法题，避免共用赛题污染练习回归。 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  BASE_URL,
  getAdminToken,
  publishProblemVersion,
} from "../e2e/helper.ts";
import { buildProblemBundle, problemBundleForm } from "./problem-bundle.ts";

/**
 * 已发布不可变题目夹具的显式句柄。
 *
 * 发布后的版本不可变，因此同一 journey 内可以安全复用；注册、改密、撤权、
 * 切身份与发布新版本仍需各自独立的状态，不复用这里的"当前最新版本"。
 */
export interface PublishedCodingProblem {
  /** 题目实体 ID（版本挂在它下面）。 */
  problemId: string;
  /** 已发布不可变版本 ID。 */
  versionId: string;
  /** `<domain>:<number>` 形式的域内引用，可直接作为跨域绑定的 source_ref。 */
  reference: string;
  /** 题目发布所在域。 */
  domain: string;
}

/**
 * 导入并发布独立加法题，返回题目/版本/引用/域。
 *
 * @returns 已发布不可变题目的显式句柄
 */
export async function createPublishedCodingProblem(): Promise<
  PublishedCodingProblem
> {
  const token = await getAdminToken();
  const archive = buildProblemBundle({
    "problem.json": JSON.stringify({
      format_version: 2,
      title: `独立加法题 ${crypto.randomUUID()}`,
      difficulty: "easy",
      judge_type: "dual",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 10000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      },
    }),
    "statement.md": "solve(input_str) 接收两个整数并返回它们的和。",
    "evaluate.py": `from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    if runner.call("solve", "1 2") == "3":
        result.accept(score=10)
    else:
        result.wrong_answer(score=0)
finally:
    runner.close()
`,
  });
  const response = await fetch(
    `${BASE_URL}/api/v1/domains/main/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: problemBundleForm(archive),
    },
  );
  const imported = await response.json();
  assertEquals(response.status, 201, JSON.stringify(imported));
  const problemId = imported.data.problem_id as string;
  const number = imported.data.number as number;
  const versionId = await publishProblemVersion(
    token,
    problemId,
    "独立练习回归夹具",
  );
  return { problemId, versionId, reference: `main:${number}`, domain: "main" };
}

/** 只需题目 ID 的既有调用方入口。 */
export async function createCodingProblemFixture(): Promise<string> {
  return (await createPublishedCodingProblem()).problemId;
}
