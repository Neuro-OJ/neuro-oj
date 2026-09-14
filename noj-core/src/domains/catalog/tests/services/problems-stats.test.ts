import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  _resetProblemStatsCacheForTest,
  getProblemStatsDetail,
  getPublicProblemStats,
  median,
} from "../../index.ts";

await resetDbForTest();

async function seedProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `统计测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedSubmission(
  problemId: string,
  userId: string,
  score: number,
  details: unknown,
): Promise<void> {
  const submissionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    language: "python3",
    code: "print(1)",
    status: "finished",
    created_at: now,
  });
  await getDb().insert(evaluationResults).values({
    id: crypto.randomUUID(),
    submission_id: submissionId,
    status: "finished",
    score,
    output: "",
    details: JSON.stringify(details),
    created_at: now,
  });
}

async function cleanup(problemId: string, userIds: string[]): Promise<void> {
  const rows = await getDb()
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.problem_id, problemId));
  for (const row of rows) {
    await getDb().delete(evaluationResults)
      .where(eq(evaluationResults.submission_id, row.id))
      .catch(() => {});
  }
  await getDb().delete(submissions).where(
    eq(submissions.problem_id, problemId),
  );
  await getDb().delete(problems).where(eq(problems.id, problemId));
  for (const id of userIds) {
    await getDb().delete(users).where(eq(users.id, id)).catch(() => {});
  }
}

Deno.test({
  name: "problems-stats: 通过率与聚合，隐藏用例匿名化且真实 id 绝不外泄",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940001);
    const alice = await seedUser("ps-alice");
    const bob = await seedUser("ps-bob");
    try {
      await seedSubmission(problemId, alice, 10000, {
        cases: [
          { case_id: "case-01", status: "Accepted", hidden: false },
          { case_id: "secret-01", status: "WrongAnswer", hidden: true },
        ],
      });
      await seedSubmission(problemId, bob, 0, {
        cases: [
          { case_id: "case-01", status: "WrongAnswer", hidden: false },
          { case_id: "secret-01", status: "WrongAnswer", hidden: true },
        ],
      });

      const publicStats = await getPublicProblemStats(problemId);
      assertEquals(publicStats.submit_count, 2);
      assertEquals(publicStats.accepted_count, 1);
      assertEquals(publicStats.acceptance_rate, 0.5);
      assertEquals(publicStats.suppressed_reason, null);

      const detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.sample_size, 2);
      assertEquals(detail.truncated, false);
      // 可见用例出真实 id
      assertEquals(
        detail.case_failure_distribution.some((c) =>
          c.case_id === "case-01" && !c.hidden
        ),
        true,
      );
      // 隐藏用例只进匿名桶
      assertEquals(
        detail.case_failure_distribution.some((c) => c.hidden),
        true,
      );
      // 关键不变量：真实隐藏用例 id 绝不出现
      assertEquals(
        JSON.stringify(detail.case_failure_distribution).includes("secret-01"),
        false,
      );
    } finally {
      await cleanup(problemId, [alice, bob]);
    }
  },
});

Deno.test({
  name: "problems-stats: 空题目返回 0 与 null 而非报错",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940002);
    try {
      const detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.first_ac_median_ms, null);
      assertEquals(detail.accepted_count, 0);
      assertEquals(detail.acceptance_rate, 0);
      assertEquals(detail.sample_size, 0);
      assertEquals(detail.case_failure_distribution, []);
      assertEquals(detail.attempt_count, 0);
    } finally {
      await cleanup(problemId, []);
    }
  },
});

Deno.test({
  name: "problems-stats: 尝试人数按用户去重，首次 AC 取最早一次",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940003);
    const alice = await seedUser("ps-alice2");
    try {
      // 同一用户三次提交：0 → 0 → 满分；尝试人数应为 1
      await seedSubmission(problemId, alice, 0, { cases: [] });
      await seedSubmission(problemId, alice, 0, { cases: [] });
      await seedSubmission(problemId, alice, 10000, { cases: [] });
      const detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.attempt_count, 1);
      assertEquals(detail.submit_count, 3);
      assertEquals(detail.accepted_count, 1);
    } finally {
      await cleanup(problemId, [alice]);
    }
  },
});

Deno.test({
  name: "problems-stats: 中位数计算覆盖奇数、偶数与空集",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    assertEquals(median([]), null);
    assertEquals(median([5]), 5);
    assertEquals(median([1, 3, 5]), 3);
    // 偶数个取中间两数均值
    assertEquals(median([1, 2, 3, 4]), 3);
    assertEquals(median([10, 20]), 15);
    // 输入不应被就地修改（避免调用方的样本被排序破坏）
    const input = [3, 1, 2];
    median(input);
    assertEquals(input, [3, 1, 2]);
  },
});

Deno.test({
  name: "problems-stats: details 为非法 JSON 时跳过而不抛错",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940004);
    const alice = await seedUser("ps-alice3");
    try {
      const submissionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await getDb().insert(submissions).values({
        id: submissionId,
        user_id: alice,
        problem_id: problemId,
        language: "python3",
        code: "x",
        status: "finished",
        created_at: now,
      });
      await getDb().insert(evaluationResults).values({
        id: crypto.randomUUID(),
        submission_id: submissionId,
        status: "finished",
        score: 0,
        output: "",
        details: "{ 不是合法 JSON",
        created_at: now,
      });

      const detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.sample_size, 1);
      assertEquals(detail.case_failure_distribution, []);
    } finally {
      await cleanup(problemId, [alice]);
    }
  },
});

Deno.test({
  name:
    "problems-stats: 隐藏用例的真实 id 恰好形如 hidden-N 时仍不与匿名桶混淆",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940005);
    const alice = await seedUser("ps-alice4");
    try {
      // 出题人把隐藏用例命名为 hidden-1（与匿名别名形状相同），
      // 且另有可见用例也叫 hidden-1 —— 返回中不得出现任何可反推真实命名的信息
      await seedSubmission(problemId, alice, 0, {
        cases: [
          { case_id: "hidden-1", status: "WrongAnswer", hidden: true },
          { case_id: "real-case", status: "WrongAnswer", hidden: false },
        ],
      });
      const detail = await getProblemStatsDetail(problemId);
      const hiddenEntries = detail.case_failure_distribution.filter((c) =>
        c.hidden
      );
      const visibleEntries = detail.case_failure_distribution.filter((c) =>
        !c.hidden
      );
      // 隐藏桶与可见用例分别计数，互不污染
      assertEquals(hiddenEntries.length, 1);
      assertEquals(visibleEntries.length, 1);
      assertEquals(visibleEntries[0]?.case_id, "real-case");
      assertEquals(visibleEntries[0]?.failed, 1);
      assertEquals(hiddenEntries[0]?.failed, 1);
    } finally {
      await cleanup(problemId, [alice]);
    }
  },
});
