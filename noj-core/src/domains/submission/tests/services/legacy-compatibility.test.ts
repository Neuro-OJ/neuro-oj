import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import * as legacySubmission from "../../index.ts";

Deno.test("legacy submission domain 保留迁移期兼容门面", () => {
  assertExists(legacySubmission.createSubmission);
  assertExists(legacySubmission.saveEvaluationResult);
  assertExists(legacySubmission.JUDGE_QUEUES);
  assertEquals(typeof legacySubmission.createSubmission, "function");
  assertEquals(typeof legacySubmission.saveEvaluationResult, "function");
});
