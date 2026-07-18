import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import {
  getGlobalRankings,
  getMyRanking,
  refreshRankingsView,
} from "../../src/services/rankings.ts";
import { hashPassword } from "../../src/lib/password.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = true && // DATABASE_URL 未设置时 PGlite 可用
  !!Deno.env.get("JWT_SECRET");

/**
 * 创建测试用户，返回 user_id。
 */
async function createTestUser(
  usernamePrefix: string,
  createdAt?: string,
): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const now = createdAt ?? new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `${usernamePrefix}_${unique}`,
    email: `${usernamePrefix}_${unique}@test.com`,
    password_hash: await hashPassword("TestRankingsPass1"),
    role: "user",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/**
 * 为指定用户创建一条提交并附带评测结果。
 */
async function createSubmission(
  userId: string,
  problemId: string,
  resultStatus: "Accepted" | "WrongAnswer" | "TimeLimitExceeded",
): Promise<void> {
  const db = getDb();
  const submissionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    language: "python3",
    code: "print(1)",
    file_name: "main.py",
    status: "finished",
    created_at: now,
  });
  await db.insert(evaluationResults).values({
    id: crypto.randomUUID(),
    submission_id: submissionId,
    status: resultStatus,
    score: resultStatus === "Accepted" ? 10000 : 0,
    output: "",
    details: "{}",
    created_at: now,
  });
}

/**
 * 创建测试题目，返回 problem_id。
 */
async function createTestProblem(problemNumber: number): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `rankings_test_${problemNumber}_${Date.now()}`,
    description: "test",
    difficulty: "easy",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    number: problemNumber,
    owner_id: "0",
    type: "P",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/**
 * 清理测试用户的提交 + 评测结果 + 用户记录。
 */
async function cleanupUser(userId: string): Promise<void> {
  const db = getDb();
  // 先删除 evaluation_results（FK → submissions）
  const userSubs = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.user_id, userId));
  for (const sub of userSubs) {
    await db.delete(evaluationResults).where(
      eq(evaluationResults.submission_id, sub.id),
    );
  }
  await db.delete(submissions).where(eq(submissions.user_id, userId));
  await db.delete(users).where(eq(users.id, userId));
}

/**
 * 清理测试题目。
 */
async function cleanupProblem(problemId: string): Promise<void> {
  const db = getDb();
  // 先删除关联的 submissions + evaluation_results
  const problemSubs = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.problem_id, problemId));
  for (const sub of problemSubs) {
    await db.delete(evaluationResults).where(
      eq(evaluationResults.submission_id, sub.id),
    );
  }
  await db.delete(submissions).where(eq(submissions.problem_id, problemId));
  await db.delete(problems).where(eq(problems.id, problemId));
}

Deno.test({
  name: "rankings: getGlobalRankings 仅展示有通过记录的用户",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser("rankings_a");
    const userB = await createTestUser("rankings_b");
    const userC = await createTestUser("rankings_c"); // 无通过记录
    const problem1 = await createTestProblem(900001);
    const problem2 = await createTestProblem(900002);
    const problem3 = await createTestProblem(900003);

    try {
      // A: 2 solved, 3 total
      await createSubmission(userA, problem1, "Accepted");
      await createSubmission(userA, problem2, "Accepted");
      await createSubmission(userA, problem3, "WrongAnswer");
      // B: 1 solved, 1 total
      await createSubmission(userB, problem1, "Accepted");
      // C: 0 solved (全部 WA)，不应上榜
      await createSubmission(userC, problem1, "WrongAnswer");
      await createSubmission(userC, problem2, "TimeLimitExceeded");

      await refreshRankingsView();
      const result = await getGlobalRankings({ page: 1, limit: 100 });
      const aRow = result.data.find((r) => r.user_id === userA);
      const bRow = result.data.find((r) => r.user_id === userB);
      const cRow = result.data.find((r) => r.user_id === userC);

      assertEquals(cRow, undefined, "C 不应在榜单中（无通过记录）");
      assertExists(aRow);
      assertExists(bRow);
      assertEquals(aRow!.solved_count, 2);
      assertEquals(aRow!.total_submissions, 3);
      // acceptance_rate = 2/3 ≈ 0.667（保留 3 位小数）
      assertEquals(aRow!.acceptance_rate, 0.667);
      assertEquals(bRow!.solved_count, 1);
      assertEquals(bRow!.total_submissions, 1);
      assertEquals(bRow!.acceptance_rate, 1.0);
      // A solved_count=2 > B solved_count=1 → A.rank < B.rank
      assertEquals(aRow!.rank < bRow!.rank, true);
    } finally {
      await cleanupUser(userA);
      await cleanupUser(userB);
      await cleanupUser(userC);
      await cleanupProblem(problem1);
      await cleanupProblem(problem2);
      await cleanupProblem(problem3);
    }
  },
});

Deno.test({
  name: "rankings: 排序稳定——solved 相同按 acceptance_rate 降序",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userD = await createTestUser("rankings_d");
    const userE = await createTestUser("rankings_e");
    const problem1 = await createTestProblem(900010);
    const problem2 = await createTestProblem(900011);

    try {
      // D: solved=1, total=2, rate=0.5（高效率）
      await createSubmission(userD, problem1, "Accepted");
      await createSubmission(userD, problem2, "WrongAnswer");
      // E: solved=1, total=4, rate=0.25（低效率）
      await createSubmission(userE, problem1, "Accepted");
      await createSubmission(userE, problem1, "WrongAnswer");
      await createSubmission(userE, problem2, "WrongAnswer");
      await createSubmission(userE, problem2, "TimeLimitExceeded");

      await refreshRankingsView();
      const result = await getGlobalRankings({ page: 1, limit: 100 });
      const dRow = result.data.find((r) => r.user_id === userD);
      const eRow = result.data.find((r) => r.user_id === userE);

      assertExists(dRow);
      assertExists(eRow);
      // D rate=0.5 > E rate=0.25 → D.rank < E.rank
      assertEquals(dRow!.rank < eRow!.rank, true);
      assertEquals(dRow!.acceptance_rate, 0.5);
      assertEquals(eRow!.acceptance_rate, 0.25);
    } finally {
      await cleanupUser(userD);
      await cleanupUser(userE);
      await cleanupProblem(problem1);
      await cleanupProblem(problem2);
    }
  },
});

Deno.test({
  name: "rankings: 排除 root 用户（id='0'）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 不创建 root 用户的提交（root 已由 00_migrate_test 创建）
    await refreshRankingsView();
    const result = await getGlobalRankings({ page: 1, limit: 100 });
    const rootRow = result.data.find((r) => r.user_id === "0");
    assertEquals(rootRow, undefined, "root 用户不应出现在榜单中");
  },
});

Deno.test({
  name: "rankings: getMyRanking——已上榜用户返回正确 rank",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userF = await createTestUser("rankings_f");
    const problem1 = await createTestProblem(900020);

    try {
      await createSubmission(userF, problem1, "Accepted");
      await refreshRankingsView();
      const result = await getMyRanking(userF);
      assertExists(result);
      assertEquals(result!.user_id, userF);
      assertEquals(result!.solved_count, 1);
      assertEquals(result!.acceptance_rate, 1.0);
      assertEquals(typeof result!.rank, "number");
      assertEquals(result!.rank >= 1, true);
    } finally {
      await cleanupUser(userF);
      await cleanupProblem(problem1);
    }
  },
});

Deno.test({
  name: "rankings: getMyRanking——未上榜用户返回 null",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userG = await createTestUser("rankings_g");
    const problem1 = await createTestProblem(900030);

    try {
      // 仅 WA，无 Accepted
      await createSubmission(userG, problem1, "WrongAnswer");
      await refreshRankingsView();
      const result = await getMyRanking(userG);
      assertEquals(result, null);
    } finally {
      await cleanupUser(userG);
      await cleanupProblem(problem1);
    }
  },
});

Deno.test({
  name: "rankings: 分页——page=2 返回正确切片",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userH = await createTestUser("rankings_h");
    const problem1 = await createTestProblem(900040);

    try {
      await createSubmission(userH, problem1, "Accepted");
      await refreshRankingsView();
      const page1 = await getGlobalRankings({ page: 1, limit: 50 });
      const page2 = await getGlobalRankings({ page: 2, limit: 50 });

      // page1 含 userH，page2 仍可能含 userH（如果 global rank ≤ 50）
      // 主要验证：两次返回的总条目数相同，分页不重复
      const total = page1.total;
      assertEquals(page2.total, total);

      const hInP1 = page1.data.find((r) => r.user_id === userH);
      const hInP2 = page2.data.find((r) => r.user_id === userH);
      // userH 不应同时出现在两页
      if (hInP1 && hInP2) {
        throw new Error("分页不应重复返回同一行");
      }
    } finally {
      await cleanupUser(userH);
      await cleanupProblem(problem1);
    }
  },
});

Deno.test({
  name: "rankings: limit 上限——超过 100 被截断为 100",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await refreshRankingsView();
    const result = await getGlobalRankings({ page: 1, limit: 500 });
    // 验证 limit=500 调用不抛错（service 层内部截断到 100）
    assertEquals(result.data.length <= 100, true);
  },
});
