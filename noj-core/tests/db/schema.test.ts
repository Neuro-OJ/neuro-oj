import { assertEquals } from "jsr:@std/assert@^1";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";

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

Deno.test("schema: problems table has LMCC-specific columns", () => {
  const columns = Object.keys(problems);
  assertEquals(columns.includes("judge_image"), true);
  assertEquals(columns.includes("judge_command"), true);
  assertEquals(columns.includes("support_package_path"), true);
  assertEquals(columns.includes("time_limit_ms"), true);
  assertEquals(columns.includes("memory_limit_mb"), true);
  // 不应包含 test_cases
  assertEquals(columns.includes("test_cases"), false);
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

Deno.test("schema: exports are defined", () => {
  assertEquals(users !== null && users !== undefined, true);
  assertEquals(problems !== null && problems !== undefined, true);
  assertEquals(submissions !== null && submissions !== undefined, true);
  assertEquals(
    evaluationResults !== null && evaluationResults !== undefined,
    true,
  );
});
