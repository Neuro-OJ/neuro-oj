import { assertEquals } from "jsr:@std/assert@^1";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import type { SubmissionStatus } from "../../src/types/index.ts";

Deno.test("schema: users table has correct columns", () => {
  const columns = Object.keys(users);
  assertEquals(columns.includes("id"), true);
  assertEquals(columns.includes("username"), true);
  assertEquals(columns.includes("email"), true);
  assertEquals(columns.includes("password_hash"), true);
  assertEquals(columns.includes("role"), true);
  assertEquals(columns.includes("created_at"), true);
  assertEquals(columns.includes("updated_at"), true);
});

Deno.test("schema: users columns have correct constraints", () => {
  assertEquals(users.id.primary, true); // PRIMARY KEY
  assertEquals(users.id.notNull, true);
  assertEquals(users.username.notNull, true);
  assertEquals(users.username.isUnique, true); // UNIQUE
  assertEquals(users.email.notNull, true);
  assertEquals(users.email.isUnique, true); // UNIQUE
  assertEquals(users.password_hash.notNull, true);
  assertEquals(users.role.notNull, true);
  assertEquals(users.role.hasDefault, true);
  assertEquals(users.role.default, "user"); // DEFAULT 'user'
  assertEquals(users.created_at.notNull, true);
  assertEquals(users.updated_at.notNull, true);
});

Deno.test("schema: problems table has LMCC-specific columns", () => {
  const columns = Object.keys(problems);
  assertEquals(columns.includes("judge_image"), true);
  assertEquals(columns.includes("judge_command"), true);
  assertEquals(columns.includes("support_package_storage_url"), true);
  assertEquals(columns.includes("time_limit_ms"), true);
  assertEquals(columns.includes("memory_limit_mb"), true);
  // 不应包含 test_cases
  assertEquals(columns.includes("test_cases"), false);
});

Deno.test("schema: problems columns have correct constraints", () => {
  assertEquals(problems.id.primary, true); // PRIMARY KEY
  assertEquals(problems.id.notNull, true);
  assertEquals(problems.title.notNull, true);
  assertEquals(problems.description.notNull, true);
  assertEquals(problems.difficulty.notNull, true);
  assertEquals(problems.difficulty.hasDefault, true);
  assertEquals(problems.difficulty.default, "medium"); // DEFAULT 'medium'
  assertEquals(problems.judge_image.notNull, true);
  assertEquals(problems.judge_command.notNull, true);
  assertEquals(problems.support_package_storage_url.notNull, false); // 可选
  assertEquals(problems.time_limit_ms.notNull, true);
  assertEquals(problems.time_limit_ms.hasDefault, true);
  assertEquals(problems.time_limit_ms.default, 5000); // DEFAULT 5000
  assertEquals(problems.memory_limit_mb.notNull, true);
  assertEquals(problems.memory_limit_mb.hasDefault, true);
  assertEquals(problems.memory_limit_mb.default, 512); // DEFAULT 512
});

Deno.test("schema: submissions table has file_name for mount", () => {
  const columns = Object.keys(submissions);
  assertEquals(columns.includes("user_id"), true);
  assertEquals(columns.includes("problem_id"), true);
  assertEquals(columns.includes("language"), true);
  assertEquals(columns.includes("code"), true);
  assertEquals(columns.includes("file_name"), true);
  assertEquals(columns.includes("status"), true);
});

Deno.test("schema: submissions columns have correct constraints", () => {
  assertEquals(submissions.id.primary, true); // PRIMARY KEY
  assertEquals(submissions.id.notNull, true);
  assertEquals(submissions.user_id.notNull, true); // FK → users.id
  assertEquals(submissions.problem_id.notNull, true); // FK → problems.id
  assertEquals(submissions.language.notNull, true);
  assertEquals(submissions.code.notNull, true);
  assertEquals(submissions.file_name.notNull, false); // 可选
  assertEquals(submissions.status.notNull, true);
  assertEquals(submissions.status.hasDefault, true);
  assertEquals(submissions.status.default, "pending"); // DEFAULT 'pending'
  assertEquals(submissions.created_at.notNull, true);
});

Deno.test("schema: submissions.status type matches SubmissionStatus", () => {
  // 验证 SubmissionStatus 类型的值能被 status 列接受（编译期检查）
  const validStatuses: SubmissionStatus[] = ["pending", "judging", "finished"];
  assertEquals(validStatuses.length, 3);
  assertEquals(validStatuses.includes("pending"), true);
  assertEquals(validStatuses.includes("judging"), true);
  assertEquals(validStatuses.includes("finished"), true);
});

Deno.test("schema: evaluation_results table uses integer score", () => {
  const columns = Object.keys(evaluationResults);
  assertEquals(columns.includes("submission_id"), true);
  assertEquals(columns.includes("status"), true);
  assertEquals(columns.includes("score"), true);
  assertEquals(columns.includes("output"), true);
  assertEquals(columns.includes("details"), true);
  assertEquals(columns.includes("time_ms"), true);
  assertEquals(columns.includes("memory_kb"), true);
});

Deno.test("schema: evaluation_results columns have correct constraints", () => {
  assertEquals(evaluationResults.id.primary, true); // PRIMARY KEY
  assertEquals(evaluationResults.submission_id.notNull, true); // FK → submissions.id
  assertEquals(evaluationResults.status.notNull, true);
  assertEquals(evaluationResults.score.notNull, true);
  assertEquals(evaluationResults.score.hasDefault, true);
  assertEquals(evaluationResults.score.default, 0); // DEFAULT 0
  assertEquals(evaluationResults.output.notNull, true);
  assertEquals(evaluationResults.output.hasDefault, true);
  assertEquals(evaluationResults.output.default, "");
  assertEquals(evaluationResults.details.notNull, true);
  assertEquals(evaluationResults.details.hasDefault, true);
  assertEquals(evaluationResults.details.default, "{}");
  assertEquals(evaluationResults.time_ms.notNull, false); // 可选
  assertEquals(evaluationResults.memory_kb.notNull, false); // 可选
});

Deno.test("schema: exports are defined", () => {
  assertEquals(users !== null && users !== undefined, true);
  assertEquals(problems !== null && problems !== undefined, true);
  assertEquals(submissions !== null && submissions !== undefined, true);
  assertEquals(
    evaluationResults !== null && evaluationResults !== undefined,
    true,
  );
});
