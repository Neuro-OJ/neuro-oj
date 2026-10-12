import { assertEquals } from "jsr:@std/assert@^1";
import { projectOiProgress } from "../../services/oi-progress.ts";
import {
  projectOiDetails,
  projectOiSelfTestDetails,
} from "../../services/submissions/oi-details.ts";

Deno.test("OI 进度只保留安全标识与分数，正式提交不暴露流输出", () => {
  const value = {
    sequence: 1,
    phase: "judging",
    total_cases: 2,
    active_cases: [{ case_id: "a_2", subtask_id: "a", input: "secret.in" }],
    completed_cases: [{
      case_id: "a_1",
      subtask_id: "a",
      status: "WA",
      score: 20,
      max_score: 50,
      stdout: "secret",
      stderr: "private",
      input: "hidden input",
    }],
  };
  const result = projectOiProgress(value)!;
  assertEquals(result.active_cases, [{ case_id: "a_2", subtask_id: "a" }]);
  assertEquals(result.completed_cases, [{
    case_id: "a_1",
    subtask_id: "a",
    status: "WA",
    score: 20,
    max_score: 50,
  }]);
  assertEquals(projectOiProgress({ ...value, sequence: -1 }), null);
  assertEquals(projectOiProgress({ ...value, total_cases: 101 }), null);
  assertEquals(
    projectOiProgress(value, true)!.completed_cases[0].stdout,
    "secret",
  );
});
Deno.test("OI 流输出仅在私有自测投影返回，保留分数与跳过原因", () => {
  const details = {
    verdict: "WA",
    subtasks: [{
      id: "a",
      score: 2000,
      cases: [{
        case_id: "a_1",
        status: "IGN",
        score: 0,
        max_score: 20,
        termination_reason: "dependency_failed",
        stdout: "output",
        stderr: "diagnostics",
        input: "secret",
      }],
    }],
  };
  const projected = projectOiDetails(details) as {
    subtasks: { cases: Record<string, unknown>[] }[];
  };
  assertEquals(projected.subtasks[0].cases[0].stdout, undefined);
  assertEquals(
    projected.subtasks[0].cases[0].termination_reason,
    "dependency_failed",
  );
  const self = projectOiSelfTestDetails(details) as {
    subtasks: { cases: Record<string, unknown>[] }[];
  };
  assertEquals(self.subtasks[0].cases[0].stdout, "output");
  assertEquals(self.subtasks[0].cases[0].stderr, "diagnostics");
  assertEquals(self.subtasks[0].cases[0].input, undefined);
});
