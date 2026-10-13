/** 通过真实题包导入与发布建立独立公开加法题，避免共用赛题污染练习回归。 */
import { assertEquals } from "jsr:@std/assert@1";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { BASE_URL, getAdminToken, publishProblemVersion } from "../helper.ts";

export async function createCodingProblemFixture(): Promise<string> {
  const token = await getAdminToken();
  const archive = zipSync({
    "problem.json": strToU8(JSON.stringify({
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
    })),
    "statement.md": strToU8("solve(input_str) 接收两个整数并返回它们的和。"),
    "evaluate.py": strToU8(`from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    if runner.call("solve", "1 2") == "3":
        result.accept(score=10)
    else:
        result.wrong_answer(score=0)
finally:
    runner.close()
`),
  });
  const body = new FormData();
  body.set("file", new Blob([archive.buffer as ArrayBuffer]), "fixture.zip");
  const response = await fetch(
    `${BASE_URL}/api/v1/domains/main/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    },
  );
  const imported = await response.json();
  assertEquals(response.status, 201, JSON.stringify(imported));
  const problemId = imported.data.problem_id as string;
  await publishProblemVersion(token, problemId, "独立练习回归夹具");
  return problemId;
}
