import { assertRejects } from "jsr:@std/assert@^1";
import {
  createSubmission,
  getSubmission,
} from "../../src/services/submissions.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `tst-pr-${ts}`;
const TEST_USER_ID = `tst-user-${ts}`;

Deno.test({
  name: "submissions service: 初始化测试题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: TEST_PROBLEM_ID,
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      created_at: now,
      updated_at: now,
    });
  },
});

Deno.test({
  name: "submissions service: 不支持的语言抛出 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: TEST_PROBLEM_ID,
          language: "brainfuck",
          code: "test code",
        }),
      BadRequestError,
      "不支持的语言",
    );
  },
});

Deno.test({
  name: "submissions service: 不存在的题目抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: "nonexistent-id",
          language: "python3",
          code: "print('hello')",
        }),
      NotFoundError,
      "题目不存在",
    );
  },
});

Deno.test({
  name: "submissions service: getSubmission 不存在的提交抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => getSubmission("nonexistent-id", TEST_USER_ID),
      NotFoundError,
      "提交不存在",
    );
  },
});
